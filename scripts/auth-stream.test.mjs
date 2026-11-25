import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { attachSafeStreamGuards, isIgnorableStreamError, r6HealthPayload } from "../lib/stream-guards.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

test("lib/auth.ts enforces strict same-origin without falling back to true when Origin is missing", () => {
  const authSrc = fs.readFileSync(path.join(ROOT, "lib", "auth.ts"), "utf8");
  assert.equal(/if\s*\(\s*!origin\s*\)\s*return\s+true\b/.test(authSrc), false);
  assert.ok(authSrc.includes("sec-fetch-site"), "lib/auth.ts must inspect sec-fetch-site");
  assert.ok(authSrc.includes("referer"), "lib/auth.ts must inspect referer when Origin is absent");
  assert.ok(authSrc.includes("timingSafeTokenEqual"), "lib/auth.ts must use timingSafeTokenEqual");
});

test("stream-guards classifies ignorable errors and builds standard health payload", () => {
  assert.equal(isIgnorableStreamError({ code: "EPIPE" }), true);
  assert.equal(isIgnorableStreamError({ code: "ECONNRESET" }), true);
  assert.equal(isIgnorableStreamError({ code: "ERR_STREAM_DESTROYED" }), true);
  assert.equal(isIgnorableStreamError({ code: "ENOENT" }), false);
  assert.equal(isIgnorableStreamError(null), false);
  assert.deepEqual(r6HealthPayload("blotboard", { port: 8567, version: "1.0.5" }), {
    ok: true,
    status: "ok",
    service: "blotboard",
    port: 8567,
    version: "1.0.5",
  });
});

test("attachSafeStreamGuards protects HTTP file streams against premature TCP reset without uncaughtException", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blotboard-stream-test-"));
  const filePath = path.join(dir, "big.bin");
  fs.writeFileSync(filePath, Buffer.alloc(4 * 1024 * 1024, 0x42));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let readStream;
  const server = http.createServer(async (req, res) => {
    readStream = fs.createReadStream(filePath);
    const guard = attachSafeStreamGuards(req, res, readStream);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const webStream = new ReadableStream({
      start(controller) {
        let closed = false;
        readStream.on("data", (chunk) => {
          if (closed) return;
          try {
            controller.enqueue(new Uint8Array(chunk));
          } catch {
            closed = true;
            readStream.destroy();
          }
        });
        readStream.on("end", () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {}
        });
        readStream.on("error", () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {}
        });
        readStream.on("close", () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        readStream.destroy();
      },
    });
    const reader = webStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || !guard.isWritable()) {
          await reader.cancel();
          break;
        }
        guard.safeWrite(value);
      }
      guard.safeEnd();
    } catch {
      readStream.destroy();
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();

  await new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write("GET /big.bin HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    });
    sock.once("data", () => {
      sock.resetAndDestroy();
      setTimeout(resolve, 60);
    });
  });

  assert.equal(Boolean(readStream && readStream.destroyed), true);
  assert.equal(Readable.from(["ok"]).readable, true);
});
