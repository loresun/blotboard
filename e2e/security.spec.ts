import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Board, TableField } from "../lib/types";

// These regressions exercise real stores in a unique worker-local directory. They never
// change the integration-test servers' data or any developer deployment settings.
let root: string;
let storage: typeof import("../lib/storage");
let settings: typeof import("../lib/runner-settings");
let http: typeof import("../lib/http");
const savedEnv = { ...process.env };

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "blotboard-security-"));
  Object.assign(process.env, {
    BLOTBOARD_DATA_DIR: root,
    BLOTBOARD_DATA_FILE: path.join(root, "boards.json"),
    BLOTBOARD_UPLOADS_DIR: path.join(root, "uploads"),
    BLOTBOARD_RUNNER_SETTINGS_FILE: path.join(root, "runner-settings.json"),
    BLOTBOARD_ISSUES_FILE: path.join(root, "issues.json"),
    BLOTBOARD_RUNS_DIR: path.join(root, "runs"),
    BLOTBOARD_GOAL_AGENT_SETTINGS: "",
    BLOTBOARD_INTERNAL_TOKEN: "security-test-token",
  });
  storage = await import("../lib/storage");
  settings = await import("../lib/runner-settings");
  http = await import("../lib/http");
});

test.afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

test("rejected ACP configuration leaves the effective configuration and disk unchanged", () => {
  settings.patchRunnerSettings({ agents: [{ id: "original", command: "test-agent", env: { TEST_KEY: "test-secret" } }], defaultAgentId: "original" });
  const previous = structuredClone(settings.loadRunnerSettings());
  const disk = fs.readFileSync(path.join(root, "runner-settings.json"), "utf8");
  expect(() => settings.patchRunnerSettings({ agents: [], permissionMode: "invalid" })).toThrow();
  expect(settings.loadRunnerSettings()).toEqual(previous);
  expect(() => settings.patchRunnerSettings({ agents: [], defaultAgentId: "missing" })).toThrow();
  expect(settings.loadRunnerSettings()).toEqual(previous);
  expect(fs.readFileSync(path.join(root, "runner-settings.json"), "utf8")).toBe(disk);
});

test("disk failure rolls back ACP configuration instead of changing permission policy in memory", () => {
  settings.patchRunnerSettings({ agents: [{ id: "disk-fixture", command: "test-agent" }], permissionMode: "ask" });
  const previous = structuredClone(settings.loadRunnerSettings());
  const rename = fs.renameSync;
  fs.renameSync = (() => { throw new Error("simulated disk failure"); }) as typeof fs.renameSync;
  try {
    expect(() => settings.patchRunnerSettings({ permissionMode: "auto" })).toThrow("simulated disk failure");
  } finally {
    fs.renameSync = rename;
  }
  expect(settings.loadRunnerSettings()).toEqual(previous);
});

test("disk failure rolls back the board cache and later unrelated edits do not persist the failed edit", () => {
  storage.insertBoard(() => ({ id: "b_security", name: "saved", cards: [], edges: [], comments: [], createdAt: 1, updatedAt: 1 } as unknown as Board));
  const before = fs.readFileSync(path.join(root, "boards", "b_security.json"), "utf8");
  const rename = fs.renameSync;
  fs.renameSync = (() => { throw new Error("simulated disk failure"); }) as typeof fs.renameSync;
  try {
    expect(() => storage.mutateBoard("b_security", (board) => { board.name = "unsaved"; })).toThrow("simulated disk failure");
  } finally {
    fs.renameSync = rename;
  }
  expect(storage.requireBoard("b_security").name).toBe("saved");
  expect(fs.readFileSync(path.join(root, "boards", "b_security.json"), "utf8")).toBe(before);
  storage.mutateBoard("b_security", (board) => { board.updatedAt = 2; });
  expect(JSON.parse(fs.readFileSync(path.join(root, "boards", "b_security.json"), "utf8")).name).toBe("saved");
});

