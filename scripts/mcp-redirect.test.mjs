import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP write token never follows a redirect to a different origin", async (t) => {
  let targetRequests = 0;
  const target = http.createServer((_req, res) => { targetRequests++; res.end("{}"); });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const source = http.createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/destination` });
    res.end();
  });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const server of [source, target]) { server.closeAllConnections(); server.close(); } });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "bin/blotboard.mjs"), "mcp"],
    env: { PATH: process.env.PATH || "", BLOTBOARD_URL: `http://127.0.0.1:${source.address().port}`, BLOTBOARD_TOKEN: "test-secret" },
    stderr: "pipe",
  });
  const client = new Client({ name: "redirect-regression", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({ name: "board_create", arguments: { name: "Redirect test" } });
  assert.equal(result.isError, true);
  assert.equal(targetRequests, 0);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});
