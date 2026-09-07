import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { checkWebAssets } from "./check-web-assets.mjs";

test("detects stale chunks even when health and homepage both return 200", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/") return res.end('<link href="/_next/static/chunks/gone.css"/><script src="/_next/static/chunks/main.js"></script>');
    res.setHeader("content-type", req.url.endsWith(".js") ? "application/javascript" : "text/plain");
    res.statusCode = req.url.endsWith(".js") ? 200 : 500;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await checkWebAssets(`http://127.0.0.1:${server.address().port}`);
  assert.equal(result.pageStatus, 200);
  assert.equal(result.ok, false);
  assert.deepEqual(result.assets.map((asset) => asset.ok), [false, true]);
});

test("accepts correct JS/CSS types and does not follow external page references", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/") return res.end('<script src="/_next/static/chunks/main.js"></script><link href="/_next/static/chunks/main.css"/><script src="https://example.com/secret.js"></script>');
    res.setHeader("content-type", req.url.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/css");
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await checkWebAssets(`http://127.0.0.1:${server.address().port}`);
  assert.equal(result.ok, true);
  assert.equal(seen.length, 3);
});