test("unexpected API errors expose neither private paths nor secret fragments in responses or logs", async () => {
  const logs: unknown[][] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const result = http.fail(new Error("Unexpected token in /private/example/settings.json: test-secret-fragment"));
    expect(result.status).toBe(500);
    const content = await result.text();
    expect(content).not.toContain("/private/example");
    expect(content).not.toContain("test-secret-fragment");
    expect(JSON.stringify(logs)).not.toContain("test-secret-fragment");
    expect(await http.fail(http.badRequest("请提供画板 id")).json()).toEqual({ ok: false, error: "请提供画板 id" });
  } finally {
    console.error = log;
  }
});

test("table exports reject attribute injection even for preserved unnormalized legacy cards", async () => {
  const { renderTableHtml } = await import("../cards/table/export");
  const attack = 'left"><img src=x onerror="globalThis.securityMarker=1"><th style="text-align:left';
  const table = { columns: [{ key: "x", label: "Safe heading", align: attack }], rows: [{ x: "Cell" }] } as unknown as TableField;
  const output = renderTableHtml(table);
  expect(output).not.toContain("onerror");
  expect(output).not.toContain("<img");
  expect(output).toContain("Safe heading");
  expect(renderTableHtml({ ...table, columns: [{ key: "x", label: "Right", align: "right" }] })).toContain('style="text-align:right"');
  // Render-time defense must not rewrite the preserved input.
  expect(table.columns[0].align).toBe(attack);
});

test("ACP startup metadata and crash diagnostics do not publish command arguments, cwd or stderr secrets", async () => {
  const issues = await import("../lib/issue-store");
  const { startAcpRun } = await import("../lib/acp/manager");
  const { readTranscript } = await import("../lib/acp/transcript");
  const script = path.join(root, "crashing-agent.mjs");
  fs.writeFileSync(script, 'process.stderr.write(process.env.TEST_SECRET); setTimeout(() => process.exit(2), 30);');
  const issue = issues.createIssue({ title: "Security regression", description: "isolated fixture" });
  const run = startAcpRun({ issueId: issue.id, agent: { id: "security-agent", name: "Test agent", command: process.execPath, args: [script, "test-secret-argument"], cwd: root, env: { TEST_SECRET: "test-secret-stderr" } }, permissionMode: "ask", mode: "analyze", prompt: () => "Test" });
  await expect.poll(() => issues.findRun(run.id)?.run.status).toBe("failed");
  const publicData = JSON.stringify({ run: issues.findRun(run.id)?.run, transcript: readTranscript(run.id) });
  expect(publicData).not.toContain("test-secret-stderr");
  expect(publicData).not.toContain("test-secret-argument");
  expect(publicData).not.toContain(root);
});

test("upload identifiers reject traversal and only byte-verified images can be previewed", async () => {
  const { resolveUploadFile, readControlledImage, storeUploadStream } = await import("../lib/uploads");
  expect(() => resolveUploadFile("../token")).toThrow();
  expect(() => resolveUploadFile("web-1234567890123-abcdefabcdef.png/../../token")).toThrow();
  await expect(storeUploadStream("test.png", "image/png", new Blob(["<script>malicious()</script>"]).stream())).rejects.toThrow("文件内容");
  fs.mkdirSync(path.join(root, "uploads"), { recursive: true });
  const id = "web-1234567890123-abcdefabcdef.png";
  fs.symlinkSync(path.join(root, "runner-settings.json"), path.join(root, "uploads", id));
  expect(() => readControlledImage(id)).toThrow("不可预览");
});

test("non-object ACP stdout JSON cannot crash the host and later RPC responses still work", async () => {
  const { PassThrough } = await import("node:stream");
  const { JsonRpcPeer } = await import("../lib/acp/jsonrpc");
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const peer = new JsonRpcPeer({ stdout, stdin } as unknown as import("node:child_process").ChildProcess);
  const response = peer.request("initialize", {}, 1000);
  expect(() => stdout.write('null\n[]\n7\n"hello"\n')).not.toThrow();
  stdout.write('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n');
  await expect(response).resolves.toEqual({ protocolVersion: 1 });
  peer.close("test done");
});

