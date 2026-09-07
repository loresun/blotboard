import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoProductionServers, claimBuild, claimProductionServer } from "./build-guard.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blotboard-build-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("running production refuses builds without touching the old assets", (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, ".next"));
  fs.writeFileSync(path.join(root, ".next/BUILD_ID"), "old-build");
  const release = claimProductionServer(root);
  assert.throws(() => claimBuild(root), /拒绝覆盖运行中的生产构建/);
  assert.equal(fs.readFileSync(path.join(root, ".next/BUILD_ID"), "utf8"), "old-build");
  assert.equal(fs.existsSync(path.join(root, ".blotboard-runtime/build.json")), false);
  release();
  claimBuild(root)();
});

test("building refuses server startup and concurrent builds; isolated checkout is unaffected", (t) => {
  const root = workspace(t);
  const other = workspace(t);
  const release = claimBuild(root);
  assert.throws(() => claimProductionServer(root), /生产构建尚未完成/);
  assert.throws(() => claimBuild(root), /正在构建或运行/);
  claimProductionServer(other)();
  release();
  claimProductionServer(root)();
});

test("unknown or incomplete lock fails closed instead of deleting an active reservation", (t) => {
  const root = workspace(t);
  const dir = path.join(root, ".blotboard-runtime");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "build.json"), "");
  assert.throws(() => claimBuild(root), /尚未就绪或已损坏/);
  assert.equal(fs.readFileSync(path.join(dir, "build.json"), "utf8"), "");
});

test("dead owner markers are ignored without deleting paths owned by other processes", (t) => {
  const root = workspace(t);
  const dir = path.join(root, ".blotboard-runtime");
  fs.mkdirSync(dir);
  // PID 2147483647 cannot identify a process on the supported macOS/Linux hosts.
  fs.writeFileSync(path.join(dir, "server-2147483647.json"), JSON.stringify({ pid: 2147483647 }));
  assertNoProductionServers(root);
  assert.equal(fs.existsSync(path.join(dir, "server-2147483647.json")), true);
  claimBuild(root)();
  const release = claimProductionServer(root);
  assert.throws(() => assertNoProductionServers(root), /拒绝覆盖/);
  release();
});
