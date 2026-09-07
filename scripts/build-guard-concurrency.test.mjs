import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const guardUrl = new URL("./build-guard.mjs", import.meta.url).href;
const contenderScript = `
  const [root, kind, guardUrl] = process.argv.slice(1);
  const guard = await import(guardUrl);
  let held = null;
  process.on('message', (message) => {
    if (message.type === 'stop') return process.exit(0);
    if (message.type === 'release') {
      const end = process.hrtime.bigint().toString();
      held.release();
      process.send({ type: 'released', round: message.round, start: held.start, end });
      held = null;
      return;
    }
    if (message.type !== 'attempt') return;
    let release;
    try {
      release = kind === 'build' ? guard.claimBuild(root) : guard.claimProductionServer(root);
    } catch (error) {
      process.send({ type: 'result', round: message.round, acquired: false, reason: error.message });
      return;
    }
    // Keep ownership until every peer has attempted, rather than trusting timer timing.
    held = { release, start: process.hrtime.bigint().toString() };
    process.send({ type: 'result', round: message.round, acquired: true });
  });
  process.send({ type: 'ready' });
`;

async function contender(root, kind, id) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", contenderScript, root, kind, guardUrl], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-4000); });
  let pending;
  let exited = false;
  const ready = new Promise((resolve, reject) => {
    pending = { type: "ready", resolve, reject };
  });
  child.on("message", (message) => {
    if (pending && pending.type === message.type && (message.type === "ready" || pending.round === message.round)) {
      const waiter = pending;
      pending = null;
      waiter.resolve({ ...message, kind, id });
    }
  });
  child.on("error", (error) => { pending?.reject(error); pending = null; });
  const closed = new Promise((resolve) => child.on("exit", (code, signal) => {
    exited = true;
    pending?.reject(new Error(`contender exited ${code ?? signal}: ${diagnostic}`));
    pending = null;
    resolve();
  }));
  await ready;
  return {
    attempt(round) {
      assert.equal(pending, null);
      return new Promise((resolve, reject) => {
        pending = { type: "result", round, resolve, reject };
        child.send({ type: "attempt", round });
      });
    },
    release(round) {
      assert.equal(pending, null);
      return new Promise((resolve, reject) => {
        pending = { type: "released", round, resolve, reject };
        child.send({ type: "release", round });
      });
    },
    async stop() {
      if (!exited) child.kill("SIGTERM");
      await closed;
    },
  };
}

function assertExclusive(intervals) {
  for (let i = 0; i < intervals.length; i++) {
    const first = intervals[i];
    assert.ok(BigInt(first.end) >= BigInt(first.start));
    for (let j = i + 1; j < intervals.length; j++) {
      const second = intervals[j];
      // Multiple production readers are intentional (e.g. isolated data directories
      // using the same build). Only a build excludes every other live owner.
      if (first.kind !== "build" && second.kind !== "build") continue;
      const overlap = BigInt(first.start) < BigInt(second.end) && BigInt(second.start) < BigInt(first.end);
      assert.equal(overlap, false, `ownership overlap: ${first.kind} #${first.id}/${first.round} and ${second.kind} #${second.id}/${second.round}`);
    }
  }
}

async function compete(t, kinds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blotboard-guard-concurrency-"));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map((child) => child.stop()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [id, kind] of kinds.entries()) children.push(await contender(root, kind, id));
  const intervals = [];
  // Uncontended progress is deterministic; the stress phase may fairly reject both
  // starters, so it must not require any particular OS scheduling winner.
  for (const kind of new Set(kinds)) {
    const child = children[kinds.indexOf(kind)];
    const outcome = await child.attempt(`warmup-${kind}`);
    assert.equal(outcome.acquired, true);
    intervals.push(await child.release(`warmup-${kind}`));
  }
  let denied = 0;
  for (let round = 0; round < 16; round++) {
    // Rotate dispatch order so both roles can acquire, without assuming scheduler fairness.
    const order = [...children.slice(round % children.length), ...children.slice(0, round % children.length)];
    const outcomes = await Promise.all(order.map((child) => child.attempt(round)));
    for (const outcome of outcomes) {
      if (outcome.acquired) intervals.push(await children[outcome.id].release(round));
      else {
        denied++;
        assert.match(outcome.reason, /构建|工作区|生产/, "rejection must come from the coordinator");
      }
    }
  }
  assert.ok(intervals.length > 0, "at least one contender must make progress");
  assert.ok(denied > 0, "the test must exercise actual contention");
  assertExclusive(intervals);
  return intervals;
}

test("independent build processes never hold overlapping reservations", { timeout: 15000 }, async (t) => {
  await compete(t, ["build", "build", "build", "build"]);
});

test("build and production processes never hold overlapping write/read reservations", { timeout: 15000 }, async (t) => {
  const intervals = await compete(t, ["build", "server", "server", "build", "server", "server"]);
  assert.ok(intervals.some((entry) => entry.kind === "build"), "exercise acquired build ownership");
  assert.ok(intervals.some((entry) => entry.kind === "server"), "exercise acquired production ownership");
});