test("ACP stdout frame limit terminates oversized complete and unterminated protocol messages", async () => {
  const { PassThrough } = await import("node:stream");
  const { JsonRpcPeer, MAX_RPC_MESSAGE_CHARS } = await import("../lib/acp/jsonrpc");
  for (const ending of ["", "\n"]) {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const peer = new JsonRpcPeer({ stdout, stdin } as unknown as import("node:child_process").ChildProcess);
    const response = peer.request("initialize", {}, 1000);
    const failure = expect(response).rejects.toThrow("大小上限");
    stdout.write("x".repeat((MAX_RPC_MESSAGE_CHARS ?? 1024 * 1024) + 1) + ending);
    await failure;
    await expect(peer.request("initialize", {}, 1000)).rejects.toThrow("连接已关闭");
  }
});

test("failed local Issue validation and run persistence cannot change live task state", async () => {
  const issues = await import("../lib/issue-store");
  const issue = issues.createIssue({ title: "Saved issue", description: "Original" });
  const run = issues.addRun(issue.id, { mode: "analyze", prompt: () => "Test" });
  const previous = structuredClone(issues.requireIssue(issue.id));
  expect(() => issues.patchIssue(issue.id, { title: "Rejected title", status: "invalid" })).toThrow();
  expect(issues.requireIssue(issue.id)).toEqual(previous);
  const rename = fs.renameSync;
  fs.renameSync = (() => { throw new Error("simulated disk failure"); }) as typeof fs.renameSync;
  try {
    expect(() => issues.patchRun(issue.id, run.id, { status: "completed" })).toThrow("simulated disk failure");
  } finally {
    fs.renameSync = rename;
  }
  expect(issues.requireIssue(issue.id)).toEqual(previous);
  expect(issues.findRun(run.id)?.run.status).toBe("pending");
});

test("malformed ACP error objects cannot throw while formatting remote diagnostics", async () => {
  const { PassThrough } = await import("node:stream");
  const { JsonRpcPeer } = await import("../lib/acp/jsonrpc");
  const stdout = new PassThrough();
  const peer = new JsonRpcPeer({ stdout, stdin: new PassThrough() } as unknown as import("node:child_process").ChildProcess);
  const response = peer.request("initialize", {}, 1000);
  const failure = expect(response).rejects.toThrow("无效的协议错误");
  expect(() => stdout.write('{"id":1,"error":{"code":-1,"message":{"toString":null}}}\n')).not.toThrow();
  await failure;
  peer.close("test done");
});

test("private embed allowlist distinguishes IPv6 networks from public hostnames with fc/fd prefixes", async () => {
  const { isPrivateHost } = await import("../lib/embed-allow");
  for (const name of ["fcdn.example.com", "fd.example.org", "fc", "fd00:invalid"]) {
    expect(isPrivateHost(name), name).toBe(false);
  }
  for (const address of ["fc00::1", "fd12:3456::1", "[fd12:3456::1]", "fe80::1", "febf::1", "127.0.0.1", "192.168.1.2"]) {
    expect(isPrivateHost(address), address).toBe(true);
  }
  for (const address of ["2001:db8::1", "fec0::1", "fd::1"]) {
    expect(isPrivateHost(address), address).toBe(false);
  }
});

test("Runner settings require the write-auth channel for reads without breaking the existing browser client", async () => {
  const { GET } = await import("../app/api/runner-settings/route");
  settings.patchRunnerSettings({ agents: [{ id: "private-config", command: "test-agent", args: ["test-private-argument"], cwd: root, env: { TEST_KEY: "test-private-env-value" } }] });
  const base = "http://127.0.0.1:8567";
  const anonymous = await GET(new Request(`${base}/api/runner-settings`, { headers: { host: "127.0.0.1:8567" } }));
  expect(anonymous.status).toBe(403);
  expect(await anonymous.text()).not.toContain("test-private-argument");
  const crossOrigin = await GET(new Request(`${base}/api/runner-settings`, { headers: { host: "127.0.0.1:8567", origin: "https://example.org", "x-board-web": "1" } }));
  expect(crossOrigin.status).toBe(403);
  for (const headers of [
    { host: "127.0.0.1:8567", origin: base, "x-board-web": "1" },
    { host: "127.0.0.1:8567", "x-auth-key": "security-test-token" },
  ]) {
    const response = await GET(new Request(`${base}/api/runner-settings`, { headers: headers as HeadersInit }));
    expect(response.status).toBe(200);
    const content = await response.text();
    expect(content).toContain("test-private-argument");
    expect(content).not.toContain("test-private-env-value");
  }
});

test("corrupt Issue and Runner files remain byte-for-byte intact until explicitly repaired", async () => {
  const issues = await import("../lib/issue-store");
  issues.createIssue({ title: "Corruption fixture", description: "" });
  settings.patchRunnerSettings({ agents: [{ id: "corruption-fixture", command: "test-agent" }] });
  const issueFile = path.join(root, "issues.json");
  const runnerFile = path.join(root, "runner-settings.json");
  const validIssues = fs.readFileSync(issueFile, "utf8");
  const validRunner = fs.readFileSync(runnerFile, "utf8");
  const log = console.error;
  console.error = () => {};
  try {
    for (const damaged of ['{"secret":"fixture-value",', '{}', 'null']) {
      fs.writeFileSync(issueFile, damaged);
      expect(issues.listIssues()).toEqual([]);
      expect(() => issues.createIssue({ title: "Must not overwrite", description: "" })).toThrow("已保留原文件");
      expect(fs.readFileSync(issueFile, "utf8")).toBe(damaged);
      fs.writeFileSync(issueFile, validIssues);
      expect(issues.listIssues().length).toBeGreaterThan(0);
      fs.writeFileSync(runnerFile, damaged);
      expect(settings.loadRunnerSettings().agents).toEqual([]);
      expect(() => settings.patchRunnerSettings({ permissionMode: "auto" })).toThrow("已保留原文件");
      expect(fs.readFileSync(runnerFile, "utf8")).toBe(damaged);
      fs.writeFileSync(runnerFile, validRunner);
      expect(settings.loadRunnerSettings().agents.length).toBeGreaterThan(0);
    }
    expect(issues.createIssue({ title: "Repaired", description: "" }).title).toBe("Repaired");
    expect(settings.patchRunnerSettings({ permissionMode: "ask" }).permissionMode).toBe("ask");
  } finally {
    fs.writeFileSync(issueFile, validIssues);
    fs.writeFileSync(runnerFile, validRunner);
    console.error = log;
  }
});

test("unreadable stores fail closed for writes instead of becoming empty writable stores", async () => {
  const issues = await import("../lib/issue-store");
  issues.createIssue({ title: "Unreadable fixture", description: "" });
  settings.patchRunnerSettings({ agents: [{ id: "unreadable-fixture", command: "test-agent" }] });
  const issueFile = path.join(root, "issues.json");
  const runnerFile = path.join(root, "runner-settings.json");
  const original = fs.statSync;
  fs.statSync = ((file: fs.PathLike, ...args: unknown[]) => {
    if (file === issueFile || file === runnerFile) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return (original as (...values: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.statSync;
  try {
    expect(issues.listIssues()).toEqual([]);
    expect(settings.loadRunnerSettings().agents).toEqual([]);
    expect(() => issues.createIssue({ title: "Denied", description: "" })).toThrow("不可读");
    expect(() => settings.patchRunnerSettings({ permissionMode: "auto" })).toThrow("不可读");
  } finally {
    fs.statSync = original;
  }
  expect(issues.listIssues().length).toBeGreaterThan(0);
  expect(settings.loadRunnerSettings().agents.length).toBeGreaterThan(0);
});

test("configured provider errors do not expose upstream diagnostic bodies or transport details", async () => {
  const { callRunner } = await import("../lib/goal-agent");
  const { searchAidocs } = await import("../lib/aidocs");
  const { listBooks } = await import("../lib/book-library");
  const original = globalThis.fetch;
  const providers = [
    () => callRunner("GET", "/api/health", undefined, { baseUrl: "http://127.0.0.1:1", readToken: () => "test-provider-token" }),
    () => searchAidocs({ query: "test" }),
    () => listBooks(),
  ];
  try {
    for (const failure of ["body", "transport"]) {
      globalThis.fetch = async () => {
        if (failure === "transport") throw new Error("test-upstream-secret /private/provider/config.json");
        return new Response(JSON.stringify({ error: "test-upstream-secret", message: "/private/provider/config.json" }), { status: 500 });
      };
      for (const invoke of providers) {
        let error: unknown;
        try { await invoke(); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(http.ApiError);
        expect((error as Error).message).not.toContain("test-upstream-secret");
        expect((error as Error).message).not.toContain("/private/provider");
        expect((error as InstanceType<typeof http.ApiError>).statusCode).toBe(502);
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("Runner credentials never follow a cross-origin HTTP redirect", async () => {
  const { createServer } = await import("node:http");
  const { callRunner } = await import("../lib/goal-agent");
  let destinationCalls = 0;
  const destination = createServer((_req, res) => { destinationCalls++; res.end('{}'); });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const destinationPort = (destination.address() as import("node:net").AddressInfo).port;
  const source = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${destinationPort}/redirected` });
    res.end();
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  try {
    const sourcePort = (source.address() as import("node:net").AddressInfo).port;
    await expect(callRunner("GET", "/api/health", undefined, { baseUrl: `http://127.0.0.1:${sourcePort}`, readToken: () => "test-redirect-token" })).rejects.toThrow("无法连接任务 Runner");
    expect(destinationCalls).toBe(0);
  } finally {
    source.closeAllConnections();
    destination.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => source.close(() => resolve())), new Promise<void>((resolve) => destination.close(() => resolve()))]);
  }
});

test("layout rejects stale async results before they can overwrite a concurrent edit", async () => {
  const service = await import("../lib/board-service");
  const board = { id: "b_layout_concurrent", name: "layout concurrency", cards: [{ id: "c_layout", type: "text", x: 301, y: 207, w: 280, h: 170, title: "original" }], edges: [], comments: [], createdAt: 1, updatedAt: 1 } as unknown as Board;
  storage.insertBoard(() => board);
  const pending = service.tidyBoardLayout(board.id, "grid");
  storage.mutateBoard(board.id, (target) => { target.cards[0].w = 701; target.cards[0].title = "concurrent edit"; });
  await expect(pending).rejects.toMatchObject({ statusCode: 409 });
  const after = storage.requireBoard(board.id);
  expect(after.cards[0]).toMatchObject({ x: 301, y: 207, w: 701, title: "concurrent edit" });
  expect(after.activity || []).toHaveLength(0);
});

test("layout rejects unknown modes and does not checkpoint or rewrite a repeated identical layout", async () => {
  const service = await import("../lib/board-service");
  const board = { id: "b_layout_noop", name: "layout no-op", cards: [{ id: "c_noop", type: "text", x: 301, y: 207, w: 280, h: 170 }], edges: [], comments: [], createdAt: 1, updatedAt: 1 } as unknown as Board;
  storage.insertBoard(() => board);
  const original = structuredClone(storage.requireBoard(board.id));
  for (const mode of ["typo", "", null, 42]) await expect(service.tidyBoardLayout(board.id, mode)).rejects.toMatchObject({ statusCode: 400 });
  expect(storage.requireBoard(board.id)).toEqual(original);
  await service.tidyBoardLayout(board.id, "grid");
  const first = structuredClone(storage.requireBoard(board.id));
  const second = await service.tidyBoardLayout(board.id, "grid");
  expect(second).toMatchObject({ moved: 1, changed: 0 });
  expect(storage.requireBoard(board.id)).toEqual(first);
});
