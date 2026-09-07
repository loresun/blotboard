#!/usr/bin/env node
/**
 * blotboard API 冒烟测试。
 *
 * 用例 1:1 继承 goal-agent `scripts/smoke-board.js`（画板 CRUD、六种卡片、连线、批量几何、
 * 鉴权三条路径、跨画板任务聚合、转 Issue / 发起任务、上传引用与受控下载、whole 全量替换、
 * mtime 外部写入感知、持久化），加上本项目新增的：runner 代理白名单、x-board-web 新头、
 * 连线 PATCH 改标签、健康检查、/api/capabilities 能力自描述，以及**零配置形态**
 *（三个外部服务 env 全空时另起一个实例：search/library 关、aidocs/books 回 503，
 * 任务链路退到 local 后端并跑通全闭环——转 Issue → 生成 prompt → agent 回写 → 任务台）。
 *
 *   node scripts/smoke-api.mjs              自起服务（需先 npm run build）
 *   node scripts/smoke-api.mjs --dev        自起 dev server（不需要 build，较慢）
 *   node scripts/smoke-api.mjs --base http://127.0.0.1:8567   打已经在跑的服务（只跑只读用例）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_TOKEN = "board-test-token";
const args = process.argv.slice(2);
const devMode = args.includes("--dev");
const baseOverride = (() => {
  const index = args.indexOf("--base");
  return index >= 0 ? args[index + 1] : null;
})();

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blotboard-smoke-"));
const dataDir = path.join(tmpRoot, "data");
const uploadsDir = path.join(dataDir, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
/** 全部 21 种原生卡片类型（与 lib/types.ts BOARD_CARD_TYPES 对齐；capabilities 用例会交叉校验）。 */
const ALL_CARD_TYPES = ["text", "task", "link", "quote", "image", "media", "pdf", "ref", "board", "mindmap", "todo", "svg", "mermaid", "excalidraw", "data", "book", "html", "code", "table", "chart", "frame"];
// 主实例把全部卡片包打开（用例会建 html/svg/image/chart 等非默认集类型的卡）；
// 「首次生成默认集 = 方案默认 ∪ 存量类型」的规则由后面的 bare 实例覆盖。
fs.writeFileSync(
  path.join(dataDir, "card-packs.json"),
  JSON.stringify({ version: "1", enabled: Object.fromEntries(ALL_CARD_TYPES.map((type) => [type, true])) }, null, 2),
);
fs.writeFileSync(path.join(tmpRoot, "settings.json"), JSON.stringify({ internalApiToken: RUNNER_TOKEN }));

/* ── mock Goal Agent Runner ───────────────────────── */
let issueCreateCount = 0;
let lastIssueDescription = "";
/** 画板回推 Issue 的每一次 PATCH：自动同步的断言全看它 */
const issuePatches = [];
const launchCalls = [];
const dispatchedTasks = [];

const runner = http.createServer(async (req, res) => {
  if (req.headers["x-auth-key"] !== RUNNER_TOKEN) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: false }));
  }
  const send = (code, data) => {
    const body = JSON.stringify(data);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  const readBody = async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  };
  if (req.url === "/api/capabilities") return send(200, { service: "goal-agent", features: {} });
  const taskMatch = /^\/api\/tasks\/(task-issue-\d+)$/.exec(req.url);
  if (taskMatch && req.method === "GET") {
    return send(200, { ok: true, task: { id: taskMatch[1], status: "running", summary: "整理完成一半：已归类 3 张卡片", updatedAt: 12345 } });
  }
  if (req.url === "/api/tasks" && req.method === "POST") {
    const body = await readBody();
    dispatchedTasks.push(body);
    return send(201, { ok: true, task: { id: `task-dispatch-${dispatchedTasks.length}` } });
  }
  if (req.url === "/api/issues" && req.method === "POST") {
    issueCreateCount += 1;
    const body = await readBody();
    lastIssueDescription = String(body.description || "");
    return send(201, { ok: true, issue: { id: `issue-${issueCreateCount}`, identifier: `ISSUE-${100 + issueCreateCount}`, title: body.title } });
  }
  const patchMatch = /^\/api\/issues\/(issue-\d+)$/.exec(req.url);
  if (patchMatch && req.method === "PATCH") {
    const body = await readBody();
    issuePatches.push({ id: patchMatch[1], body });
    if (patchMatch[1] === "issue-gone") return send(200, { ok: true, issue: null }); // Goal Agent 里已经没有这条
    return send(200, { ok: true, issue: { id: patchMatch[1], identifier: `ISSUE-${patchMatch[1]}`, ...body } });
  }
  const launchMatch = /^\/api\/issues\/(issue-\d+)\/launch$/.exec(req.url);
  if (launchMatch && req.method === "POST") {
    const body = await readBody();
    launchCalls.push({ id: launchMatch[1], body });
    return send(201, { ok: true, sessionId: `task-${launchMatch[1]}`, mode: body.mode, issue: { id: launchMatch[1] } });
  }
  return send(404, { ok: false });
});

/* ── 工具 ─────────────────────────────────────────── */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, child, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`服务进程提前退出（code ${child.exitCode}）`);
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("等待服务健康检查超时");
}

let mark = "start";
const step = (name) => {
  mark = name;
};
const watchdog = setTimeout(() => {
  console.error(`⏱ 卡在：${mark}`);
  process.exit(2);
}, 300_000);
watchdog.unref?.();

/* ── 主流程 ───────────────────────────────────────── */
let child = null;
/** 未配置形态的第二个实例（用完即杀，cleanup 里兜底） */
let bareChild = null;

async function main() {
  await new Promise((resolve) => runner.listen(0, "127.0.0.1", resolve));
  const runnerPort = runner.address().port;

  let base = baseOverride;
  if (!base) {
    if (!devMode && !fs.existsSync(path.join(PROJECT_ROOT, ".next", "BUILD_ID"))) {
      throw new Error("没找到构建产物：先 npm run build，或用 --dev 跑开发服务");
    }
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["server.mjs", ...(devMode ? ["--dev"] : [])], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: devMode ? "development" : "production",
        BLOTBOARD_PORT: String(port),
        // 同 playwright：冒烟自己挑端口，顺延会让后面的断言打空
        BLOTBOARD_PORT_STRICT: "1",
        BLOTBOARD_HOST: "127.0.0.1",
        BLOTBOARD_DATA_DIR: dataDir,
        BLOTBOARD_DATA_FILE: path.join(dataDir, "boards.json"),
        BLOTBOARD_UPLOADS_DIR: uploadsDir,
        BLOTBOARD_AGENT_COMMANDS_FILE: path.join(dataDir, "agent-commands.json"),
        GOAL_AGENT_RUNNER_URL: `http://127.0.0.1:${runnerPort}`,
        // 通用 http 后端显式清空：它的优先级高于 goal-agent，外层 shell 漏进来会换后端
        BLOTBOARD_RUNNER_URL: "",
        // 只配任务后端：知识库 / 书库显式清空（防外层 shell 环境漏进来），
        // 这个实例覆盖的是「tasks 开、search/library 关」的混合形态
        GOAL_AGENT_WEB_URL: "",
        AIDOCS_URL: "",
        BOOK_LIBRARY_URL: "",
        // 自动同步的防抖压到 120ms：冒烟里等一小会儿就能断言，不用陪着默认的 1.2 秒
        BLOTBOARD_ISSUE_SYNC_DEBOUNCE_MS: "120",
        // 快照保留上限压到 5：默认 10 要写 11 次批量才验得到滚动淘汰，5 次就够（默认值本身由 config 单测口径守着）
        BLOTBOARD_CHECKPOINT_KEEP: "5",
        BLOTBOARD_GOAL_AGENT_SETTINGS: path.join(tmpRoot, "settings.json"),
        // 网页卡白名单：默认的 @private 之外再加一条域后缀，验证「白名单可配置」
        BLOTBOARD_HTML_ALLOW: "@private,*.example.com",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.env.SMOKE_VERBOSE && process.stdout.write(`[server] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
    step("boot");
    await waitForHealth(base, child);
  }

  const origin = base;
  const BROWSER = { "content-type": "application/json", "x-board-web": "1", origin };
  const LEGACY_BROWSER = { "content-type": "application/json", "x-goal-agent-web": "1", origin };
  const AGENT = (token) => ({ "content-type": "application/json", "x-auth-key": token });

  const request = async (method, url, { headers = BROWSER, body } = {}) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, data };
  };

  if (baseOverride) {
    step("readonly-live");
    const health = await request("GET", "/api/health");
    assert.equal(health.status, 200);
    const boards = await request("GET", "/api/boards");
    assert.equal(boards.status, 200);
    assert.ok(Array.isArray(boards.data.boards));
    console.log(`✅ 只读冒烟通过（${base}，画板 ${boards.data.boards.length} 块）`);
    return;
  }

  /* 1. 画板 CRUD */
  step("create-board");
  const created = await request("POST", "/api/boards", { body: { name: "新产品脑暴" } });
  assert.equal(created.status, 201);
  const boardId = created.data.board.id;
  assert.match(boardId, /^b_[a-z0-9]+$/);

  const emptyName = await request("POST", "/api/boards", { body: { name: "  " } });
  assert.equal(emptyName.status, 400);

  let list = await request("GET", "/api/boards");
  assert.equal(list.data.boards.length, 1);
  assert.equal(list.data.boards[0].name, "新产品脑暴");

  const renamed = await request("PATCH", `/api/boards/${boardId}`, { body: { name: "短视频脑暴" } });
  assert.equal(renamed.data.board.name, "短视频脑暴");

  const badBoardId = await request("GET", "/api/boards/not-a-board-id");
  assert.equal(badBoardId.status, 400);

  /* 2. 鉴权三条路径 */
  step("auth");
  const anonymous = await request("POST", `/api/boards/${boardId}/cards`, {
    headers: { "content-type": "application/json" },
    body: { type: "text", title: "匿名" },
  });
  assert.equal(anonymous.status, 403);
  // 403 得是「照着做就能过」的：agent 拿 curl 打写接口时并不知道 token 在哪（真实踩坑）
  assert.ok(anonymous.data.error.includes("x-auth-key"), anonymous.data.error);
  assert.ok(anonymous.data.error.includes("token"), anonymous.data.error);
  assert.ok(anonymous.data.error.includes("x-board-web"), "浏览器那条通道也要提一句");
  assert.ok(!anonymous.data.error.includes(tmpRoot), `报错不该泄露本机绝对路径：${anonymous.data.error}`);

  const badToken = await request("POST", `/api/boards/${boardId}/cards`, {
    headers: AGENT("wrong-token"),
    body: { type: "text", title: "假 token" },
  });
  assert.equal(badToken.status, 403);

  // 老浏览器头（x-goal-agent-web）保持兼容，老脚本/老冒烟不用改
  const legacyHeaderCard = await request("POST", `/api/boards/${boardId}/cards`, {
    headers: LEGACY_BROWSER,
    body: { type: "text", title: "老头兼容" },
  });
  assert.equal(legacyHeaderCard.status, 201);
  await request("DELETE", `/api/boards/${boardId}/cards/${legacyHeaderCard.data.card.id}`);

  const agentCard = await request("POST", `/api/boards/${boardId}/cards`, {
    headers: AGENT(RUNNER_TOKEN),
    body: { type: "text", title: "agent 建的卡片", content: "由 agent 写入", x: 50, y: 60, createdBy: "agent" },
  });
  assert.equal(agentCard.status, 201);
  assert.equal(agentCard.data.card.createdBy, "agent");
  const agentCardId = agentCard.data.card.id;

  /* 3. 六种卡片类型 */
  step("cards");
  const pngId = `web-${Date.now()}-abcdef123456.png`;
  fs.writeFileSync(path.join(uploadsDir, pngId), Buffer.from("89504e470d0a1a0a", "hex"));
  const pdfId = `web-${Date.now()}-abcdef654321.pdf`;
  fs.writeFileSync(path.join(uploadsDir, pdfId), Buffer.from("%PDF-1.4 test"));

  const textCard = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "text", title: "想法", content: "先做短视频切片", color: "amber" } });
  assert.equal(textCard.status, 201);
  assert.equal(textCard.data.card.color, "amber");

  const taskCard = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "task", title: "剪辑 3 条切片", task: { goal: "用素材库剪辑 3 条切片并发布", priority: "high" } } });
  assert.equal(taskCard.status, 201);
  assert.equal(taskCard.data.card.task.status, "idea");
  const taskCardId = taskCard.data.card.id;

  const linkCard = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "link", link: { url: "https://example.com/post/1" } } });
  assert.equal(linkCard.status, 201);
  assert.equal(linkCard.data.card.link.host, "example.com");

  const badLink = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "link", link: { url: "javascript:alert(1)" } } });
  assert.equal(badLink.status, 400);

  const quoteCard = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "quote", content: "选品即选择注意力", quote: { source: "内部周会" } } });
  assert.equal(quoteCard.status, 201);

  const imageCard = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "image", title: "参考图", file: { uploadId: pngId, name: "参考图.png", kind: "image", mediaType: "image/png", size: 8 } } });
  assert.equal(imageCard.status, 201);
  assert.ok(imageCard.data.card.file.previewUrl.includes("/api/uploads/"));
  assert.ok(fs.existsSync(path.join(uploadsDir, `${pngId}.claimed`)));

  const ghostFile = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "image", file: { uploadId: `web-${Date.now()}-000000000000.png` } } });
  assert.equal(ghostFile.status, 400);

  const pdfCard = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "pdf", title: "行业报告", file: { uploadId: pdfId, name: "报告.pdf", kind: "file", mediaType: "application/pdf", size: 15 } } });
  assert.equal(pdfCard.status, 201);
  assert.equal(pdfCard.data.card.file.url, `/api/boards/uploads/${pdfId}`);

  /* 字段名陷阱：image/pdf 的文件字段是 file.uploadId，写成 image.uploadId 要被**点名** 400，
     不能静默忽略后报「缺 file」——那会让人以为是上传出了问题，反复重传文件 */
  for (const type of ["image", "media", "pdf"]) {
    const aliased = await request("POST", `/api/boards/${boardId}/cards`, {
      body: { type, title: "字段名写错了", [type]: { uploadId: pngId } },
    });
    assert.equal(aliased.status, 400, `${type}.uploadId 要 400`);
    assert.ok(aliased.data.error.includes("file.uploadId"), aliased.data.error);
    assert.ok(aliased.data.error.includes(`不是 ${type}.uploadId`), aliased.data.error);
    assert.ok(aliased.data.error.includes("/api/uploads"), "要指出文件得先上传");
  }
  // 类型互转也拦得住（不然先撞 beforeConvert 的「必须提供 file.uploadId」，还是不知道键写错了）
  const aliasedConvert = await request("PATCH", `/api/boards/${boardId}/cards/${textCard.data.card.id}`, {
    body: { type: "image", image: { uploadId: pngId } },
  });
  assert.equal(aliasedConvert.status, 400);
  assert.ok(aliasedConvert.data.error.includes("file.uploadId"), aliasedConvert.data.error);

  /* excalidraw：source 传**对象**（.excalidraw 文件 JSON.parse 之后的样子）也要收下，
     老行为 String(对象) 会落一个 "[object Object]"，整张卡报废 */
  const sceneObject = {
    type: "excalidraw",
    version: 2,
    elements: [
      { id: "r1", type: "rectangle", x: 0, y: 0, width: 100, height: 60 },
      { id: "t1", type: "text", x: 10, y: 10, text: "对象也能收", originalText: "对象也能收" },
    ],
    appState: { viewBackgroundColor: "#ffffff", selectedElementIds: { r1: true } },
    files: {},
  };
  const objectScene = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "excalidraw", title: "对象源的画", excalidraw: { source: sceneObject } },
  });
  assert.equal(objectScene.status, 201);
  const objectSceneSource = objectScene.data.card.excalidraw.source;
  assert.ok(!objectSceneSource.includes("[object Object]"), "绝不能落 [object Object]");
  const parsedScene = JSON.parse(objectSceneSource); // 合法 JSON，解析不出来这里就炸
  assert.equal(parsedScene.elements.length, 2);
  assert.equal(parsedScene.appState.selectedElementIds, undefined, "会话态字段照旧不落库");
  // 「能被 excalidrawText 解析」的端到端证据：md 导出那行走的就是它
  const sceneMd = await (await fetch(`${base}/api/boards/${boardId}/export?format=md`)).text();
  assert.ok(sceneMd.includes("对象也能收"), "画上的文字要能被解析出来进 markdown");
  // 数组形态（有些 .excalidraw 就是一个 elements 数组）同样收
  const arrayScene = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "excalidraw", title: "数组源的画", excalidraw: { source: sceneObject.elements } },
  });
  assert.equal(arrayScene.status, 201);
  assert.equal(JSON.parse(arrayScene.data.card.excalidraw.source).elements.length, 2);
  // mermaid / svg 的 source 是「给别的语言看的源码」，对象没有合理解释 → 点名 400，同样不落 [object Object]
  for (const [type, key] of [["mermaid", "mermaid"], ["svg", "svg"]]) {
    const objectSource = await request("POST", `/api/boards/${boardId}/cards`, {
      body: { type, [key]: { source: { nodes: ["a", "b"] } } },
    });
    assert.equal(objectSource.status, 400, `${type}.source 传对象要 400`);
    assert.ok(objectSource.data.error.includes(`${key}.source`), objectSource.data.error);
  }

  /* 网页嵌入卡（html）：白名单是这张卡唯一的写入闸门 */
  step("html-cards");
  const embedAllow = await request("GET", "/api/embed-allow");
  assert.equal(embedAllow.status, 200);
  assert.ok(embedAllow.data.rules.some((rule) => rule.kind === "private"), "默认应放行私网");
  assert.ok(embedAllow.data.rules.some((rule) => rule.suffix === "example.com"), "配置的域后缀应生效");

  const htmlCard = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "html", title: "路演 PPT", html: { url: "http://127.0.0.1:8000/slides/index.html" } },
  });
  assert.equal(htmlCard.status, 201);
  assert.equal(htmlCard.data.card.html.host, "127.0.0.1:8000");
  assert.equal(htmlCard.data.card.html.mode, "auto");
  assert.equal(htmlCard.data.card.html.frameW, 1280);
  assert.equal(htmlCard.data.card.html.frameH, 720);
  const htmlCardId = htmlCard.data.card.id;

  /* 白名单里的域后缀：裸域与子域都放行 */
  for (const url of ["https://example.com/deck.html", "https://ppt.example.com/deck.html"]) {
    const allowed = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "html", html: { url } } });
    assert.equal(allowed.status, 201, `${url} 应被放行`);
    await request("DELETE", `/api/boards/${boardId}/cards/${allowed.data.card.id}`);
  }

  /* 白名单之外一律 4xx，且报错要说清楚现在允许哪些 */
  const offAllow = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "html", html: { url: "https://evil.test/steal.html" } },
  });
  assert.equal(offAllow.status, 400);
  assert.ok(/白名单/.test(offAllow.data.error), `报错要提白名单，实际：${offAllow.data.error}`);
  assert.ok(/example\.com/.test(offAllow.data.error), "报错要列出当前允许的规则");

  /* 「点开就执行」的协议连 http(s) 这关都过不了 */
  for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"]) {
    const bad = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "html", html: { url } } });
    assert.equal(bad.status, 400, `${url} 应被拒绝`);
  }

  /* 空卡片允许（工具条建的新卡就是空的，先落地再填地址） */
  const emptyHtml = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "html" } });
  assert.equal(emptyHtml.status, 201);
  assert.equal(emptyHtml.data.card.html.url, "");
  await request("DELETE", `/api/boards/${boardId}/cards/${emptyHtml.data.card.id}`);

  /* 只改尺寸 / 加载时机时，地址不能被清掉（PATCH 合并而不是整体替换） */
  const htmlPatched = await request("PATCH", `/api/boards/${boardId}/cards/${htmlCardId}`, {
    body: { html: { mode: "manual", frameW: 960, frameH: 540 } },
  });
  assert.equal(htmlPatched.status, 200);
  assert.equal(htmlPatched.data.card.html.url, "http://127.0.0.1:8000/slides/index.html");
  assert.equal(htmlPatched.data.card.html.mode, "manual");
  assert.equal(htmlPatched.data.card.html.frameW, 960);

  /* 改成非白名单地址同样挡住（改卡片是第二条写入路径） */
  const patchBlocked = await request("PATCH", `/api/boards/${boardId}/cards/${htmlCardId}`, {
    body: { html: { url: "https://evil.test/x.html" } },
  });
  assert.equal(patchBlocked.status, 400);

  /* frameW=0 = 铺满卡片；上限之外的数字 clamp 回区间 */
  const htmlFill = await request("PATCH", `/api/boards/${boardId}/cards/${htmlCardId}`, {
    body: { html: { frameW: 0, frameH: 0 } },
  });
  assert.equal(htmlFill.data.card.html.frameW, 0);
  const htmlHuge = await request("PATCH", `/api/boards/${boardId}/cards/${htmlCardId}`, {
    body: { html: { frameW: 99999, frameH: 99999 } },
  });
  assert.equal(htmlHuge.data.card.html.frameW, 4000);

  /* CSP：@private 枚举不出 frame-src，但 frame-ancestors / object-src 必须在 */
  const cspProbe = await fetch(`${base}/api/health`);
  const csp = cspProbe.headers.get("content-security-policy") || "";
  assert.ok(/frame-ancestors 'self'/.test(csp), `缺 frame-ancestors，实际：${csp}`);
  assert.ok(/object-src 'none'/.test(csp), `缺 object-src，实际：${csp}`);

  /* 净化链路回归：加了 html 卡不能动摇 svg 卡「入库即剥」的行为 */
  step("sanitize-svg");
  const dirtySvg =
    '<svg viewBox="0 0 10 10"><script>alert(1)</script>' +
    '<rect onclick="alert(2)" onmouseover=alert(3) width="4" height="4" />' +
    '<foreignObject><div>x</div></foreignObject>' +
    '<a xlink:href="javascript:alert(4)">go</a></svg>';
  const assertClean = (source, where) => {
    assert.ok(!/<script/i.test(source), `${where}：script 没被剥掉`);
    assert.ok(!/<foreignObject/i.test(source), `${where}：foreignObject 没被剥掉`);
    assert.ok(!/onclick|onmouseover/i.test(source), `${where}：on* 属性没被剥掉`);
    assert.ok(!/javascript:/i.test(source), `${where}：javascript: 链接没被剥掉`);
    assert.ok(/<rect/i.test(source), `${where}：正常图形不该被剥掉`);
  };
  const svgCreated = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "svg", svg: { source: dirtySvg } } });
  assert.equal(svgCreated.status, 201);
  assertClean(svgCreated.data.card.svg.source, "建卡");
  const svgPatched = await request("PATCH", `/api/boards/${boardId}/cards/${svgCreated.data.card.id}`, {
    body: { svg: { source: dirtySvg } },
  });
  assertClean(svgPatched.data.card.svg.source, "改卡");
  const svgConverted = await request("PATCH", `/api/boards/${boardId}/cards/${textCard.data.card.id}`, {
    body: { type: "svg", svg: { source: dirtySvg } },
  });
  assertClean(svgConverted.data.card.svg.source, "类型互转");
  await request("PATCH", `/api/boards/${boardId}/cards/${textCard.data.card.id}`, { body: { type: "text" } });
  await request("DELETE", `/api/boards/${boardId}/cards/${svgCreated.data.card.id}`);
  await request("DELETE", `/api/boards/${boardId}/cards/${htmlCardId}`);

  /* ── 第二波三种卡片包：代码 / 表格 / 数据图 ─────────────────
     每种都跑一遍「建卡 → 改卡 → 非法输入 400 → 导出 md/html → 搜索命中 → 信封」。 */
  step("code-cards");
  const codeSource = "export function retry(times) {\n  // 重试三次\n  return times > 0;\n}";
  const codeCard = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "code", title: "重试实现", code: { source: codeSource, language: "TS", filename: "lib/retry.ts" } },
  });
  assert.equal(codeCard.status, 201);
  const codeCardId = codeCard.data.card.id;
  assert.equal(codeCard.data.card.code.language, "ts", "language 统一收成小写");
  assert.equal(codeCard.data.card.code.filename, "lib/retry.ts");
  assert.ok(codeCard.data.card.code.source.includes("重试三次"), "源码逐字保存");
  assert.ok(codeCard.data.card.code.source.startsWith("export function"), "首尾空行去掉，行内缩进不动");

  /* 非法 language：形状不像标识（整段话 / 太长 / 大写以外的怪字符）→ 400 点名 */
  for (const bad of ["这是一段 TypeScript 代码", "a".repeat(30), "c++ 或者 rust"]) {
    const badLang = await request("POST", `/api/boards/${boardId}/cards`, {
      body: { type: "code", code: { source: "x", language: bad } },
    });
    assert.equal(badLang.status, 400, `language「${bad}」应被拒`);
    assert.ok(badLang.data.error.includes("code.language"), badLang.data.error);
  }
  /* 表里没有的语言照收（自由值）：只是不高亮 */
  const exoticLang = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "code", code: { source: "const x = 1", language: "zig" } },
  });
  assert.equal(exoticLang.status, 201, "白名单之外的语言标识也要收下");
  assert.equal(exoticLang.data.card.code.language, "zig");
  await request("DELETE", `/api/boards/${boardId}/cards/${exoticLang.data.card.id}`);

  /* source 超限 → 400 报实际数字；传对象 → 400 点名（与 mermaid/svg 同一条路） */
  const hugeCode = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "code", code: { source: "x".repeat(40_001) } },
  });
  assert.equal(hugeCode.status, 400);
  assert.ok(hugeCode.data.error.includes("40001"), hugeCode.data.error);
  const objectCode = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "code", code: { source: { lines: ["a"] } } },
  });
  assert.equal(objectCode.status, 400);
  assert.ok(objectCode.data.error.includes("code.source"), objectCode.data.error);

  /* PATCH 合并：只改语言不该把源码清空 */
  const codePatched = await request("PATCH", `/api/boards/${boardId}/cards/${codeCardId}`, {
    body: { code: { language: "typescript" } },
  });
  assert.equal(codePatched.status, 200);
  assert.equal(codePatched.data.card.code.language, "typescript");
  assert.ok(codePatched.data.card.code.source.includes("retry"), "只改语言时源码要留住");

  step("table-cards");
  /* 形态①：Markdown 表格 */
  const tableMd = await request("POST", `/api/boards/${boardId}/cards`, {
    body: {
      type: "table",
      title: "季度收入",
      table: { markdown: "| 季度 | 收入 |\n| --- | ---: |\n| Q1 | 120 |\n| Q2 | 138 |", caption: "单位：万元" },
    },
  });
  assert.equal(tableMd.status, 201);
  const tableCardId = tableMd.data.card.id;
  assert.equal(tableMd.data.card.table.columns.length, 2);
  assert.equal(tableMd.data.card.table.columns[1].align, "right", "`---:` 要读成右对齐");
  assert.equal(tableMd.data.card.table.rows.length, 2);
  assert.equal(tableMd.data.card.table.rows[0][tableMd.data.card.table.columns[0].key], "Q1");
  assert.equal(tableMd.data.card.table.caption, "单位：万元");

  /* 形态②：CSV（含引号包裹的逗号与转义引号） */
  const tableCsv = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "table", table: { csv: '名称,备注\n"A,B","他说""好"""\nC,普通' } },
  });
  assert.equal(tableCsv.status, 201);
  const csvColumns = tableCsv.data.card.table.columns;
  assert.equal(tableCsv.data.card.table.rows.length, 2);
  assert.equal(tableCsv.data.card.table.rows[0][csvColumns[0].key], "A,B", "引号里的逗号不是分隔符");
  assert.equal(tableCsv.data.card.table.rows[0][csvColumns[1].key], '他说"好"', '"" 是一个转义的引号');
  await request("DELETE", `/api/boards/${boardId}/cards/${tableCsv.data.card.id}`);

  /* 形态③：结构化（行可以是对象，也可以是按列顺序的数组） */
  const tableStruct = await request("POST", `/api/boards/${boardId}/cards`, {
    body: {
      type: "table",
      table: {
        columns: [{ key: "q", label: "季度" }, { key: "v", label: "收入", align: "right" }],
        rows: [{ q: "Q1", v: 120 }, ["Q2", 138]],
      },
    },
  });
  assert.equal(tableStruct.status, 201);
  assert.equal(tableStruct.data.card.table.rows[0].v, "120", "数值统一存成文本");
  assert.equal(tableStruct.data.card.table.rows[1].q, "Q2", "数组行按列顺序落位");
  await request("DELETE", `/api/boards/${boardId}/cards/${tableStruct.data.card.id}`);

  /* 三种形态互斥：同时给两种直接 400（静默挑一个会让另一份数据凭空消失） */
  const twoForms = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "table", table: { markdown: "| a |\n| --- |", csv: "a\n1" } },
  });
  assert.equal(twoForms.status, 400);
  assert.ok(twoForms.data.error.includes("markdown"), twoForms.data.error);

  /* 解析失败要点名到行 */
  const badMd = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "table", table: { markdown: "| 季度 | 收入 |\n| Q1 | 120 |" } },
  });
  assert.equal(badMd.status, 400);
  assert.ok(badMd.data.error.includes("分隔行"), badMd.data.error);

  /* 超限 400 并报实际数字 */
  const wideTable = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "table", table: { columns: Array.from({ length: 51 }, (_, i) => ({ key: `c${i}`, label: `列${i}` })), rows: [] } },
  });
  assert.equal(wideTable.status, 400);
  assert.ok(wideTable.data.error.includes("51"), wideTable.data.error);
  const tallTable = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "table", table: { columns: [{ key: "a", label: "A" }], rows: Array.from({ length: 501 }, () => ({ a: "1" })) } },
  });
  assert.equal(tallTable.status, 400);
  assert.ok(tallTable.data.error.includes("501"), tallTable.data.error);

  /* PATCH 合并：只改 caption 不该把表清掉 */
  const tablePatched = await request("PATCH", `/api/boards/${boardId}/cards/${tableCardId}`, {
    body: { table: { caption: "单位：人民币万元" } },
  });
  assert.equal(tablePatched.status, 200);
  assert.equal(tablePatched.data.card.table.caption, "单位：人民币万元");
  assert.equal(tablePatched.data.card.table.rows.length, 2, "只改标题时表格要留住");

  step("chart-cards");
  const chartCard = await request("POST", `/api/boards/${boardId}/cards`, {
    body: {
      type: "chart",
      title: "季度走势",
      chart: { kind: "bar", title: "季度收入", xLabel: "季度", labels: ["Q1", "Q2"], series: [{ name: "收入", values: [120, 138] }] },
    },
  });
  assert.equal(chartCard.status, 201);
  const chartCardId = chartCard.data.card.id;
  assert.equal(chartCard.data.card.chart.kind, "bar");
  assert.equal(chartCard.data.card.chart.series[0].values[1], 138);

  /* 非法 kind → 400 并列出可选值 */
  const badKind = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "chart", chart: { kind: "sankey", labels: ["a"], series: [{ values: [1] }] } },
  });
  assert.equal(badKind.status, 400);
  assert.ok(badKind.data.error.includes("quadrant"), badKind.data.error);

  /* 给错数据键 → 400 点名该用哪个（pie 用 slices，不是 series） */
  const wrongKey = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "chart", chart: { kind: "pie", series: [{ values: [1, 2] }] } },
  });
  assert.equal(wrongKey.status, 400);
  assert.ok(wrongKey.data.error.includes("chart.slices"), wrongKey.data.error);

  /* 非法数值绝不兜底成 0；labels 与 values 数量必须对上；四象限坐标要在 0~1 */
  const nanValue = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "chart", chart: { kind: "line", labels: ["a"], series: [{ values: [null] }] } },
  });
  assert.equal(nanValue.status, 400);
  assert.ok(nanValue.data.error.includes("有限数字"), nanValue.data.error);
  const lengthMismatch = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "chart", chart: { kind: "bar", labels: ["a", "b"], series: [{ values: [1] }] } },
  });
  assert.equal(lengthMismatch.status, 400);
  const outOfRange = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "chart", chart: { kind: "quadrant", points: [{ label: "A", x: 7, y: 0.3 }] } },
  });
  assert.equal(outOfRange.status, 400);
  assert.ok(outOfRange.data.error.includes("0~1"), outOfRange.data.error);

  /* 空图表允许（工具条建的新卡就是空的，先落地再填） */
  const emptyChart = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "chart" } });
  assert.equal(emptyChart.status, 201);
  assert.deepEqual(emptyChart.data.card.chart, { kind: "bar", labels: [], series: [] });
  await request("DELETE", `/api/boards/${boardId}/cards/${emptyChart.data.card.id}`);

  /* 饼图 + 四象限也各建一张，覆盖两条 mermaid 源码分支 */
  const pieChart = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "chart", chart: { kind: "pie", title: "流量来源", slices: [{ label: "搜索", value: 33 }, { label: "推荐", value: 25 }] } },
  });
  assert.equal(pieChart.status, 201);
  const quadChart = await request("POST", `/api/boards/${boardId}/cards`, {
    body: {
      type: "chart",
      chart: {
        kind: "quadrant",
        axes: { x: ["影响小", "影响大"], y: ["容易", "困难"] },
        quadrants: ["马上做", "排期", "再说", "顺手"],
        points: [{ label: "方案A", x: 0.7, y: 0.3 }],
      },
    },
  });
  assert.equal(quadChart.status, 201);
  assert.equal(quadChart.data.card.chart.points[0].x, 0.7);

  /* 三种卡的导出与检索 */
  step("code-table-chart-export");
  const packMd = await (await fetch(`${base}/api/boards/${boardId}/export?format=md`)).text();
  assert.ok(packMd.includes("```typescript"), "代码卡要导出成带语言标注的围栏代码块");
  assert.ok(packMd.includes("export function retry"), "源码要进 markdown");
  assert.ok(packMd.includes("| 季度 | 收入 |"), "表格卡要导出成 Markdown 表格");
  assert.ok(packMd.includes("xychart-beta"), "图表卡的 markdown 导出给生成好的 mermaid 源码");
  assert.ok(packMd.includes('"搜索" : 33'), "饼图也要翻成 mermaid");

  const packHtml = await (await fetch(`${base}/api/boards/${boardId}/export?format=html`)).text();
  assert.ok(packHtml.includes('<pre class="code">'), "代码卡的 HTML 导出是 pre（服务端不引高亮库）");
  assert.ok(!/hljs/.test(packHtml), "导出产物里不该出现高亮库的类名");
  assert.ok(packHtml.includes("<th>季度</th>"), "表格卡的 HTML 导出是真表格");
  assert.ok(packHtml.includes("图表在画板里查看"), "图表卡的 HTML 导出是诚实降级：数据表 + 一行说明");
  assert.ok(packHtml.includes("<td>33</td>"), "降级表里数据一个不少");

  /* 检索：源码内容、单元格、图表标签都要搜得到 */
  for (const [keyword, hint] of [["重试三次", "代码卡的源码"], ["138", "表格与图表里的数值"], ["流量来源", "图表标题"]]) {
    const hit = await request("GET", `/api/boards/search?q=${encodeURIComponent(keyword)}`);
    assert.equal(hit.status, 200);
    assert.ok(hit.data.boards.some((item) => item.id === boardId), `${hint}应该搜得到（${keyword}）`);
  }

  /* 三种卡都能走信封（自包含）；顺带覆盖信封里的 markdown 形态 */
  const packEnvelope = await request("POST", `/api/boards/${boardId}/ingest`, {
    body: {
      format: "blotboard.cards",
      version: 1,
      cards: [
        { type: "code", title: "信封代码", code: { source: "print('hi')", language: "python" } },
        { type: "table", title: "信封表格", table: { markdown: "| a | b |\n| --- | --- |\n| 1 | 2 |" } },
        { type: "chart", title: "信封图表", chart: { kind: "pie", slices: [{ label: "x", value: 1 }] } },
      ],
    },
  });
  assert.equal(packEnvelope.status, 201, JSON.stringify(packEnvelope.data));
  assert.equal(packEnvelope.data.created.length, 3, "三种新卡都在信封白名单里");

  /* 类型互转进出三种卡（至少不能崩） */
  step("code-table-chart-convert");
  const convertProbe = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "text", title: "互转样本", content: "先是一段文字" },
  });
  const convertId = convertProbe.data.card.id;
  const toCode = await request("PATCH", `/api/boards/${boardId}/cards/${convertId}`, {
    body: { type: "code", code: { source: "SELECT 1", language: "sql" } },
  });
  assert.equal(toCode.status, 200);
  assert.equal(toCode.data.card.code.language, "sql");
  assert.equal(toCode.data.card.content, "先是一段文字", "公共字段互转时保留");
  const toTable = await request("PATCH", `/api/boards/${boardId}/cards/${convertId}`, {
    body: { type: "table", table: { markdown: "| x |\n| --- |\n| 1 |" } },
  });
  assert.equal(toTable.status, 200);
  assert.equal(toTable.data.card.table.rows.length, 1);
  const toChart = await request("PATCH", `/api/boards/${boardId}/cards/${convertId}`, {
    body: { type: "chart", chart: { kind: "pie", slices: [{ label: "只有一瓣", value: 1 }] } },
  });
  assert.equal(toChart.status, 200);
  assert.equal(toChart.data.card.chart.kind, "pie");
  // 转回文本：三份专属字段作为残留留在卡上（透传铁律，不清洗），但类型是 text
  const backText = await request("PATCH", `/api/boards/${boardId}/cards/${convertId}`, { body: { type: "text" } });
  assert.equal(backText.status, 200);
  assert.equal(backText.data.card.type, "text");
  await request("DELETE", `/api/boards/${boardId}/cards/${convertId}`);
  await request("DELETE", `/api/boards/${boardId}/cards/${pieChart.data.card.id}`);
  await request("DELETE", `/api/boards/${boardId}/cards/${quadChart.data.card.id}`);
  for (const created of packEnvelope.data.created) {
    await request("DELETE", `/api/boards/${boardId}/cards/${created.id}`);
  }
  await request("DELETE", `/api/boards/${boardId}/cards/${codeCardId}`);
  await request("DELETE", `/api/boards/${boardId}/cards/${tableCardId}`);
  await request("DELETE", `/api/boards/${boardId}/cards/${chartCardId}`);

  /* 受控下载 */
  step("file-download");
  const pdfFetch = await fetch(`${base}/api/boards/uploads/${pdfId}`);
  assert.equal(pdfFetch.status, 200);
  assert.equal(pdfFetch.headers.get("content-type"), "application/pdf");
  const traversal = await fetch(`${base}/api/boards/uploads/${encodeURIComponent("../../settings.json")}`);
  assert.ok([400, 404].includes(traversal.status), `目录穿越应被拒绝，实际 ${traversal.status}`);

  /* 上传口：真实字节走一遍校验 */
  step("upload");
  const pngBytes = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.from("0000000d49484452", "hex"),
    Buffer.alloc(24),
  ]);
  const uploadResponse = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "image/png", "x-file-name": encodeURIComponent("真实上传.png"), "x-board-web": "1", origin },
    body: pngBytes,
  });
  assert.equal(uploadResponse.status, 201);
  const uploaded = (await uploadResponse.json()).upload;
  assert.equal(uploaded.kind, "image");
  assert.match(uploaded.id, /^web-\d{13}-[a-f0-9]{12}\.png$/);
  const previewResponse = await fetch(`${base}/api/uploads/${uploaded.id}/preview`);
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.headers.get("content-type"), "image/png");

  const mismatch = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "image/png", "x-file-name": encodeURIComponent("假的.png"), "x-board-web": "1", origin },
    body: Buffer.from("not a png at all"),
  });
  assert.equal(mismatch.status, 415);

  const anonymousUpload = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "image/png", "x-file-name": encodeURIComponent("匿名.png") },
    body: pngBytes,
  });
  assert.equal(anonymousUpload.status, 403);

  // 未被引用的上传可以删；被卡片引用后（claimed）拒绝删
  const deletable = await request("DELETE", `/api/uploads/${uploaded.id}`);
  assert.equal(deletable.status, 200);
  const claimedDelete = await request("DELETE", `/api/uploads/${pngId}`);
  assert.equal(claimedDelete.status, 409);

  /* 3.5 音视频：上传 → 建卡 → Range 分段播放 */
  step("media");
  // ISO-BMFF 盒子：第 5-8 字节是 ftyp，签名校验只看这一段（后面填零就够当测试样本）
  const mp4Bytes = Buffer.concat([Buffer.from("00000020", "hex"), Buffer.from("ftypisom"), Buffer.alloc(32)]);
  const m4aBytes = Buffer.concat([Buffer.from("00000020", "hex"), Buffer.from("ftypM4A "), Buffer.alloc(32)]);

  const videoUpload = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "video/mp4", "x-file-name": encodeURIComponent("演示片.mp4"), "x-board-web": "1", origin },
    body: mp4Bytes,
  });
  assert.equal(videoUpload.status, 201);
  const video = (await videoUpload.json()).upload;
  assert.equal(video.kind, "video", "mp4 的 kind 应是 video");
  assert.equal(video.mediaType, "video/mp4");
  assert.match(video.id, /^web-\d{13}-[a-f0-9]{12}\.mp4$/);

  /* 浏览器对 .m4a 常常给不出 MIME（空串 / octet-stream）——那也得收下，
     否则用户拖一个正常的播客音频进来会被判 415。真正把关的是字节签名。 */
  const audioUpload = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("播客.m4a"),
      "x-board-web": "1",
      origin,
    },
    body: m4aBytes,
  });
  assert.equal(audioUpload.status, 201, "认不出 MIME 的音频照样要收");
  const audio = (await audioUpload.json()).upload;
  assert.equal(audio.kind, "audio");
  assert.equal(audio.mediaType, "audio/mp4", "mediaType 按扩展名规范化，不用请求头里那个");

  // 扩展名对、内容不对：签名校验拦下（改后缀混别的东西进来）
  const fakeVideo = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "video/mp4", "x-file-name": encodeURIComponent("假的.mp4"), "x-board-web": "1", origin },
    body: Buffer.from("not a video at all, just text"),
  });
  assert.equal(fakeVideo.status, 415);

  // 不认的扩展名（.exe）连门都进不去
  const badExt = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("坏东西.exe"), "x-board-web": "1", origin },
    body: mp4Bytes,
  });
  assert.equal(badExt.status, 415);

  /* 建卡：**不传** kind / mediaType，服务端按上传件后缀推导（调用方报的值经常是错的） */
  const videoCard = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "media", title: "演示片", file: { uploadId: video.id, name: "演示片.mp4" } },
  });
  assert.equal(videoCard.status, 201);
  assert.equal(videoCard.data.card.file.kind, "video");
  assert.equal(videoCard.data.card.file.mediaType, "video/mp4");
  assert.equal(videoCard.data.card.file.url, `/api/boards/uploads/${video.id}`);
  assert.equal(videoCard.data.card.file.previewUrl, null, "音视频没有图片预览口");
  assert.equal(videoCard.data.card.file.size, mp4Bytes.length, "没传 size 也要按磁盘上的真实大小补齐");
  const videoCardId = videoCard.data.card.id;

  const audioCard = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "media", title: "播客", file: { uploadId: audio.id, name: "播客.m4a", kind: "image" } },
  });
  assert.equal(audioCard.status, 201);
  assert.equal(audioCard.data.card.file.kind, "audio", "调用方写错的 kind 要被后缀推导纠正");

  // 图片 / PDF 的 uploadId 建不成音视频卡，且报错要指路该建哪种
  const wrongKind = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "media", file: { uploadId: pngId } },
  });
  assert.equal(wrongKind.status, 400);
  assert.ok(wrongKind.data.error.includes('"type":"image"'), wrongKind.data.error);

  /* Range 分段：`<video>` 拖进度条就靠它。没有 206，Safari 干脆不播 */
  const ranged = await fetch(`${base}/api/boards/uploads/${video.id}`, { headers: { range: "bytes=4-7" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 4-7/${mp4Bytes.length}`);
  assert.equal(ranged.headers.get("content-length"), "4");
  assert.equal(await ranged.text(), "ftyp");
  const wholeFile = await fetch(`${base}/api/boards/uploads/${video.id}`);
  assert.equal(wholeFile.status, 200);
  assert.equal(wholeFile.headers.get("accept-ranges"), "bytes");
  assert.equal(wholeFile.headers.get("content-type"), "video/mp4");
  const badRange = await fetch(`${base}/api/boards/uploads/${video.id}`, { headers: { range: "bytes=99999-" } });
  assert.equal(badRange.status, 416, "要不出的区间要 416 并带总长，否则播放器会一直重试");
  assert.equal(badRange.headers.get("content-range"), `bytes */${mp4Bytes.length}`);

  // Markdown 导出：公共行给文件名，包给「是音频还是视频」
  const mdWithMedia = await (await fetch(`${base}/api/boards/${boardId}/export?format=md`)).text();
  assert.ok(mdWithMedia.includes("- 文件：演示片.mp4"), "markdown 要带文件名那行公共行");
  assert.ok(mdWithMedia.includes("- 媒体：视频（video/mp4）"), "markdown 导出要带音视频那一行");

  // 收拾干净：这两张卡不留在板上，后面按数量断言的用例不受影响
  for (const id of [videoCardId, audioCard.data.card.id]) {
    assert.equal((await request("DELETE", `/api/boards/${boardId}/cards/${id}`)).status, 200);
  }

  /* 4. 连线 */
  step("edges");
  const edge = await request("POST", `/api/boards/${boardId}/edges`, { body: { from: taskCardId, to: agentCardId, label: "依赖" } });
  assert.equal(edge.status, 201);
  const edgeId = edge.data.edge.id;
  const dupEdge = await request("POST", `/api/boards/${boardId}/edges`, { body: { from: taskCardId, to: agentCardId } });
  assert.equal(dupEdge.status, 409);
  const selfEdge = await request("POST", `/api/boards/${boardId}/edges`, { body: { from: taskCardId, to: taskCardId } });
  assert.equal(selfEdge.status, 400);
  // 新能力：就地改标签（id 不变）
  const relabeled = await request("PATCH", `/api/boards/${boardId}/edges/${edgeId}`, { body: { label: "强依赖" } });
  assert.equal(relabeled.status, 200);
  assert.equal(relabeled.data.edge.id, edgeId);
  assert.equal(relabeled.data.edge.label, "强依赖");

  /* 5. 部分更新 + 批量几何 */
  step("patch-state");
  const moved = await request("PATCH", `/api/boards/${boardId}/cards/${taskCardId}`, { body: { x: 300, y: 400, task: { status: "issued", issueId: "issue-0", issueNumber: "ISSUE-99" } } });
  assert.equal(moved.data.card.x, 300);
  assert.equal(moved.data.card.task.status, "issued");

  const state = await request("PUT", `/api/boards/${boardId}/state`, {
    body: { viewport: { x: 120, y: -40, zoom: 1.5 }, cards: [{ id: taskCardId, x: 310, y: 410, w: 320, h: 190, z: 5 }, { id: "c_ghost", x: 0, y: 0 }] },
  });
  assert.equal(state.data.applied, 1);
  const detail = await request("GET", `/api/boards/${boardId}`);
  assert.equal(detail.data.board.viewport.zoom, 1.5);
  assert.equal(detail.data.board.cards.find((card) => card.id === taskCardId).z, 5);
  assert.ok(detail.data.board.cards.every((card) => !card.file?.path), "不应下发本机绝对路径");

  /* 6. 转 Issue / 发起任务 */
  step("issue-launch");
  const notTask = await request("POST", `/api/boards/${boardId}/cards/${agentCardId}/issue`);
  assert.equal(notTask.status, 400);

  const freshTask = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "task", title: "写选题脚本", task: { goal: "围绕新书完成 3 版脚本" } } });
  const freshTaskId = freshTask.data.card.id;
  const issued = await request("POST", `/api/boards/${boardId}/cards/${freshTaskId}/issue`);
  assert.equal(issued.status, 201);
  assert.equal(issued.data.issue.id, "issue-1");
  assert.equal(issued.data.issue.number, "ISSUE-101");
  assert.equal(issued.data.card.task.status, "issued");

  // 画板上下文注入
  {
    const upstream = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "quote", title: "上游想法", content: "先把素材盘一遍" } });
    await request("POST", `/api/boards/${boardId}/edges`, { body: { from: upstream.data.card.id, to: freshTaskId, label: "依据" } });
    const downstream = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "text", title: "下游产出", content: "产出一份书单" } });
    await request("POST", `/api/boards/${boardId}/edges`, { body: { from: freshTaskId, to: downstream.data.card.id } });
    const reissued = await request("POST", `/api/boards/${boardId}/cards/${freshTaskId}/issue`);
    assert.equal(reissued.status, 200);
    const ctxTask = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "task", title: "带上下文的任务", task: { goal: "执行这件事" } } });
    await request("POST", `/api/boards/${boardId}/edges`, { body: { from: upstream.data.card.id, to: ctxTask.data.card.id } });
    await request("POST", `/api/boards/${boardId}/edges`, { body: { from: ctxTask.data.card.id, to: downstream.data.card.id } });
    const ctxIssued = await request("POST", `/api/boards/${boardId}/cards/${ctxTask.data.card.id}/issue`);
    assert.equal(ctxIssued.status, 201);
    assert.ok(lastIssueDescription.includes("画板上下文"), "description 应包含画板上下文标记");
    assert.ok(lastIssueDescription.includes("上游关联节点"), "description 应包含上游节点段");
    assert.ok(lastIssueDescription.includes("先把素材盘一遍"), "description 应包含上游卡片内容");
    assert.ok(lastIssueDescription.includes("下游关联节点"), "description 应包含下游节点段");
    assert.ok(lastIssueDescription.includes("产出一份书单"), "description 应包含下游卡片内容");
  }

  const again = await request("POST", `/api/boards/${boardId}/cards/${freshTaskId}/issue`);
  assert.equal(again.status, 200);
  assert.equal(again.data.alreadyIssued, true);
  assert.equal(issueCreateCount, 2);

  /* 6.5 转 Issue 之后的自动同步（画板 → Goal Agent 单向） */
  step("issue-sync");
  {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const settle = async () => {
      // 防抖压到了 120ms，留够一次落地 + 一次 Runner 往返的余量
      await wait(400);
    };
    const patchesOf = (id) => issuePatches.filter((item) => item.id === id);

    // 转过 Issue 的卡改了正文 → 自动把最新的推过去
    const before = patchesOf("issue-1").length;
    await request("PATCH", `/api/boards/${boardId}/cards/${freshTaskId}`, {
      body: { task: { goal: "围绕新书完成 5 版脚本，其中 2 版走口播" } },
    });
    await settle();
    const afterEdit = patchesOf("issue-1");
    assert.ok(afterEdit.length > before, "改完卡片应自动同步一次 Issue");
    assert.ok(
      afterEdit[afterEdit.length - 1].body.description.includes("5 版脚本"),
      "推过去的 description 应该是卡片的最新正文",
    );

    // 只改颜色 / 位置这类跟 Issue 无关的字段：指纹没变，不该打扰 Runner
    const beforeColor = patchesOf("issue-1").length;
    await request("PATCH", `/api/boards/${boardId}/cards/${freshTaskId}`, { body: { color: "violet" } });
    await settle();
    assert.equal(patchesOf("issue-1").length, beforeColor, "改颜色不该触发 Issue 同步");

    // 卡上新加的评论是「画板上标出来要改的地方」，也要跟着推过去
    const beforeNote = patchesOf("issue-1").length;
    const note = await request("POST", `/api/boards/${boardId}/comments`, {
      body: { target: "card", targetId: freshTaskId, text: "口播那版先做" },
    });
    await settle();
    const afterNote = patchesOf("issue-1");
    assert.ok(afterNote.length > beforeNote, "加评论应触发一次 Issue 同步");
    assert.ok(afterNote[afterNote.length - 1].body.description.includes("口播那版先做"), "评论应进 description");
    // 收拾干净：下面的评论用例按数量断言，这条临时评论不能留在板上
    await request("DELETE", `/api/boards/${boardId}/comments/${note.data.comment.id}`);
    await settle();

    // 手动「同步正文」：force，指纹没变也真发一次
    const beforeManual = patchesOf("issue-1").length;
    const manual = await request("PUT", `/api/boards/${boardId}/cards/${freshTaskId}/issue`, { body: { force: true } });
    assert.equal(manual.status, 200);
    assert.equal(manual.data.synced, true);
    assert.equal(patchesOf("issue-1").length, beforeManual + 1);
    assert.ok(manual.data.card.task.issueSyncedAt > 0, "同步时间应写回卡片");
    assert.equal(manual.data.card.task.issueSyncError, null);

    // 没转过 Issue 的卡片：这条口直接 404，不要静默成功
    const noIssue = await request("PUT", `/api/boards/${boardId}/cards/${agentCardId}/issue`, { body: {} });
    assert.equal(noIssue.status, 404);

    // 板级扫一遍：全都是刚推过的那一版，应该全被指纹挡掉
    const sweep = await request("POST", `/api/boards/${boardId}/issue-sync`, { body: {} });
    assert.equal(sweep.status, 200);
    assert.ok(sweep.data.skipped >= 1, "内容没变的卡片应被跳过");
    assert.equal(sweep.data.failed, 0);

    // 同步账本读得到
    const status = await request("GET", `/api/boards/${boardId}/issue-sync`);
    assert.equal(status.status, 200);
    assert.equal(status.data.mode, "auto");
    assert.ok(status.data.cards.some((item) => item.cardId === freshTaskId && item.syncedAt > 0));

    // 关掉自动同步：改了卡片不再自动推（下面的发起任务会验证「关了也仍然兜底推一次」）
    await request("PATCH", `/api/boards/${boardId}`, { body: { settings: { issueSync: "off" } } });
    const beforeOff = patchesOf("issue-1").length;
    await request("PATCH", `/api/boards/${boardId}/cards/${freshTaskId}`, {
      body: { task: { goal: "关掉自动同步之后改的这一版" } },
    });
    await settle();
    assert.equal(patchesOf("issue-1").length, beforeOff, "关掉之后不该再自动推");
    const offSweep = await request("POST", `/api/boards/${boardId}/issue-sync`, { body: {} });
    assert.equal(offSweep.data.disabled, true);
  }

  step("issue-launch");
  const beforeLaunch = issuePatches.filter((item) => item.id === "issue-1").length;
  const launched = await request("POST", `/api/boards/${boardId}/cards/${freshTaskId}/launch`, { body: { mode: "implement" } });
  assert.equal(launched.status, 201);
  assert.equal(launched.data.card.task.status, "running");
  assert.equal(launched.data.card.task.taskId, "task-issue-1");
  assert.deepEqual(launchCalls.map((call) => call.id), ["issue-1"]);
  // 发起任务前必须先把最新内容推过去（自动同步关着也一样）：
  // agent 读的是 Goal Agent 里存着的那份 Issue，不能带着旧需求开工
  const launchPatches = issuePatches.filter((item) => item.id === "issue-1");
  assert.equal(launchPatches.length, beforeLaunch + 1, "发起任务前应先同步一次 Issue");
  assert.ok(
    launchPatches[launchPatches.length - 1].body.description.includes("关掉自动同步之后改的这一版"),
    "发起任务用的应该是卡片当下的正文",
  );
  await request("PATCH", `/api/boards/${boardId}`, { body: { settings: { issueSync: "auto" } } });

  /* 7. 跨画板任务聚合 */
  step("tasks-view");
  const second = await request("POST", "/api/boards", { body: { name: "第二块板" } });
  const secondId = second.data.board.id;
  await request("POST", `/api/boards/${secondId}/cards`, { body: { type: "task", title: "另一件事" } });
  const tasks = await request("GET", "/api/boards/tasks");
  assert.equal(tasks.data.total, 4);
  assert.ok(tasks.data.tasks.every((item) => item.boardName));

  /* 7.5 跨画板全文搜索 */
  step("search");
  const todoCard = await request("POST", `/api/boards/${secondId}/cards`, {
    body: { type: "todo", title: "收集箱", todo: { items: [{ text: "联系切片剪辑供应商", done: false }] } },
  });
  assert.equal(todoCard.status, 201);
  const found = await request("GET", `/api/boards/search?q=${encodeURIComponent("切片")}`);
  assert.equal(found.status, 200);
  const mainHit = found.data.boards.find((item) => item.id === boardId);
  assert.ok(mainHit, "内容命中应包含主画板");
  assert.ok(mainHit.cardTotal >= 2, `主画板应至少命中 2 张卡，实际 ${mainHit?.cardTotal}`);
  assert.ok(mainHit.cards.every((card) => card.snippet.includes("切片")));
  const todoHit = found.data.boards.find((item) => item.id === secondId);
  assert.ok(todoHit, "待办条目文本也应参与搜索");
  const byName = await request("GET", `/api/boards/search?q=${encodeURIComponent("脑暴")}`);
  assert.ok(byName.data.boards.some((item) => item.id === boardId && item.nameHit), "板名应参与匹配");
  const emptyQuery = await request("GET", "/api/boards/search?q=");
  assert.equal(emptyQuery.data.boards.length, 0);

  /* 7.6 跨画板卡片索引（卡片导航页 /nav 的数据源） */
  step("card-index");
  await request("PATCH", `/api/boards/${secondId}`, { body: { group: "导航测试组" } });
  const indexAll = await request("GET", "/api/boards/cards");
  assert.equal(indexAll.status, 200);
  assert.ok(indexAll.data.total >= 5, `索引应覆盖全部卡片，实际 ${indexAll.data.total}`);
  assert.equal(indexAll.data.cards.length, indexAll.data.total);
  assert.ok(indexAll.data.cards.every((card) => card.boardId && card.boardName && typeof card.updatedAt === "number"));
  // 默认排序：更新时间新 → 旧
  const times = indexAll.data.cards.map((card) => card.updatedAt);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "默认应按更新时间倒序");
  // 旧 → 新 是同一批卡，只是掉个头
  const asc = await request("GET", "/api/boards/cards?sort=created&order=asc");
  const createdTimes = asc.data.cards.map((card) => card.createdAt);
  assert.deepEqual(createdTimes, [...createdTimes].sort((a, b) => a - b), "asc 应按创建时间正序");
  assert.equal(asc.data.total, indexAll.data.total);
  // 分组 / 单板收窄
  const byGroup = await request("GET", `/api/boards/cards?group=${encodeURIComponent("导航测试组")}`);
  assert.ok(byGroup.data.total > 0);
  assert.ok(byGroup.data.cards.every((card) => card.boardId === secondId && card.group === "导航测试组"));
  const byBoard = await request("GET", `/api/boards/cards?board=${secondId}`);
  assert.equal(byBoard.data.total, byGroup.data.total);
  // 空串分组 = 未分组那一撮，跟不带 group 是两回事
  const ungrouped = await request("GET", "/api/boards/cards?group=");
  assert.ok(ungrouped.data.cards.every((card) => card.group === ""));
  assert.equal(ungrouped.data.total + byGroup.data.total, indexAll.data.total);
  // 关键词 + 类型筛选；类型计数不受类型筛选影响
  const byQuery = await request("GET", `/api/boards/cards?q=${encodeURIComponent("切片")}`);
  assert.ok(byQuery.data.total >= 2, `关键词应命中至少 2 张，实际 ${byQuery.data.total}`);
  const byType = await request("GET", "/api/boards/cards?types=todo");
  assert.ok(byType.data.cards.every((card) => card.type === "todo"));
  assert.equal(byType.data.total, indexAll.data.typeCounts.todo);
  assert.deepEqual(byType.data.typeCounts, indexAll.data.typeCounts, "类型计数统计在类型筛选之前");
  // 翻页
  const indexPage = await request("GET", "/api/boards/cards?limit=2&offset=1");
  assert.equal(indexPage.data.cards.length, 2);
  assert.equal(indexPage.data.total, indexAll.data.total);
  assert.equal(indexPage.data.cards[0].id, indexAll.data.cards[1].id);
  await request("PATCH", `/api/boards/${secondId}`, { body: { group: "" } });

  /* 8. 删除级联 */
  step("delete");
  const removedCard = await request("DELETE", `/api/boards/${boardId}/cards/${agentCardId}`);
  assert.equal(removedCard.status, 200);
  const after = await request("GET", `/api/boards/${boardId}`);
  assert.ok(!after.data.board.cards.some((card) => card.id === agentCardId));
  assert.ok(!after.data.board.edges.some((item) => item.from === agentCardId || item.to === agentCardId));

  await request("DELETE", `/api/boards/${secondId}`);
  list = await request("GET", "/api/boards");
  assert.equal(list.data.boards.length, 1);

  /* 8.4b 类型互转 */
  step("type-convert");
  const ideaCard = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "text", title: "试试类型互转", content: "把这条想法变成任务" } });
  const ideaCardId = ideaCard.data.card.id;
  const asTask = await request("PATCH", `/api/boards/${boardId}/cards/${ideaCardId}`, {
    body: { type: "task", task: { goal: "把这条想法变成任务并落地", priority: "medium" } },
  });
  assert.equal(asTask.status, 200);
  assert.equal(asTask.data.card.type, "task");
  assert.equal(asTask.data.card.task.status, "idea");
  assert.equal(asTask.data.card.task.goal, "把这条想法变成任务并落地");
  assert.equal(asTask.data.card.content, "把这条想法变成任务");
  const backToText = await request("PATCH", `/api/boards/${boardId}/cards/${ideaCardId}`, { body: { type: "text" } });
  assert.equal(backToText.data.card.type, "text");
  const badConvert = await request("PATCH", `/api/boards/${boardId}/cards/${ideaCardId}`, { body: { type: "image" } });
  assert.equal(badConvert.status, 400);

  /* 8.4c 外部直写文件后 mtime 感知（存储是一板一文件，直接改那块板的文件） */
  step("mtime");
  const boardFile = path.join(dataDir, "boards", `${boardId}.json`);
  const targetBoard = JSON.parse(fs.readFileSync(boardFile, "utf8"));
  targetBoard.cards.push({
    id: "c_external_write", type: "text", title: "外部直写的卡", content: "绕过 API 直接改文件",
    x: 9, y: 9, w: 280, h: 170, z: 1, color: "slate", createdAt: 1, updatedAt: 1, createdBy: "agent",
  });
  targetBoard.updatedAt = Date.now();
  const tmpWrite = `${boardFile}.ext.tmp`;
  fs.writeFileSync(tmpWrite, JSON.stringify(targetBoard));
  fs.renameSync(tmpWrite, boardFile);
  const afterExternal = await request("GET", `/api/boards/${boardId}`);
  assert.ok(
    afterExternal.data.board.cards.some((card) => card.id === "c_external_write" && card.title === "外部直写的卡"),
    "mtime 检测应让外部写入立即可见",
  );
  await request("PATCH", `/api/boards/${boardId}/cards/${ideaCardId}`, { body: { title: "互转后又改" } });
  const afterMutate = await request("GET", `/api/boards/${boardId}`);
  assert.ok(afterMutate.data.board.cards.some((card) => card.id === "c_external_write"), "本进程保存不应覆盖外部写入");
  assert.ok(afterMutate.data.board.cards.some((card) => card.id === ideaCardId && card.title === "互转后又改"));

  /* 8.5 whole 全量替换 */
  step("whole");
  const before = await request("GET", `/api/boards/${boardId}`);
  const cardsSnapshot = before.data.board.cards.map((card) => ({ ...card }));
  const edgesSnapshot = before.data.board.edges.map((e) => ({ from: e.from, to: e.to, label: e.label }));
  const whole = await request("PUT", `/api/boards/${boardId}/whole`, {
    body: {
      name: "全量替换后",
      viewport: { x: 10, y: 20, zoom: 1.25 },
      cards: [...cardsSnapshot, { id: "c_from_config", type: "text", title: "配置加的卡", content: "whole 写入", x: 800, y: 50 }],
      edges: [...edgesSnapshot, { from: "c_from_config", to: taskCardId }, { from: "c_ghost", to: taskCardId }],
    },
  });
  assert.equal(whole.status, 200);
  assert.equal(whole.data.board.name, "全量替换后");
  assert.equal(whole.data.board.cards.length, cardsSnapshot.length + 1);
  assert.ok(whole.data.board.cards.some((card) => card.id === "c_from_config" && card.title === "配置加的卡"));
  assert.ok(whole.data.board.cards.some((card) => card.id === taskCardId));
  assert.equal(whole.data.board.edges.length, edgesSnapshot.length + 1);
  assert.equal(whole.data.board.viewport.zoom, 1.25);
  const badWhole = await request("PUT", `/api/boards/${boardId}/whole`, { body: { cards: "nope" } });
  assert.equal(badWhole.status, 400);

  /* 8.54 分组框（frame）：归属 / 解除 / 删框不删子卡 / 不许嵌套 / 整理跳过框里的卡 */
  step("frames");
  {
    const fb = (await request("POST", "/api/boards", { body: { name: "分组框实验板" } })).data.board.id;
    const mk = async (body) => (await request("POST", `/api/boards/${fb}/cards`, { body })).data;
    const frame = (await mk({ type: "frame", title: "第三季度", x: 0, y: 0, w: 600, h: 400 })).card;
    assert.equal(frame.type, "frame");
    assert.equal(frame.frame.collapsed, false, "框默认展开");
    assert.equal(frame.frameId, null, "框自己不归属任何框");

    // 归属：frameId 指向框
    const inside = (await mk({ type: "text", title: "框里的", x: 40, y: 60, frameId: frame.id })).card;
    assert.equal(inside.frameId, frame.id);
    const outside = (await mk({ type: "text", title: "框外的", x: 900, y: 60 })).card;
    assert.equal(outside.frameId, null, "没给 frameId 就是自由卡");

    // 闸门：指向不存在的卡 404、指向不是框的卡 400、框套框 400
    assert.equal((await mk({ type: "text", title: "坏归属", frameId: "c_nope" })).ok, false);
    const badTarget = await request("POST", `/api/boards/${fb}/cards`, {
      body: { type: "text", title: "指向普通卡", frameId: outside.id },
    });
    assert.equal(badTarget.status, 400);
    assert.ok(badTarget.data.error.includes("分组框"), badTarget.data.error);
    const nested = await request("POST", `/api/boards/${fb}/cards`, {
      body: { type: "frame", title: "套娃", frameId: frame.id },
    });
    assert.equal(nested.status, 400);
    assert.ok(nested.data.error.includes("子画板"), "拒绝嵌套时要指路到 board 卡");

    // 解除：传 null
    const released = await request("PATCH", `/api/boards/${fb}/cards/${inside.id}`, { body: { frameId: null } });
    assert.equal(released.data.card.frameId, null);
    await request("PATCH", `/api/boards/${fb}/cards/${inside.id}`, { body: { frameId: frame.id } });

    // 折叠是框自己的一个布尔，子卡一个字段不动
    const folded = await request("PATCH", `/api/boards/${fb}/cards/${frame.id}`, { body: { frame: { collapsed: true } } });
    assert.equal(folded.data.card.frame.collapsed, true);
    assert.equal(
      (await request("GET", `/api/boards/${fb}`)).data.board.cards.find((card) => card.id === inside.id).frameId,
      frame.id,
      "折叠不该动子卡的归属",
    );

    // 整理跳过框与框里的卡：只有框外那张会被挪
    const beforeXY = (await request("GET", `/api/boards/${fb}`)).data.board.cards.map((card) => `${card.id}:${card.x},${card.y}`);
    await request("POST", `/api/boards/${fb}/tidy`, { body: { mode: "grid" } });
    const afterCards = (await request("GET", `/api/boards/${fb}`)).data.board.cards;
    const afterXY = afterCards.map((card) => `${card.id}:${card.x},${card.y}`);
    const stillPut = new Set([frame.id, inside.id]);
    for (const card of afterCards) {
      const was = beforeXY.find((entry) => entry.startsWith(`${card.id}:`));
      const now = afterXY.find((entry) => entry.startsWith(`${card.id}:`));
      if (stillPut.has(card.id)) assert.equal(now, was, `整理不该动框与框里的卡：${card.id}`);
    }

    // 删框不删子卡：子卡留在板上，只是不再归属
    await request("DELETE", `/api/boards/${fb}/cards/${frame.id}`);
    const afterDelete = (await request("GET", `/api/boards/${fb}`)).data.board.cards;
    assert.ok(afterDelete.some((card) => card.id === inside.id), "删框不该把框里的卡一起删了");
    assert.equal(afterDelete.find((card) => card.id === inside.id).frameId, null, "只是解除归属");

    // whole 里带悬空 frameId：清成 null 而不是报错（收卡宽）
    const wholeFrame = await request("PUT", `/api/boards/${fb}/whole`, {
      body: {
        cards: [
          { id: "c_frame_w", type: "frame", title: "新框", x: 0, y: 0, w: 500, h: 300 },
          { id: "c_in_w", type: "text", title: "在新框里", x: 30, y: 40, frameId: "c_frame_w" },
          { id: "c_bad_w", type: "text", title: "指向不存在的框", x: 700, y: 40, frameId: "c_gone" },
        ],
      },
    });
    assert.equal(wholeFrame.status, 200);
    const byId = Object.fromEntries(wholeFrame.data.board.cards.map((card) => [card.id, card]));
    assert.equal(byId.c_in_w.frameId, "c_frame_w", "整板改写认得住合法归属");
    assert.equal(byId.c_bad_w.frameId, null, "悬空归属清成 null，不打回整板");

    // 信封不收 frame（frameId 是本板内主键，换台机器指不到）
    const envFrame = await request("POST", `/api/boards/${fb}/ingest`, {
      body: { format: "blotboard.cards", version: 1, cards: [{ type: "frame", title: "信封里的框" }] },
    });
    assert.equal(envFrame.status, 409);
    assert.ok(envFrame.data.error.includes("不能用信封导入"), envFrame.data.error);

    // 导出：md 与 HTML 都要提一句这是个框
    const frameMd = await request("GET", `/api/boards/${fb}/export?format=md`);
    assert.ok(String(frameMd.data).includes("分组框"), "md 导出要认得分组框");
    const frameHtml = await request("GET", `/api/boards/${fb}/export?format=html`);
    assert.ok(String(frameHtml.data).includes("圈了 1 张卡片"), "HTML 导出里框要报出成员数");

    await request("DELETE", `/api/boards/${fb}`);
  }

  /* 8.545 阅读例外（card.reading）：归一化 / 清掉 / 透传往返 / 章节与显式序号影响导出顺序。
     默认（谁都不设）必须与从前逐张一致——这一条是整块功能的兼容前提。 */
  step("reading-order");
  {
    const rb = (await request("POST", "/api/boards", { body: { name: "阅读顺序实验板" } })).data.board.id;
    const mk = async (body) => (await request("POST", `/api/boards/${rb}/cards`, { body })).data.card;

    // 归一化：没设过就**不留字段**（板文件里不该平白多一层空壳）
    const plain = await mk({ type: "text", title: "普通卡", x: 0, y: 0 });
    assert.equal(plain.reading, undefined, "没设阅读例外就不该有这个字段");
    const skipped = await mk({ type: "text", title: "跳过卡", x: 0, y: 400, reading: { skip: true } });
    assert.deepEqual(skipped.reading, { skip: true });
    const numbered = await mk({ type: "text", title: "序号卡", x: 0, y: 800, reading: { order: 3, skip: false } });
    assert.deepEqual(numbered.reading, { order: 3 }, "skip=false 不留下来，只留真正设过的那项");
    // 写坏的值不落库（order 必须是有限数）
    const junk = await mk({ type: "text", title: "坏例外", x: 0, y: 1200, reading: { order: "很靠前" } });
    assert.equal(junk.reading, undefined);

    // 清掉：传 null / 空对象，字段整个删掉
    const cleared = await request("PATCH", `/api/boards/${rb}/cards/${skipped.id}`, { body: { reading: null } });
    assert.equal(cleared.data.card.reading, undefined, "传 null 要把整个字段删掉，不是留一层空壳");
    await request("PATCH", `/api/boards/${rb}/cards/${skipped.id}`, { body: { reading: { skip: true } } });

    // 透传铁律：未知类型的卡也带得住这个公共字段
    const ghost = await request("PUT", `/api/boards/${rb}/whole`, {
      body: {
        cards: [
          { id: "c_ghost_r", type: "not_a_pack", title: "未知类型", x: 0, y: 0, reading: { skip: true, order: 9 }, weird: { keep: 1 } },
        ],
      },
    });
    const ghostCard = ghost.data.board.cards.find((card) => card.id === "c_ghost_r");
    assert.deepEqual(ghostCard.reading, { skip: true, order: 9 }, "未知类型的卡也留得住阅读例外");
    assert.deepEqual(ghostCard.weird, { keep: 1 }, "专属字段照旧只存不洗");

    // 阅读顺序（排版导出与阅读模式同一份 readingOrder）：
    // ① 默认按位置；② 分组框读成一章，成员紧跟其后；③ 显式序号排到最前
    const order = await request("PUT", `/api/boards/${rb}/whole`, {
      body: {
        cards: [
          { id: "c_r_frame", type: "frame", title: "章节甲", x: 0, y: 0, w: 600, h: 400 },
          { id: "c_r_in1", type: "text", title: "甲之一", x: 40, y: 60, w: 200, h: 120, frameId: "c_r_frame" },
          { id: "c_r_in2", type: "text", title: "甲之二", x: 300, y: 60, w: 200, h: 120, frameId: "c_r_frame" },
          { id: "c_r_free", type: "text", title: "框外的卡", x: 800, y: 40, w: 200, h: 120 },
          { id: "c_r_first", type: "text", title: "开场白", x: 800, y: 900, w: 200, h: 120, reading: { order: 1 } },
        ],
      },
    });
    assert.equal(order.status, 200);
    const html = String((await request("GET", `/api/boards/${rb}/export?format=html`)).data);
    const at = (title) => html.indexOf(title);
    assert.ok(at("开场白") < at("章节甲"), "设了序号的卡排到最前");
    assert.ok(at("章节甲") < at("甲之一") && at("甲之一") < at("甲之二"), "框是一章，成员紧跟在它后面");
    assert.ok(at("甲之二") < at("框外的卡"), "读完一章再读框外的卡，不按 y 坐标穿插");

    // 不变量：一张都不丢——归属指向一个不存在的框时按自由卡读到
    const dangling = await request("PUT", `/api/boards/${rb}/whole`, {
      body: {
        cards: [
          { id: "c_r_lost", type: "text", title: "悬空归属的卡", x: 20, y: 20, w: 200, h: 120, frameId: "c_gone_frame" },
          { id: "c_r_other", type: "text", title: "另一张", x: 20, y: 400, w: 200, h: 120 },
        ],
      },
    });
    assert.equal(dangling.status, 200);
    const danglingHtml = String((await request("GET", `/api/boards/${rb}/export?format=html`)).data);
    assert.ok(danglingHtml.includes("悬空归属的卡"), "章节找不到时那张卡也不能从阅读顺序里消失");

    await request("DELETE", `/api/boards/${rb}`);
  }

  /* 8.55 改板安全网：批量写自动打点 → 列表 → 回滚（回滚前也打点）→ 保留上限滚动 → 工作日志 */
  step("checkpoints");
  const cpBoard = (await request("POST", "/api/boards", { body: { name: "快照实验板" } })).data.board.id;

  // 单卡建卡**不该**打点（那条路有编辑抽屉的自动保存与删除撤销，见 lib/checkpoints.ts 抬头）
  const cpCardA = (await request("POST", `/api/boards/${cpBoard}/cards`, { body: { type: "text", title: "原始 A" } })).data.card.id;
  const cpCardB = (await request("POST", `/api/boards/${cpBoard}/cards`, { body: { type: "text", title: "原始 B" } })).data.card.id;
  const cpEmpty = await request("GET", `/api/boards/${cpBoard}/checkpoints`);
  assert.equal(cpEmpty.status, 200);
  assert.equal(cpEmpty.data.enabled, true);
  assert.equal(cpEmpty.data.keep, 5);
  assert.equal(cpEmpty.data.checkpoints.length, 0, "单卡建卡不打点");
  assert.deepEqual((await request("GET", `/api/boards/${cpBoard}/activity`)).data.activity, [], "单卡建卡不记日志");

  // 纯几何（PUT /state）也不打点：拖一次卡就写一次，安全网会先把磁盘吃光
  await request("PUT", `/api/boards/${cpBoard}/state`, { body: { cards: [{ id: cpCardA, x: 12, y: 34 }] } });
  assert.equal((await request("GET", `/api/boards/${cpBoard}/checkpoints`)).data.checkpoints.length, 0, "PUT /state 不打点");

  // 批量写（whole）：动手前那一刻要被存下来
  const cpWhole = await request("PUT", `/api/boards/${cpBoard}/whole`, {
    headers: AGENT(RUNNER_TOKEN),
    body: { cards: [{ id: cpCardA, type: "text", title: "只剩 A 了" }] },
  });
  assert.equal(cpWhole.status, 200);
  assert.equal(cpWhole.data.board.cards.length, 1, "whole 之后板上只剩一张");
  const cpAfterWhole = await request("GET", `/api/boards/${cpBoard}/checkpoints`);
  assert.equal(cpAfterWhole.data.checkpoints.length, 1, "whole 之前要自动打一份点");
  const wholeStamp = cpAfterWhole.data.checkpoints[0].stamp;
  assert.equal(cpAfterWhole.data.checkpoints[0].reason, "whole");
  assert.equal(cpAfterWhole.data.checkpoints[0].counts.cards, 2, "快照里是改之前的两张卡");
  assert.ok(cpAfterWhole.data.checkpoints[0].bytes > 0);
  assert.ok(cpAfterWhole.data.checkpoints[0].at > 0);

  // 工作日志：actor 从鉴权通道推断（这次带的是 x-auth-key → agent）
  const cpLog = await request("GET", `/api/boards/${cpBoard}/activity`);
  assert.equal(cpLog.data.activity.length, 1);
  assert.equal(cpLog.data.activity[0].actor, "agent", "带 x-auth-key 的算 agent");
  assert.equal(cpLog.data.activity[0].action, "whole");
  assert.equal(cpLog.data.activity[0].checkpoint, wholeStamp, "日志要指向它对应的那份快照");
  assert.ok(cpLog.data.activity[0].summary.includes("2"), cpLog.data.activity[0].summary);
  // 整板 GET 里也带同一份（历史抽屉不用再打一次口）
  assert.equal((await request("GET", `/api/boards/${cpBoard}`)).data.board.activity.length, 1);

  // 回滚：整块板换回去，且**回滚前的现状**也要被存成一份新快照（否则回滚没有回头路）
  const cpRestored = await request("POST", `/api/boards/${cpBoard}/checkpoints/${wholeStamp}/restore`);
  assert.equal(cpRestored.status, 200);
  assert.equal(cpRestored.data.restored, wholeStamp);
  assert.equal(cpRestored.data.board.cards.length, 2, "回滚后两张卡都回来了");
  assert.ok(cpRestored.data.board.cards.some((card) => card.id === cpCardB), "被 whole 删掉的那张回来了");
  assert.ok(cpRestored.data.checkpoint && cpRestored.data.checkpoint !== wholeStamp, "回滚前要再打一份点");
  const cpAfterRestore = await request("GET", `/api/boards/${cpBoard}/checkpoints`);
  assert.equal(cpAfterRestore.data.checkpoints.length, 2);
  assert.equal(cpAfterRestore.data.checkpoints[0].reason, "restore", "最新那份是回滚前存下来的");
  assert.equal(cpAfterRestore.data.checkpoints[0].counts.cards, 1, "它记的是回滚前（只剩一张）的样子");
  const restoreLog = (await request("GET", `/api/boards/${cpBoard}/activity`)).data.activity;
  assert.equal(restoreLog[0].action, "restore");
  assert.equal(restoreLog[0].actor, "user", "浏览器头（x-board-web）算 user");

  // 回滚不该把工作日志抹掉：它是服务端单向写的表，快照里那份旧 activity 不覆盖现在的
  assert.ok(restoreLog.length >= 2, `回滚后日志要接着往上加，现在 ${restoreLog.length} 条`);

  // whole 不误伤 activity：body 里显式塞一个假 activity，服务端一律不认
  await request("PUT", `/api/boards/${cpBoard}/whole`, {
    body: { cards: [{ id: cpCardA, type: "text", title: "再改一次" }], activity: [{ at: 1, actor: "agent", action: "whole", summary: "伪造的" }] },
  });
  const forged = (await request("GET", `/api/boards/${cpBoard}/activity`)).data.activity;
  assert.ok(!forged.some((entry) => entry.summary === "伪造的"), "请求体里的 activity 一律忽略");
  assert.ok(forged.length >= 3, "自己那条照常记上");

  // 保留上限滚动：再打几次点，只留最近 5 份，最旧的（那份 whole）被挤掉
  for (let i = 0; i < 4; i += 1) {
    // 每次先扰动坐标，确保整理有实际变化；空操作不应消耗快照。
    await request("PUT", `/api/boards/${cpBoard}/state`, { body: { cards: [{ id: cpCardA, x: 151 + i * 31, y: 179 }] } });
    await request("POST", `/api/boards/${cpBoard}/tidy`, { body: { mode: "grid" } });
  }
  const cpRolled = await request("GET", `/api/boards/${cpBoard}/checkpoints`);
  assert.equal(cpRolled.data.checkpoints.length, 5, `保留上限 5，现在 ${cpRolled.data.checkpoints.length} 份`);
  assert.ok(!cpRolled.data.checkpoints.some((item) => item.stamp === wholeStamp), "超出上限时删最旧的那份");
  // 清单是按时间倒序的
  const stamps = cpRolled.data.checkpoints.map((item) => item.stamp);
  assert.deepEqual(stamps, [...stamps].sort().reverse(), "清单最新在前");

  // 删一份 + 回滚一个不存在的 stamp
  const cpDropped = await request("DELETE", `/api/boards/${cpBoard}/checkpoints/${stamps[4]}`);
  assert.equal(cpDropped.status, 200);
  assert.equal((await request("GET", `/api/boards/${cpBoard}/checkpoints`)).data.checkpoints.length, 4);
  assert.equal((await request("POST", `/api/boards/${cpBoard}/checkpoints/${stamps[4]}/restore`)).status, 404);
  // 路径参数要过闸：`..` 之类不能拼进文件路径
  assert.equal((await request("POST", `/api/boards/${cpBoard}/checkpoints/..%2F..%2Fboards/restore`)).status, 400);
  // 写操作照常要鉴权
  assert.equal(
    (await request("POST", `/api/boards/${cpBoard}/checkpoints/${stamps[0]}/restore`, { headers: { "content-type": "application/json" } })).status,
    403,
  );

  // 日志上限：写 50 条以上只留最近 50
  assert.ok((await request("GET", `/api/boards/${cpBoard}/activity`)).data.activity.length <= 50);

  await request("DELETE", `/api/boards/${cpBoard}`);

  /* 8.6 任务状态批量查询 */
  step("task-status");
  const taskStatus = await request("GET", `/api/boards/${boardId}/task-status`);
  assert.equal(taskStatus.status, 200);
  const freshStatus = taskStatus.data.statuses[freshTaskId];
  assert.equal(freshStatus.taskId, "task-issue-1");
  assert.equal(freshStatus.status, "running");
  assert.ok(freshStatus.summary.includes("整理完成"));

  /* 9. Runner 代理白名单 */
  step("runner-proxy");
  const taskProxy = await request("GET", "/api/runner/tasks/task-issue-1");
  assert.equal(taskProxy.status, 200);
  assert.equal(taskProxy.data.task.status, "running");
  const dispatch = await request("POST", "/api/runner/tasks", { body: { goal: "整理画板布局" } });
  assert.equal(dispatch.status, 200);
  assert.equal(dispatchedTasks.length, 1);
  assert.equal(dispatchedTasks[0].goal, "整理画板布局");
  const notAllowed = await request("GET", "/api/runner/settings");
  assert.equal(notAllowed.status, 404);
  const anonymousDispatch = await request("POST", "/api/runner/tasks", {
    headers: { "content-type": "application/json" },
    body: { goal: "匿名派任务" },
  });
  assert.equal(anonymousDispatch.status, 403);

  /* 9.5 自定义 Agent 指令 */
  step("agent-commands");
  const builtinList = await request("GET", "/api/agent-commands");
  assert.equal(builtinList.status, 200);
  assert.equal(builtinList.data.commands.length, 5);
  assert.ok(builtinList.data.commands.every((command) => command.builtin));
  assert.ok(builtinList.data.commands[0].prompt.includes("{boardId}"), "内置指令正文应带占位符");

  const anonymousCommand = await request("POST", "/api/agent-commands", {
    headers: { "content-type": "application/json" },
    body: { title: "匿名不该建成", prompt: "x" },
  });
  assert.equal(anonymousCommand.status, 403);

  const emptyTitle = await request("POST", "/api/agent-commands", { body: { title: "  ", prompt: "有正文没标题" } });
  assert.equal(emptyTitle.status, 400);
  const emptyPrompt = await request("POST", "/api/agent-commands", { body: { title: "有标题没正文", prompt: "" } });
  assert.equal(emptyPrompt.status, 400);

  const newCommand = await request("POST", "/api/agent-commands", {
    body: { title: "盘点这块板", desc: "只读盘点", prompt: "读 {boardBase}/api/boards/{boardId} 并汇报", icon: "target" },
  });
  assert.equal(newCommand.status, 201);
  const commandId = newCommand.data.command.id;
  assert.match(commandId, /^ac_[a-z0-9]+$/);
  assert.equal(newCommand.data.command.builtin, false);
  assert.equal(newCommand.data.command.icon, "target");

  // 非法图标名回落到默认，不报错
  const oddIcon = await request("POST", "/api/agent-commands", { body: { title: "怪图标", prompt: "x", icon: "<script>" } });
  assert.equal(oddIcon.data.command.icon, "sparkles");
  await request("DELETE", `/api/agent-commands/${oddIcon.data.command.id}`);

  const editedCommand = await request("PATCH", `/api/agent-commands/${commandId}`, { body: { title: "改过的标题" } });
  assert.equal(editedCommand.data.command.title, "改过的标题");
  assert.equal(editedCommand.data.command.prompt, "读 {boardBase}/api/boards/{boardId} 并汇报"); // 未传的字段不动

  // 内置指令：改写只落覆盖层，删除 = 恢复默认
  const builtinId = "builtin:layout";
  const overridden = await request("PATCH", `/api/agent-commands/${builtinId}`, { body: { title: "我的整理指令", hidden: true } });
  assert.equal(overridden.data.command.title, "我的整理指令");
  assert.equal(overridden.data.command.builtin, true);
  assert.equal(overridden.data.command.hidden, true);
  const afterOverride = await request("GET", "/api/agent-commands");
  assert.equal(afterOverride.data.commands.find((command) => command.id === builtinId).title, "我的整理指令");

  const restored = await request("DELETE", `/api/agent-commands/${builtinId}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.restored, true);
  const afterRestore = await request("GET", "/api/agent-commands");
  assert.equal(afterRestore.data.commands.find((command) => command.id === builtinId).title, "整理画板布局");
  const restoreAgain = await request("DELETE", `/api/agent-commands/${builtinId}`);
  assert.equal(restoreAgain.status, 400); // 没有覆盖层可清，内置本体不能删

  const removedCommand = await request("DELETE", `/api/agent-commands/${commandId}`);
  assert.equal(removedCommand.status, 200);
  assert.equal(removedCommand.data.restored, false);
  const finalCommands = await request("GET", "/api/agent-commands");
  assert.equal(finalCommands.data.commands.length, 5);
  const ghostCommand = await request("DELETE", "/api/agent-commands/ac_notexist");
  assert.equal(ghostCommand.status, 404);

  /* 9.6 模板中心 */
  step("templates");
  const templates = await request("GET", "/api/templates");
  assert.equal(templates.status, 200);
  assert.ok(templates.data.templates.length >= 12, `模板数 ${templates.data.templates.length}`);
  const sample = templates.data.templates[0];
  assert.ok(sample.id && sample.name && sample.category && sample.description);
  assert.ok(Array.isArray(sample.shape) && sample.shape.length === sample.counts.cards, "列表项要带几何缩略");
  assert.ok(!("cards" in sample), "列表项不该带 cards 正文");

  const cats = await request("GET", "/api/templates/categories");
  assert.equal(cats.status, 200);
  assert.equal(
    cats.data.categories.reduce((sum, item) => sum + item.count, 0),
    templates.data.templates.length,
    "分类聚合数要跟模板文件对得上",
  );
  // 每个模板都能取详情、都通过校验、都至少有一张待填卡
  for (const item of templates.data.templates) {
    const detail = await request("GET", `/api/templates/${item.id}`);
    assert.equal(detail.status, 200, `模板 ${item.id} 详情`);
    const tpl = detail.data.template;
    assert.equal(tpl.cards.length, item.counts.cards);
    assert.equal(tpl.edges.length, item.counts.edges);
    assert.ok(tpl.cards.some((card) => card.fillPrompt), `模板 ${item.id} 没有可填充卡`);
  }
  assert.equal((await request("GET", "/api/templates/no-such-template")).status, 404);
  assert.equal((await request("GET", "/api/templates/NOT_KEBAB")).status, 400);

  const applyMe = templates.data.templates.find((item) => item.id === "nine-grid-creative") || sample;
  const applyDetail = (await request("GET", `/api/templates/${applyMe.id}`)).data.template;

  const anonymousApply = await request("POST", `/api/templates/${applyMe.id}/apply`, {
    headers: { "content-type": "application/json" },
    body: {},
  });
  assert.equal(anonymousApply.status, 403);

  const applied = await request("POST", `/api/templates/${applyMe.id}/apply`, { body: { name: "模板建的板" } });
  assert.equal(applied.status, 201);
  const tplBoardId = applied.data.boardId;
  assert.match(tplBoardId, /^b_[a-z0-9]+$/);
  assert.equal(applied.data.cardIds.length, applyDetail.cards.length);
  assert.equal(applied.data.fillableIds.length, applyDetail.cards.filter((card) => card.fillPrompt).length);

  const tplBoard = (await request("GET", `/api/boards/${tplBoardId}`)).data.board;
  assert.equal(tplBoard.name, "模板建的板");
  assert.equal(tplBoard.cards.length, applyDetail.cards.length);
  assert.equal(tplBoard.edges.length, applyDetail.edges.length);
  assert.deepEqual(tplBoard.viewport, applyDetail.viewport); // 视口原样跟着模板走
  // 模板里的 fillPrompt 落成卡片级 agent 指令（带待填标记），不新增卡片字段
  const marked = tplBoard.cards.filter((card) => (card.agentPrompt || "").startsWith("【模板待填】"));
  assert.equal(marked.length, applied.data.fillableIds.length);
  assert.ok(tplBoard.cards.every((card) => /^c_[a-z0-9_]+$/.test(card.id)), "落板 id 要符合卡片 id 规范");
  // 模板 json 的坐标围着原点写，建新板时要整体挪进正象限——否则默认视口下一半在屏幕外
  assert.ok(tplBoard.cards.every((card) => card.x >= 0 && card.y >= 0), "应用到新画板要把模板挪到原点附近");
  assert.equal(Math.min(...tplBoard.cards.map((card) => card.x)), 60);
  assert.equal(Math.min(...tplBoard.cards.map((card) => card.y)), 60);

  /* 插入：同一模板往同一块板插两次，id 不能撞 */
  const host = await request("POST", "/api/boards", { body: { name: "插模板的板" } });
  const hostId = host.data.board.id;
  await request("POST", `/api/boards/${hostId}/cards`, { body: { type: "text", title: "本来就有的卡" } });

  const noBoard = await request("POST", `/api/templates/${applyMe.id}/insert`, { body: {} });
  assert.equal(noBoard.status, 400);
  const ghostBoard = await request("POST", `/api/templates/${applyMe.id}/insert`, { body: { boardId: "b_nope" } });
  assert.equal(ghostBoard.status, 404);

  // 插进空板 = 跟建新板一样挪到原点附近（不然负坐标模板照样落到屏幕外）
  const emptyHost = await request("POST", "/api/boards", { body: { name: "空板插模板" } });
  await request("POST", `/api/templates/${applyMe.id}/insert`, { body: { boardId: emptyHost.data.board.id } });
  const emptyBoard = (await request("GET", `/api/boards/${emptyHost.data.board.id}`)).data.board;
  assert.equal(Math.min(...emptyBoard.cards.map((card) => card.x)), 60);
  assert.equal(Math.min(...emptyBoard.cards.map((card) => card.y)), 60);
  await request("DELETE", `/api/boards/${emptyHost.data.board.id}`);

  const insert1 = await request("POST", `/api/templates/${applyMe.id}/insert`, { body: { boardId: hostId } });
  assert.equal(insert1.status, 200);
  const insert2 = await request("POST", `/api/templates/${applyMe.id}/insert`, { body: { boardId: hostId } });
  assert.equal(insert2.status, 200);
  const overlap = insert1.data.cardIds.filter((id) => insert2.data.cardIds.includes(id));
  assert.equal(overlap.length, 0, `两次插入卡片 id 撞了：${overlap.join(",")}`);

  const hostBoard = (await request("GET", `/api/boards/${hostId}`)).data.board;
  assert.equal(hostBoard.cards.length, 1 + applyDetail.cards.length * 2);
  assert.equal(hostBoard.edges.length, applyDetail.edges.length * 2);
  assert.equal(hostBoard.cards[0].title, "本来就有的卡", "插入不该动用户原有卡片");
  // 第二批要落在第一批右边，不是叠在一起
  const firstX = Math.max(...hostBoard.cards.filter((card) => insert1.data.cardIds.includes(card.id)).map((card) => card.x));
  const secondX = Math.min(...hostBoard.cards.filter((card) => insert2.data.cardIds.includes(card.id)).map((card) => card.x));
  assert.ok(secondX > firstX, "第二次插入应该往右让开");

  await request("DELETE", `/api/boards/${tplBoardId}`);
  await request("DELETE", `/api/boards/${hostId}`);

  /* 9.7 卡片规格体系（插件 + 开关 + 信封收发） */
  step("card-specs");
  const specsList = await request("GET", "/api/card-specs");
  assert.equal(specsList.status, 200);
  assert.ok(specsList.data.specs.length >= 10, `规格数 ${specsList.data.specs.length}`);
  assert.ok(specsList.data.specs.every((spec) => spec.enabled), "内置规格默认全启用");
  assert.equal(
    specsList.data.categories.reduce((sum, item) => sum + item.count, 0),
    specsList.data.specs.length,
    "分类聚合数要跟规格文件对得上",
  );
  const fullSpecs = await request("GET", "/api/card-specs?full=1");
  assert.ok(fullSpecs.data.specs.every((spec) => Array.isArray(spec.fields) && spec.fields.length), "full=1 要带字段定义");
  // 每份规格都能取详情、都有说明块；示例数据在读盘时就已经过校验（写歪的示例会让服务读不出规格）
  for (const item of specsList.data.specs) {
    const detail = await request("GET", `/api/card-specs/${item.id}`);
    assert.equal(detail.status, 200, `规格 ${item.id} 详情`);
    assert.equal(detail.data.spec.id, item.id);
    assert.ok(detail.data.prompt.includes(item.id), `规格 ${item.id} 的说明块`);
  }
  assert.equal((await request("GET", "/api/card-specs/no-such-spec")).status, 404);
  assert.equal((await request("GET", "/api/card-specs/NOT_KEBAB")).status, 400);

  const schemaRes = await fetch(`${base}/api/card-specs/feishu-message/schema`);
  assert.equal(schemaRes.status, 200);
  const schemaDoc = JSON.parse(await schemaRes.text());
  assert.ok(schemaDoc.$schema.includes("json-schema.org"), "要给标准 JSON Schema");
  assert.deepEqual(schemaDoc.properties.spec, { const: "feishu-message", description: "规格 id，固定值" });
  assert.deepEqual(schemaDoc.properties.fields.required.sort(), ["sender", "text"]);
  const envelopeSchema = JSON.parse(await (await fetch(`${base}/api/card-specs/schema`)).text());
  assert.ok(envelopeSchema.properties.cards.items.anyOf.length >= 11, "信封 schema 要覆盖全部启用规格 + 原生卡片");
  const promptText = await (await fetch(`${base}/api/card-specs/schema?format=prompt`)).text();
  assert.ok(promptText.includes("feishu-message") && promptText.includes("blotboard.cards"));

  /* 干跑校验：好卡 / 缺必填 / 不认识的规格 */
  const goodEnvelope = {
    format: "blotboard.cards",
    version: 1,
    generator: "smoke/1.0",
    cards: [
      {
        id: "m1",
        spec: "feishu-message",
        fields: {
          sender: "张三",
          chat: "AI 落地推进群",
          text: "下周三前要看到大纲",
          msgType: "text",
          sentAt: "2026-08-20T10:12:00Z",
          notAField: "会被忽略",
        },
        source: { app: "feishu", externalId: "om_smoke_1" },
      },
      { id: "n1", type: "text", title: "我的批注", content: "这条要跟进" },
    ],
    edges: [{ from: "m1", to: "n1", label: "跟进", kind: "produces" }],
  };
  const report = (await request("POST", "/api/card-specs/validate", { body: goodEnvelope })).data.report;
  assert.equal(report.counts.cards, 2);
  assert.equal(report.counts.ready, 2);
  assert.equal(report.counts.rejected, 0);
  assert.equal(report.cards[0].title, "张三", "标题按 display.title 自动生成");
  assert.ok(report.cards[0].warnings.some((text) => text.includes("notAField")), "未知字段要提示");
  const badReport = (
    await request("POST", "/api/card-specs/validate", {
      body: { format: "blotboard.cards", version: 1, cards: [{ spec: "feishu-message", fields: { chat: "只有群名" } }] },
    })
  ).data.report;
  assert.equal(badReport.counts.rejected, 1);
  assert.ok(badReport.cards[0].problems.join(" ").includes("必填"), badReport.cards[0].problems.join(" "));
  const ghostReport = (
    await request("POST", "/api/card-specs/validate", {
      body: { format: "blotboard.cards", version: 1, cards: [{ spec: "not-installed", fields: {} }] },
    })
  ).data.report;
  assert.equal(ghostReport.specs[0].installed, false);
  assert.equal(ghostReport.counts.ready, 0);

  /* 字段级报错三分类：值不合规 ≠ 缺必填（踩过的坑——enum 传了个非法值，报「缺必填字段」，
     照着补也补不对）。必填 enum 传非法值 → 文案要说「不是合法取值」+ 列出合法值，且不能出现「缺」 */
  const enumReport = (
    await request("POST", "/api/card-specs/validate", {
      body: {
        format: "blotboard.cards",
        version: 1,
        cards: [
          {
            id: "bad-enum",
            spec: "decision-log",
            fields: { title: "要不要自研播放器", status: "已经定了", decision: "先不自研", decidedAt: "上周三" },
          },
        ],
      },
    })
  ).data.report;
  assert.equal(enumReport.counts.rejected, 1);
  const enumProblems = enumReport.cards[0].problems.join(" ");
  assert.ok(enumProblems.includes("不是合法取值"), enumProblems);
  assert.ok(enumProblems.includes("proposed") && enumProblems.includes("accepted"), "要列出合法值示例");
  assert.ok(enumProblems.includes("key=status"), "要点名是哪个字段");
  assert.ok(!enumProblems.includes("缺"), `值不合规不能报成缺必填：${enumProblems}`);
  // 非必填字段值不合规只进 warnings（不拦卡），文案里要写清期望的时间格式
  const enumWarnings = enumReport.cards[0].warnings.join(" ");
  assert.ok(enumWarnings.includes("key=decidedAt") && enumWarnings.includes("时间戳"), enumWarnings);
  // 真·缺必填仍然报「缺必填字段」，带 key 与中文 label
  const missingReport = (
    await request("POST", "/api/card-specs/validate", {
      body: { format: "blotboard.cards", version: 1, cards: [{ spec: "decision-log", fields: { title: "只给了标题" } }] },
    })
  ).data.report;
  // tags / list 的**元素**也不许落 "[object Object]"（同一类坑的叶子位置）：
  // alternatives 是 tags 且非必填 → 丢掉坏元素、留住好元素，只报 warning，不拦卡
  const leafReport = (
    await request("POST", "/api/card-specs/validate", {
      body: {
        format: "blotboard.cards",
        version: 1,
        cards: [
          {
            spec: "decision-log",
            fields: {
              title: "叶子位置的对象",
              status: "accepted",
              decision: "丢掉坏元素",
              alternatives: ["自研", { plan: "外采" }],
            },
          },
        ],
      },
    })
  ).data.report;
  assert.equal(leafReport.counts.ready, 1, "非必填字段里一个坏元素不该拦下整张卡");
  assert.deepEqual(
    leafReport.cards.find(() => true).fields.find((field) => field.key === "alternatives").value,
    ["自研"],
    "对象元素要被丢掉，不能变成一条 [object Object] 标签",
  );
  assert.ok(leafReport.cards[0].warnings.join(" ").includes("不是标量"), leafReport.cards[0].warnings.join(" "));

  const missingProblems = missingReport.cards[0].problems.join(" ");
  assert.ok(missingProblems.includes("缺必填字段") && missingProblems.includes("key=status"), missingProblems);
  assert.ok(!missingProblems.includes("不是合法取值"), missingProblems);
  // strict 落板的报错里要能定位到具体哪张卡（#下标 + 信封内 id）
  const enumIngestFail = await request("POST", `/api/boards/${boardId}/ingest`, {
    body: {
      format: "blotboard.cards",
      version: 1,
      cards: [{ id: "bad-enum", spec: "decision-log", fields: { title: "t", status: "瞎写的", decision: "d" } }],
    },
  });
  assert.equal(enumIngestFail.status, 409);
  assert.ok(enumIngestFail.data.error.includes("id=bad-enum"), enumIngestFail.data.error);
  assert.ok(enumIngestFail.data.error.includes("不是合法取值"), enumIngestFail.data.error);

  /* 落板 */
  const inbox = await request("POST", "/api/boards", { body: { name: "收卡片的板" } });
  const inboxId = inbox.data.board.id;

  const anonymousIngest = await request("POST", `/api/boards/${inboxId}/ingest`, {
    headers: { "content-type": "application/json" },
    body: goodEnvelope,
  });
  assert.equal(anonymousIngest.status, 403, "ingest 是写操作，必须过鉴权");

  const strictFail = await request("POST", `/api/boards/${inboxId}/ingest`, {
    body: {
      format: "blotboard.cards",
      version: 1,
      cards: [goodEnvelope.cards[0], { spec: "feishu-message", fields: { chat: "缺必填" } }],
    },
  });
  assert.equal(strictFail.status, 409, "strict 模式：有一张坏卡就整批不落");
  assert.equal((await request("GET", `/api/boards/${inboxId}`)).data.board.cards.length, 0, "strict 失败不能落下半批");

  const lenient = await request("POST", `/api/boards/${inboxId}/ingest`, {
    body: {
      format: "blotboard.cards",
      version: 1,
      mode: "lenient",
      cards: [{ spec: "metric-snapshot", fields: { metric: "关注数", value: 1280, period: "8 月第 3 周", measuredAt: 1755993600000 } }, { spec: "feishu-message", fields: {} }],
    },
  });
  assert.equal(lenient.status, 201);
  assert.equal(lenient.data.created.length, 1, "lenient 模式：坏卡跳过，好卡照落");
  assert.equal(lenient.data.rejected.length, 1);

  const ingested = await request("POST", `/api/boards/${inboxId}/ingest`, { body: goodEnvelope });
  assert.equal(ingested.status, 201);
  assert.equal(ingested.data.created.length, 2);
  assert.equal(ingested.data.edgeIds.length, 1, "信封里的连线要按本地 id 连起来");
  const inboxBoard = (await request("GET", `/api/boards/${inboxId}`)).data.board;
  const messageCard = inboxBoard.cards.find((card) => card.data?.specId === "feishu-message");
  assert.equal(messageCard.type, "data");
  assert.equal(messageCard.title, "张三");
  assert.equal(messageCard.data.fields.sentAt, Date.parse("2026-08-20T10:12:00Z"), "时间要归一成毫秒时间戳");
  assert.equal(messageCard.data.fields.notAField, undefined, "规格外的字段不入库");
  assert.equal(messageCard.data.source.externalId, "om_smoke_1");
  assert.equal(messageCard.data.specVersion, 1);
  // 没给坐标的卡要自动排开，不能全叠在一个点上
  assert.notEqual(inboxBoard.cards[1].x, inboxBoard.cards[2].x);

  /* 判重：同 spec + 同 externalId 默认更新而不是再建一张 */
  const dedupe = await request("POST", `/api/boards/${inboxId}/ingest`, {
    body: {
      format: "blotboard.cards",
      version: 1,
      cards: [{ ...goodEnvelope.cards[0], fields: { ...goodEnvelope.cards[0].fields, text: "改口了：周五也行" } }],
    },
  });
  assert.equal(dedupe.data.created.length, 0);
  assert.equal(dedupe.data.updated.length, 1);
  assert.equal(dedupe.data.updated[0].cardId, messageCard.id);
  const afterUpdate = (await request("GET", `/api/boards/${inboxId}`)).data.board.cards.find((card) => card.id === messageCard.id);
  assert.equal(afterUpdate.data.fields.text, "改口了：周五也行");
  assert.equal(afterUpdate.data.fields.chat, "AI 落地推进群");
  assert.equal(afterUpdate.x, messageCard.x, "判重更新不该把用户摆好的位置挪走");

  const skipDup = await request("POST", `/api/boards/${inboxId}/ingest`, {
    body: { format: "blotboard.cards", version: 1, onDuplicate: "skip", cards: [goodEnvelope.cards[0]] },
  });
  assert.equal(skipDup.data.skipped.length, 1);
  assert.equal(skipDup.data.created.length, 0);

  /* 信封的原生类型白名单：口径是「自包含」——excalidraw / html / book / ref 都能一封信送到 */
  const selfContained = await request("POST", `/api/boards/${inboxId}/ingest`, {
    body: {
      format: "blotboard.cards",
      version: 1,
      cards: [
        {
          id: "draw1",
          type: "excalidraw",
          title: "信封里的手绘",
          // 对象形态一起验：信封这条路也不许落 [object Object]
          excalidraw: { source: { type: "excalidraw", elements: [{ id: "e1", type: "text", text: "信封手绘" }] } },
        },
        { id: "web1", type: "html", title: "信封里的网页", html: { url: "https://ppt.example.com/deck.html" } },
        { id: "bk1", type: "book", title: "信封里的书", book: { bookId: "smoke-book", name: "冒烟之书", author: "无名" } },
        {
          id: "rf1",
          type: "ref",
          title: "信封里的资料",
          ref: { query: "冒烟", mode: "vector", items: [{ resourceId: "doc:smoke:1", title: "一条资料" }] },
        },
      ],
      edges: [{ from: "draw1", to: "web1", label: "配套", kind: "references" }],
    },
  });
  assert.equal(selfContained.status, 201, JSON.stringify(selfContained.data));
  assert.equal(selfContained.data.created.length, 4, "四种自包含类型都要能走信封");
  assert.equal(selfContained.data.edgeIds.length, 1);
  const selfCards = (await request("GET", `/api/boards/${inboxId}`)).data.board.cards;
  const drawCard = selfCards.find((card) => card.type === "excalidraw");
  assert.ok(!drawCard.excalidraw.source.includes("[object Object]"));
  assert.equal(JSON.parse(drawCard.excalidraw.source).elements.length, 1);
  assert.equal(selfCards.find((card) => card.type === "html").html.host, "ppt.example.com");
  assert.equal(selfCards.find((card) => card.type === "book").book.bookId, "smoke-book");
  assert.equal(selfCards.find((card) => card.type === "ref").ref.items.length, 1);

  /* html 照样要过嵌入白名单：包自己抛的 400 要变成**这张卡的** problem，
     而不是从落板事务里穿出去成一条没头没脑的 400 */
  const badHtmlEnvelope = await request("POST", `/api/boards/${inboxId}/ingest`, {
    body: {
      format: "blotboard.cards",
      version: 1,
      cards: [{ id: "web2", type: "html", html: { url: "https://not-allowed.example.org/x.html" } }],
    },
  });
  assert.equal(badHtmlEnvelope.status, 409, "白名单不过要按「坏卡」拒，不是 500/裸 400");
  assert.ok(badHtmlEnvelope.data.error.includes("白名单"), badHtmlEnvelope.data.error);
  assert.ok(badHtmlEnvelope.data.error.includes("id=web2"), "要能定位到是哪张卡");
  const badHtmlLenient = await request("POST", `/api/boards/${inboxId}/ingest`, {
    body: {
      format: "blotboard.cards",
      version: 1,
      mode: "lenient",
      cards: [
        { type: "html", html: { url: "https://not-allowed.example.org/x.html" } },
        { type: "text", title: "同一封里的好卡" },
      ],
    },
  });
  assert.equal(badHtmlLenient.status, 201);
  assert.equal(badHtmlLenient.data.created.length, 1, "lenient 下坏卡跳过、好卡照落");
  assert.equal(badHtmlLenient.data.rejected.length, 1);

  /* image / pdf / board 继续排除（本机主键，跨实例无意义），但拒收文案必须点名替代路径 */
  for (const type of ["image", "media", "pdf"]) {
    const rejectedNative = await request("POST", `/api/boards/${inboxId}/ingest`, {
      body: { format: "blotboard.cards", version: 1, cards: [{ type, file: { uploadId: "web-1234567890123-abcdef123456.png" } }] },
    });
    assert.equal(rejectedNative.status, 409);
    const text = rejectedNative.data.error;
    assert.ok(text.includes("POST /api/uploads"), `要指路先上传：${text}`);
    assert.ok(text.includes("/cards"), `要指路单张建卡：${text}`);
    assert.ok(text.includes("uploadId"), text);
  }
  const rejectedBoardRef = await request("POST", `/api/boards/${inboxId}/ingest`, {
    body: { format: "blotboard.cards", version: 1, cards: [{ type: "board", boardRef: { boardId } }] },
  });
  assert.equal(rejectedBoardRef.status, 409);
  assert.ok(rejectedBoardRef.data.error.includes("boardRef.boardId"), rejectedBoardRef.data.error);
  // 信封 Schema / prompt 版与白名单同源（真源是各包 meta.envelope）
  const nativeSchema = JSON.parse(await (await fetch(`${base}/api/card-specs/schema`)).text())
    .properties.cards.items.anyOf.find((item) => item.title === "原生卡片");
  for (const type of ["excalidraw", "html", "book", "ref"]) {
    assert.ok(nativeSchema.properties.type.enum.includes(type), `schema 要放行 ${type}`);
  }
  for (const type of ["image", "media", "pdf", "board", "data"]) {
    assert.ok(!nativeSchema.properties.type.enum.includes(type), `schema 不该放行 ${type}`);
  }
  assert.ok(nativeSchema.description.includes("excalidraw → excalidraw"), "schema 要说清专属字段放哪个键");
  const nativePrompt = await (await fetch(`${base}/api/card-specs/schema?format=prompt`)).text();
  assert.ok(nativePrompt.includes("`html` → `html`") && nativePrompt.includes("image / pdf / board 不能走信封"), "prompt 版要同步");

  /* 开关：停用后不再收这类卡，画板上已有的不受影响 */
  const disabled = await request("PATCH", "/api/card-specs/feishu-message", { body: { enabled: false } });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.spec.enabled, false);
  const blocked = await request("POST", `/api/boards/${inboxId}/ingest`, {
    body: { format: "blotboard.cards", version: 1, cards: [{ spec: "feishu-message", fields: { sender: "李四", text: "还收吗" } }] },
  });
  assert.equal(blocked.status, 409, "停用的规格不能再收新卡");
  assert.ok(
    (await request("GET", `/api/boards/${inboxId}`)).data.board.cards.some((card) => card.id === messageCard.id),
    "停用规格不影响画板上已有的卡片",
  );
  assert.equal((await request("PATCH", "/api/card-specs/feishu-message", { body: { enabled: true } })).data.spec.enabled, true);
  assert.equal((await request("PATCH", "/api/card-specs/feishu-message", { body: { enabled: "yes" } })).status, 400);

  /* 直接建规格卡 / 部分更新 / 清字段 */
  const dataCard = await request("POST", `/api/boards/${inboxId}/cards`, {
    body: { type: "data", data: { specId: "contact", fields: { name: "王五", org: "某集团", channel: "feishu" } } },
  });
  assert.equal(dataCard.status, 201);
  assert.equal(dataCard.data.card.title, "王五", "没给 title 就按规格的 display.title 补");
  const patched = await request("PATCH", `/api/boards/${inboxId}/cards/${dataCard.data.card.id}`, {
    body: { data: { specId: "contact", fields: { role: "数字化负责人" } } },
  });
  assert.equal(patched.data.card.data.fields.org, "某集团", "单卡 PATCH 是合并，不是整份替换");
  assert.equal(patched.data.card.data.fields.role, "数字化负责人");
  const cleared = await request("PATCH", `/api/boards/${inboxId}/cards/${dataCard.data.card.id}`, {
    body: { data: { specId: "contact", fields: { org: null } } },
  });
  assert.equal(cleared.data.card.data.fields.org, undefined, "显式 null 才清字段");
  const noSpec = await request("POST", `/api/boards/${inboxId}/cards`, { body: { type: "data" } });
  assert.equal(noSpec.status, 400, "规格卡必须给 specId");
  // 不认识的规格照样收下（这是「能看别人的卡片」的前提），只做通用清洗
  const alien = await request("POST", `/api/boards/${inboxId}/cards`, {
    body: { type: "data", title: "别人的卡", data: { specId: "someone-else-spec", fields: { foo: "bar", n: 3 } } },
  });
  assert.equal(alien.status, 201);
  assert.deepEqual(alien.data.card.data.fields, { foo: "bar", n: 3 });

  /* 导出成信封：别人拿去能直接再 ingest */
  const envelopeOut = await request("GET", `/api/boards/${inboxId}/export?format=cards&only=data`);
  assert.equal(envelopeOut.status, 200);
  assert.equal(envelopeOut.data.envelope.format, "blotboard.cards");
  assert.ok(envelopeOut.data.envelope.cards.every((card) => card.spec), "only=data 只导规格卡");
  const md = await fetch(`${base}/api/boards/${inboxId}/export?format=md`);
  assert.ok((await md.text()).includes("规格："), "markdown 导出要把规格卡的字段摊出来");

  /* 自定义规格：建 → 用 → 删 */
  const userSpec = {
    id: "smoke-thing",
    version: 1,
    name: "冒烟测试卡",
    category: "record",
    description: "冒烟测试建出来的规格",
    icon: "boxes",
    display: { title: "label", body: "note", badges: ["level"] },
    fields: [
      { key: "label", label: "名称", type: "text", required: true },
      { key: "note", label: "备注", type: "longtext" },
      { key: "level", label: "等级", type: "enum", options: ["a", "b"] },
    ],
    example: { label: "示例", level: "a" },
  };
  assert.equal((await request("POST", "/api/card-specs", { headers: { "content-type": "application/json" }, body: userSpec })).status, 403);
  const createdSpec = await request("POST", "/api/card-specs", { body: userSpec });
  assert.equal(createdSpec.status, 201);
  assert.equal(createdSpec.data.spec.origin, "user");
  assert.equal((await request("POST", "/api/card-specs", { body: userSpec })).status, 409, "同 id 要显式 overwrite");
  assert.equal((await request("POST", "/api/card-specs", { body: { ...userSpec, overwrite: true, name: "改个名" } })).status, 201);
  assert.equal((await request("POST", "/api/card-specs", { body: { ...userSpec, id: "feishu-doc" } })).status, 409, "不能顶掉内置规格");
  assert.equal((await request("POST", "/api/card-specs", { body: { ...userSpec, id: "schema" } })).status, 400, "保留 id");
  assert.equal((await request("POST", "/api/card-specs", { body: { ...userSpec, id: "broken-one", fields: [] } })).status, 400);
  const withUser = await request("GET", "/api/card-specs");
  assert.equal(withUser.data.specs.filter((spec) => spec.origin === "user").length, 1);
  const userCard = await request("POST", `/api/boards/${inboxId}/ingest`, {
    body: { format: "blotboard.cards", version: 1, cards: [{ spec: "smoke-thing", fields: { label: "自定义规格也能收", level: "b" } }] },
  });
  assert.equal(userCard.status, 201);
  assert.equal((await request("DELETE", "/api/card-specs/feishu-doc")).status, 409, "内置规格只能停用不能删");
  assert.equal((await request("DELETE", "/api/card-specs/smoke-thing")).status, 200);
  assert.equal((await request("GET", "/api/card-specs/smoke-thing")).status, 404);

  /* 9.8 引用资源库（agent-skill 规格卡的跨板聚合：/api/resources + /resources 页） */
  step("resources");
  const resSpecDetail = await request("GET", "/api/card-specs/agent-skill");
  assert.equal(resSpecDetail.status, 200, "内置规格 agent-skill 要装上");
  assert.equal(resSpecDetail.data.enabled, true, "详情口的 enabled 在顶层");

  const resBoard = await request("POST", "/api/boards", { body: { name: "资源库板（冒烟）" } });
  assert.equal(resBoard.status, 201);
  const resBoardId = resBoard.data.board.id;
  const resIngest = await request("POST", `/api/boards/${resBoardId}/ingest`, {
    body: {
      format: "blotboard.cards",
      version: 1,
      cards: [
        {
          spec: "agent-skill",
          source: { app: "smoke", externalId: "res-fireworks" },
          fields: {
            name: "fireworks-tech-graph",
            purpose: "自然语言生成技术架构图",
            kind: "skill",
            url: "https://example.com/fireworks-tech-graph",
            install: "按仓库 README 装进技能目录",
            agents: ["claude-code", "codex"],
            triggers: ["画架构图", "UML"],
            status: "verified",
          },
        },
        {
          spec: "agent-skill",
          source: { app: "smoke", externalId: "res-mcp" },
          fields: {
            name: "smoke-mcp",
            purpose: "一个只用于冒烟的 MCP 资源",
            kind: "mcp",
            url: "https://example.com/smoke-mcp",
            install: "npx smoke-mcp",
            status: "todo",
            notes: "关键词 zebra-needle 应该能搜到它",
          },
        },
        // 干扰项：别的类型 / 别的规格的卡都不算资源
        { type: "text", title: "普通文本卡不是资源", content: "聚合时该被跳过" },
      ],
    },
  });
  assert.equal(resIngest.status, 201, JSON.stringify(resIngest.data));
  assert.equal(resIngest.data.created.length, 3);

  const resList = await request("GET", "/api/resources");
  assert.equal(resList.status, 200);
  assert.ok(resList.data.total >= 2, `资源数 ${resList.data.total}`);
  assert.equal(resList.data.spec.id, "agent-skill");
  assert.equal(resList.data.spec.enabled, true);
  assert.ok(resList.data.counts.kinds.skill >= 1 && resList.data.counts.kinds.mcp >= 1, "要按类型计数");
  assert.ok(
    resList.data.resources.every((entry) => entry.cardId && entry.link.includes("board=") && entry.boardName),
    "每条都要带画板信息与深链",
  );
  const fireworks = resList.data.resources.find((entry) => entry.fields.name === "fireworks-tech-graph");
  assert.ok(fireworks, "刚登记的资源要在清单里");
  assert.equal(fireworks.fields.status, "verified");
  assert.deepEqual(fireworks.fields.agents, ["claude-code", "codex"]);

  // 过滤三条口径：类型 / 状态 / 关键词（长尾字段 notes 与 tags 也要进检索口径）
  assert.equal((await request("GET", "/api/resources?kind=mcp")).data.matched, 1);
  assert.equal((await request("GET", "/api/resources?status=verified")).data.matched, 1);
  assert.equal((await request("GET", "/api/resources?status=broken")).data.matched, 0);
  assert.equal((await request("GET", "/api/resources?q=zebra-needle")).data.matched, 1, "notes 也要能搜");
  assert.equal((await request("GET", "/api/resources?q=画架构图")).data.matched, 1, "触发词也要能搜");

  // 能力自描述与 agent 指南都要讲资源库
  const capsWithResources = await request("GET", "/api/capabilities");
  assert.equal(capsWithResources.data.resources.spec, "agent-skill");
  assert.equal(capsWithResources.data.resources.enabled, true);
  assert.ok(capsWithResources.data.resources.count >= 2, "能力块要带当前条数");
  const skillResDoc = await request("GET", "/api/skill?focus=resources&format=json");
  assert.equal(skillResDoc.status, 200);
  assert.ok(skillResDoc.data.sections.some((section) => section.id === "resources"), "focus=resources 要有资源库一节");
  const skillResMd = await (await fetch(`${base}/api/skill?format=md&focus=resources`)).text();
  assert.ok(skillResMd.includes("/api/resources"), "指南要给资源 API");
  assert.ok(skillResMd.includes("/resources"), "指南要给资源页地址");

  // 人看的页面
  const resPage = await fetch(`${base}/resources`);
  assert.equal(resPage.status, 200);
  assert.ok((await resPage.text()).includes("引用资源库"), "资源页要能打开");

  // externalId 判重：同一资源再推一次是更新不是新建
  const resUpdate = await request("POST", `/api/boards/${resBoardId}/ingest`, {
    body: {
      format: "blotboard.cards",
      version: 1,
      cards: [
        {
          spec: "agent-skill",
          source: { app: "smoke", externalId: "res-fireworks" },
          fields: {
            name: "fireworks-tech-graph",
            purpose: "自然语言生成技术架构图",
            kind: "skill",
            url: "https://example.com/fireworks-tech-graph",
            install: "按仓库 README 装进技能目录",
            status: "trying",
          },
        },
      ],
    },
  });
  assert.equal(resUpdate.status, 201);
  assert.equal(resUpdate.data.updated.length, 1, "同 externalId 再推是更新");
  assert.equal(resUpdate.data.created.length, 0);
  assert.equal((await request("GET", "/api/resources?status=trying")).data.matched, 1, "更新后的状态要反映到清单");
  assert.equal((await request("GET", "/api/resources?status=verified")).data.matched, 0, "旧状态不该还挂着");

  await request("DELETE", `/api/boards/${resBoardId}`);
  assert.equal((await request("GET", "/api/resources?q=zebra-needle")).data.matched, 0, "板删了资源也跟着没了");

  await request("DELETE", `/api/boards/${inboxId}`);

  /* 9.8.05 PDF 排版用的分块产物（format=print）：内容与 HTML 导出同源，版面归浏览器 */
  step("print-doc");
  const printBoard = await request("POST", "/api/boards", { body: { name: "PDF 分块（冒烟）" } });
  const printBoardId = printBoard.data.board.id;
  const printCards = [];
  for (const [title, content] of [
    ["第一张", "正文一 https://example.com/one"],
    ["第二张", "正文二"],
    ["第三张", "正文三"],
  ]) {
    const made = await request("POST", `/api/boards/${printBoardId}/cards`, {
      body: { type: "text", title, content, x: 100, y: 100 },
    });
    assert.equal(made.status, 201);
    printCards.push(made.data.card.id);
  }
  await request("POST", `/api/boards/${printBoardId}/edges`, {
    body: { from: printCards[0], to: printCards[1], kind: "rel", label: "接着讲" },
  });
  await request("POST", `/api/boards/${printBoardId}/comments`, {
    body: { target: "card", targetId: printCards[0], text: "这段要改" },
  });

  const printDoc = (await request("GET", `/api/boards/${printBoardId}/export?format=print`)).data.doc;
  assert.equal(printDoc.service, "blotboard");
  assert.equal(printDoc.boardId, printBoardId);
  assert.equal(printDoc.stats.cards, 3);
  assert.ok(printDoc.css.length > 500, "样式表要跟着产物走（浏览器那侧不另存一份内容样式）");
  assert.ok(printDoc.blocks.length >= 3, `块数 ${printDoc.blocks.length}`);
  assert.ok(
    printDoc.blocks.every((block) => block.html && block.anchor && typeof block.level === "number"),
    "每一块都要能定位（锚点 + 层级），否则目录做不出来",
  );
  // 卡片编号全篇连续，且与 HTML 导出是同一套口径
  const printCardBlocks = printDoc.blocks.filter((block) => block.kind === "card");
  assert.deepEqual(
    printCardBlocks.map((block) => block.index),
    printCardBlocks.map((_, at) => at + 1),
    "卡片编号要从 1 连续排下来",
  );
  // 节标题必须带走下一块：它单独落在页尾是最难看的排版错误
  assert.ok(
    printDoc.blocks.filter((block) => block.kind === "section").every((block) => block.keepWithNext),
    "节标题要标 keepWithNext",
  );
  assert.ok(printDoc.blocks.some((block) => block.html.includes("https://example.com/one")), "正文里的链接要原样留着");
  assert.equal(printDoc.filtered, null, "没开筛选时不该说自己是筛过的");

  // 评论开关与 HTML 导出同一个参数
  const printPlain = printDoc.blocks.map((block) => block.html).join("");
  assert.ok(!printPlain.includes("这段要改"), "默认不带评论");
  const printWithComments = (await request("GET", `/api/boards/${printBoardId}/export?format=print&comments=1`)).data.doc;
  assert.ok(
    printWithComments.blocks.map((block) => block.html).join("").includes("这段要改"),
    "comments=1 要把批注印进去",
  );

  // ids：只导指名的这几张（画布上选中的那批）——html 导出走同一条口径
  const printPicked = (
    await request("GET", `/api/boards/${printBoardId}/export?format=print&ids=${printCards[0]},${printCards[2]}`)
  ).data.doc;
  assert.equal(printPicked.stats.cards, 2, "ids 只导指名的那几张");
  assert.equal(printPicked.filtered.hidden, 1, "封面要说清楚还有几张没进来");
  assert.ok(
    printPicked.blocks.filter((block) => block.kind === "card").every((block) => !block.html.includes("第二张")),
    "没点名的卡不该出现",
  );
  const pickedHtml = await (
    await fetch(`${base}/api/boards/${printBoardId}/export?format=html&ids=${printCards[0]}`)
  ).text();
  assert.ok(pickedHtml.includes("第一张") && !pickedHtml.includes("第三张"), "HTML 导出也认 ids");
  // 末尾那段可导回的载荷也要跟着筛选走：读者看不到的卡片不该藏在文件里
  const pickedPayload = JSON.parse(
    /<script[^>]*id="blotboard-bundle"[^>]*>([\s\S]*?)<\/script>/.exec(pickedHtml)[1].replace(/\\u003c/g, "<"),
  );
  assert.deepEqual(
    pickedPayload.boards[0].cards.map((card) => card.title),
    ["第一张"],
    "载荷里只该有这份文件印出来的那张卡",
  );

  await request("DELETE", `/api/boards/${printBoardId}`);

  /* 9.8.06 画板包：导出（一块 / 一批 / HTML 载荷）→ 导入（副本 / 恢复 / 覆盖） */
  step("board-bundle");
  const xferPackParent = await request("POST", "/api/boards", { body: { name: "搬家（冒烟）", group: "搬家组" } });
  const xferPackParentId = xferPackParent.data.board.id;
  const xferPackChild = await request("POST", "/api/boards", {
    body: { name: "搬家子板（冒烟）", parentId: xferPackParentId },
  });
  const xferPackChildId = xferPackChild.data.board.id;

  // 一块「什么都有」的板：分组框 + 框里的卡 + 图片 + 子画板卡 + 任务卡 + 连线 + 两条评论
  const xferPackUpload = (
    await (
      await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { "content-type": "image/png", "x-file-name": encodeURIComponent("搬家.png"), "x-board-web": "1", origin },
        body: pngBytes,
      })
    ).json()
  ).upload;
  const xferPackCard = async (body) => (await request("POST", `/api/boards/${xferPackParentId}/cards`, { body })).data.card;
  const xferPackFrame = await xferPackCard({ type: "frame", title: "一组", x: 0, y: 0, w: 600, h: 400 });
  const xferPackText = await xferPackCard({ type: "text", title: "说明", content: "正文", x: 40, y: 60, frameId: xferPackFrame.id });
  const xferPackImage = await xferPackCard({ type: "image", title: "配图", file: { uploadId: xferPackUpload.id }, x: 400, y: 60 });
  await xferPackCard({ type: "board", title: "子板卡", boardRef: { boardId: xferPackChildId, name: "搬家子板（冒烟）" }, x: 700, y: 60 });
  const xferPackTask = await xferPackCard({ type: "task", title: "干活", task: { goal: "把这块板搬过去" }, x: 400, y: 400 });
  const xferPackEdge = (
    await request("POST", `/api/boards/${xferPackParentId}/edges`, {
      body: { from: xferPackText.id, to: xferPackImage.id, label: "配图", kind: "references", weight: 4, tags: ["主线"] },
    })
  ).data.edge;
  await request("POST", `/api/boards/${xferPackParentId}/comments`, {
    body: { target: "card", targetId: xferPackText.id, text: "这段再写细一点" },
  });
  await request("POST", `/api/boards/${xferPackParentId}/comments`, {
    body: { target: "edge", targetId: xferPackEdge.id, text: "这条关系存疑" },
  });
  // 任务卡先转成 Issue：副本**不该**继承来源机器上的 Issue id
  const xferPackIssue = await request("POST", `/api/boards/${xferPackParentId}/cards/${xferPackTask.id}/issue`);
  assert.equal(xferPackIssue.status, 201);

  // 导出：子画板跟着走（不然对端点开子画板卡就是死链），附件字节打进包里
  const xferPackExport = await request("GET", `/api/boards/export?ids=${xferPackParentId}`);
  assert.equal(xferPackExport.status, 200);
  const xferBundle = xferPackExport.data.bundle;
  assert.equal(xferBundle.format, "blotboard.boards");
  assert.equal(xferBundle.boards.length, 2, "子画板要跟着一起导出");
  assert.equal(xferBundle.boards[0].group, "搬家组", "分组要留在包里");
  assert.ok(xferBundle.assets?.some((asset) => asset.id === xferPackUpload.id && asset.data), "图片字节要打进包里");
  const xferPackNoAssets = await request("GET", `/api/boards/export?ids=${xferPackParentId}&assets=0`);
  assert.ok(!(xferPackNoAssets.data.bundle.assets || []).some((asset) => asset.data), "assets=0 只留引用");
  const xferPackNoChildren = await request("GET", `/api/boards/export?ids=${xferPackParentId}&children=0`);
  assert.equal(xferPackNoChildren.data.bundle.boards.length, 1, "children=0 就只导点名的那块");

  const xferImportBundle = async (payload, query = "") =>
    fetch(`${base}/api/boards/import${query}`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8", "x-board-web": "1", origin },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }).then(async (response) => ({ status: response.status, data: await response.json() }));

  // 导入为副本：新 id、引用整体搬家、附件复用本机已有的那份
  const xferCopied = await xferImportBundle(xferBundle);
  assert.equal(xferCopied.status, 201, JSON.stringify(xferCopied.data).slice(0, 300));
  assert.equal(xferCopied.data.imported.length, 2);
  const xferCopyId = xferCopied.data.imported[0].id;
  assert.notEqual(xferCopyId, xferPackParentId, "副本必须是新板");
  assert.equal(xferCopied.data.assets.reused, 1, "同机导入复用原上传件，不再落一份");
  const xferCopyBoard = (await request("GET", `/api/boards/${xferCopyId}`)).data.board;
  assert.equal(xferCopyBoard.cards.length, 5);
  assert.equal(xferCopyBoard.comments.length, 2, "评论跟着板走");
  assert.equal(xferCopyBoard.group, "搬家组");
  const xferCopyFrame = xferCopyBoard.cards.find((card) => card.type === "frame");
  const xferCopyText = xferCopyBoard.cards.find((card) => card.type === "text");
  assert.equal(xferCopyText.frameId, xferCopyFrame.id, "分组框归属要跟着新卡片 id 走");
  assert.notEqual(xferCopyText.id, xferPackText.id, "副本的卡片 id 是新的");
  const xferCopyBoardCard = xferCopyBoard.cards.find((card) => card.type === "board");
  assert.equal(xferCopyBoardCard.boardRef.boardId, xferCopied.data.imported[1].id, "子画板卡要指向一起导进来的那块子板");
  assert.equal(xferCopyBoard.edges.length, 1);
  assert.equal(xferCopyBoard.edges[0].weight, 4);
  assert.deepEqual(xferCopyBoard.edges[0].tags, ["主线"]);
  const xferCopyEdgeComment = xferCopyBoard.comments.find((comment) => comment.target === "edge");
  assert.equal(xferCopyEdgeComment.targetId, xferCopyBoard.edges[0].id, "连线评论要跟着新连线 id");
  assert.equal(xferCopyBoard.cards.find((card) => card.type === "task").task.issueId, null, "副本不继承来源机器的 Issue");
  assert.equal(xferCopyBoard.activity[0].action, "import", "导入要在工作日志里留一行");

  // 恢复语义：同 id 撞上默认跳过，显式 replace 才覆盖
  const xferRestoreSkip = await xferImportBundle(xferBundle, "?mode=restore");
  assert.equal(xferRestoreSkip.data.imported.length, 0);
  assert.equal(xferRestoreSkip.data.skipped.length, 2, "同 id 的板默认一块不动");
  await request("PATCH", `/api/boards/${xferPackParentId}`, { body: { name: "被改过的名字" } });
  const xferRestoreReplace = await xferImportBundle(xferBundle, "?mode=restore&onConflict=replace");
  assert.equal(xferRestoreReplace.data.imported.length, 2);
  assert.equal(xferRestoreReplace.data.imported[0].id, xferPackParentId, "恢复要落回原来那块板");
  const xferRestoredBoard = (await request("GET", `/api/boards/${xferPackParentId}`)).data.board;
  assert.equal(xferRestoredBoard.name, "搬家（冒烟）", "覆盖后回到包里的样子");
  assert.equal(xferRestoredBoard.cards.find((card) => card.type === "text").id, xferPackText.id, "恢复保住原卡片 id");
  assert.ok(
    (await request("GET", `/api/boards/${xferPackParentId}/checkpoints`)).data.checkpoints.some(
      (item) => item.reason === "import",
    ),
    "覆盖前要留一份自动快照",
  );

  // 排版 HTML 自带载荷：发出去给人看的那份文件，对方也能导回自己的画板（图片跟着走）
  const xferPackHtml = await (await fetch(`${base}/api/boards/${xferPackParentId}/export?format=html`)).text();
  assert.ok(xferPackHtml.includes('id="blotboard-bundle"'), "HTML 产物要带画板载荷");
  assert.ok(xferPackHtml.includes(`data-asset="${xferPackUpload.id}"`), "内联图片要标出它是哪个上传件");
  assert.ok(!xferPackHtml.includes("</script>\\u003c"), "载荷不能把 script 标签提前截断");
  const xferFromHtml = await xferImportBundle(xferPackHtml);
  assert.equal(xferFromHtml.status, 201, JSON.stringify(xferFromHtml.data).slice(0, 300));
  const xferHtmlBoard = (await request("GET", `/api/boards/${xferFromHtml.data.imported[0].id}`)).data.board;
  assert.equal(xferHtmlBoard.cards.length, 5, "从 HTML 导回来的板一张卡不少");
  assert.ok(xferHtmlBoard.cards.find((card) => card.type === "image").file.uploadId, "图片要能从 HTML 里的 data URI 还原");
  const xferPlainHtml = await (await fetch(`${base}/api/boards/${xferPackParentId}/export?format=html&data=0`)).text();
  assert.ok(!xferPlainHtml.includes('id="blotboard-bundle"'), "data=0 就是一份纯给人看的产物");

  // 一份 HTML 装一整批板（分组 / 整库）：总目录 + 每块板自己的抬头
  const xferGroupHtml = await (await fetch(`${base}/api/boards/export?group=${encodeURIComponent("搬家组")}&format=html`)).text();
  assert.ok(xferGroupHtml.includes("board-index"), "多块板要有一页总目录");
  assert.ok(xferGroupHtml.includes("搬家（冒烟）"), "总目录里要列出每块板");
  const xferGroupMd = await (await fetch(`${base}/api/boards/export?group=${encodeURIComponent("搬家组")}&format=md`)).text();
  assert.ok(xferGroupMd.includes("---"), "多块板的 Markdown 之间要有分隔");

  // 单块板的 JSON（画板配置里那份）也认；信封走错口子要说清该去哪
  const xferSingleJson = (await request("GET", `/api/boards/${xferPackParentId}/export?format=json`)).data.board;
  const xferFromSingle = await xferImportBundle(xferSingleJson);
  assert.equal(xferFromSingle.status, 201);
  assert.equal((await request("GET", `/api/boards/${xferFromSingle.data.imported[0].id}`)).data.board.cards.length, 5);
  const xferEnvelopeIn = await xferImportBundle(
    (await request("GET", `/api/boards/${xferPackParentId}/export?format=cards`)).data.envelope,
  );
  assert.equal(xferEnvelopeIn.status, 400);
  assert.ok(xferEnvelopeIn.data.error.includes("/ingest"), xferEnvelopeIn.data.error);
  const xferJunkIn = await xferImportBundle({ hello: "world" });
  assert.equal(xferJunkIn.status, 400);
  const xferAnonymousImport = await fetch(`${base}/api/boards/import`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(xferBundle),
  });
  assert.equal(xferAnonymousImport.status, 403, "导入是写操作，得有写权限");

  // 单块板也能直接要一份包（不必绕去集合口）
  const xferSingleBundle = await request("GET", `/api/boards/${xferPackParentId}/export?format=bundle`);
  assert.equal(xferSingleBundle.data.bundle.boards.length, 1);
  assert.equal(
    (await request("GET", `/api/boards/${xferPackParentId}/export?format=bundle&children=1`)).data.bundle.boards.length,
    2,
  );

  /* 9.8.06b 认错的导入参数：**当场 400 且一个字不写**（拼错 mode 以前会静默退回 copy，
     于是「恢复备份」变成「又复制了一份」，调用方从 201 里看不出意图被改过） */
  const xferBoardsBefore = (await request("GET", "/api/boards")).data.boards.length;
  for (const [query, expect] of [
    ["?mode=restroe", "mode"],
    ["?onConflict=replce", "onConflict"],
    ["?mode=copy&onConflict=nope", "onConflict"],
  ]) {
    const rejected = await xferImportBundle(xferBundle, query);
    assert.equal(rejected.status, 400, `${query} 应当被拒：${JSON.stringify(rejected.data).slice(0, 200)}`);
    assert.ok(rejected.data.error.includes(expect), rejected.data.error);
  }
  // body 里写的那份同样要校验（query 与 body 是同一套参数，只挡一边等于没挡）
  const xferBadBody = await xferImportBundle({ bundle: xferBundle, mode: "restroe" });
  assert.equal(xferBadBody.status, 400);
  assert.ok(xferBadBody.data.error.includes("mode"), xferBadBody.data.error);
  assert.equal(
    (await request("GET", "/api/boards")).data.boards.length,
    xferBoardsBefore,
    "参数不合法的导入必须零写入：一块板都不许落地",
  );
  // 缺省仍是缺省、合法值照旧
  const xferDefaultsOk = await xferImportBundle(xferBundle);
  assert.equal(xferDefaultsOk.status, 201);
  assert.equal(xferDefaultsOk.data.mode, "copy");
  assert.equal(xferDefaultsOk.data.onConflict, "skip");
  const xferExplicitOk = await xferImportBundle(xferBundle, "?mode=copy&onConflict=replace");
  assert.equal(xferExplicitOk.status, 201);
  assert.equal(xferExplicitOk.data.onConflict, "replace");

  /* 9.8.06c HTTP 响应包装 `{ok,bundle}`：共享解析入口认它（浏览器库与服务端同一条口径） */
  const xferWrapped = await xferImportBundle({ ok: true, bundle: xferBundle });
  assert.equal(xferWrapped.status, 201, JSON.stringify(xferWrapped.data).slice(0, 200));
  assert.equal(xferWrapped.data.imported.length, 2, "包了一层也要原样收下");
  // 存下来的是一次**失败**的导出：得说清这份文件里根本没有画板，别让人去怀疑自己的文件
  const xferFailedExport = await xferImportBundle({ ok: false, error: "画板不存在：b_nope" });
  assert.equal(xferFailedExport.status, 400);
  assert.ok(xferFailedExport.data.error.includes("失败的导出"), xferFailedExport.data.error);

  for (const id of [
    xferPackParentId,
    xferPackChildId,
    ...xferCopied.data.imported.map((item) => item.id),
    ...xferFromHtml.data.imported.map((item) => item.id),
    ...xferFromSingle.data.imported.map((item) => item.id),
    ...xferDefaultsOk.data.imported.map((item) => item.id),
    ...xferExplicitOk.data.imported.map((item) => item.id),
    ...xferWrapped.data.imported.map((item) => item.id),
  ]) {
    await request("DELETE", `/api/boards/${id}`);
  }

  /* 9.8.07 分卷：**导出声明的那批板必须一块不少**。
     以前 selectBoards 攒够 BUNDLE_LIMITS.boards 就 break，一个 201 块板的分组导出去只有
     200 块、HTTP 还是 200、notes 还是空的——用户手里那份「成功的备份」是残的，
     而残不残只有真去恢复那天才知道。现在超限一律分卷，每一卷都是完整可导入的包。 */
  step("board-bundle-volumes");
  const volLimit = 200;
  const volGroup = "分卷组（冒烟）";
  const volIds = [];
  const volMake = async (count, group) => {
    const made = [];
    for (let at = 0; at < count; at += 1) {
      const created = await request("POST", "/api/boards", { body: { name: `卷${at}`, group } });
      made.push(created.data.board.id);
    }
    volIds.push(...made);
    return made;
  };
  const volExport = (query) => request("GET", `/api/boards/export?group=${encodeURIComponent(volGroup)}&${query}`);

  // 上限之内：跟以前一模一样，一份包、没有分卷标记
  await volMake(volLimit - 1, volGroup);
  const volAt199 = await volExport("format=json&assets=0");
  assert.equal(volAt199.status, 200);
  assert.equal(volAt199.data.bundle.boards.length, volLimit - 1, "199 块要整份给出");
  assert.equal(volAt199.data.bundle.volume, undefined, "没超限就不该有分卷标记");

  // 正好压线：仍是一份完整的包
  await volMake(1, volGroup);
  const volAt200 = await volExport("format=json&assets=0");
  assert.equal(volAt200.status, 200);
  assert.equal(volAt200.data.bundle.boards.length, volLimit, "200 块（正好上限）要整份给出");
  assert.equal(volAt200.data.bundle.volume, undefined);

  // 超一块：不许再回一份「看着成功」的残包
  await volMake(1, volGroup);
  const volAt201 = await volExport("format=json&assets=0");
  assert.equal(volAt201.status, 413, `201 块必须显式拒绝，实际 ${volAt201.status}`);
  assert.equal(volAt201.data.ok, false);
  assert.equal(volAt201.data.plan.total, volLimit + 1, "拒绝时要报出完整总数");
  assert.equal(volAt201.data.plan.volumes, 2);
  assert.ok(volAt201.data.error.includes("volume="), "错误里要给出取回路径");

  // plan=1 只回计划不打包
  const volPlan = await volExport("format=json&assets=0&plan=1");
  assert.equal(volPlan.status, 200);
  assert.equal(volPlan.data.plan.volumes, 2);
  assert.equal(volPlan.data.plan.slices[0].count, volLimit);
  assert.equal(volPlan.data.plan.slices[1].count, 1);
  assert.ok(volPlan.data.plan.slices[0].url.includes("volume=1"), "计划里要带每一卷的取回地址");

  // 逐卷取回：合起来**一块不少、一块不重**
  const volSeen = new Set();
  for (const slice of volPlan.data.plan.slices) {
    const volPart = await volExport(`format=json&assets=0&volume=${slice.index}`);
    assert.equal(volPart.status, 200);
    assert.equal(volPart.data.bundle.boards.length, slice.count, `第 ${slice.index} 卷的板数要对得上计划`);
    assert.equal(volPart.data.bundle.volume.index, slice.index);
    assert.equal(volPart.data.bundle.volume.total, 2);
    assert.equal(volPart.data.bundle.volume.totalBoards, volLimit + 1);
    assert.ok(volPart.data.bundle.notes.some((note) => note.includes("分卷")), "卷上要写清自己是第几卷");
    for (const board of volPart.data.bundle.boards) volSeen.add(board.id);
  }
  assert.equal(volSeen.size, volLimit + 1, "两卷合起来要覆盖整批，一块都不能少");
  assert.ok(volIds.every((id) => volSeen.has(id)), "每一块建出来的板都要出现在某一卷里");

  // 越界的卷号当场报错，不静默给空包
  const volBad = await volExport("format=json&volume=99");
  assert.equal(volBad.status, 400);
  assert.ok(volBad.data.error.includes("volume"), volBad.data.error);

  // 排版导出与 Markdown 走同一条口径（一份 723 块板的 HTML 同样装不下）
  const volHtml = await fetch(`${base}/api/boards/export?group=${encodeURIComponent(volGroup)}&format=html`);
  assert.equal(volHtml.status, 413, "HTML 超限也要拒绝，不能悄悄少排几块板");
  const volHtmlPart = await fetch(`${base}/api/boards/export?group=${encodeURIComponent(volGroup)}&format=html&volume=2`);
  assert.equal(volHtmlPart.status, 200);
  const volMd = await fetch(`${base}/api/boards/export?group=${encodeURIComponent(volGroup)}&format=md`);
  assert.equal(volMd.status, 413);

  // 一卷导回去照样立得起来（分卷不是「另一种格式」，就是画板包）
  const volRestore = await xferImportBundle((await volExport("format=json&assets=0&volume=2")).data.bundle);
  assert.equal(volRestore.status, 201);
  assert.equal(volRestore.data.imported.length, 1);
  volIds.push(...volRestore.data.imported.map((item) => item.id));

  // 种子 + 子板递归 + 环状引用：挑板不再因为容量提前 break，环由去重挡住
  const volSeedA = (await request("POST", "/api/boards", { body: { name: "环 A（冒烟）" } })).data.board.id;
  const volSeedB = (await request("POST", "/api/boards", { body: { name: "环 B（冒烟）" } })).data.board.id;
  const volKid = (await request("POST", "/api/boards", { body: { name: "环 A 的子板", parentId: volSeedA } })).data.board.id;
  volIds.push(volSeedA, volSeedB, volKid);
  await request("POST", `/api/boards/${volSeedA}/cards`, { body: { type: "board", title: "去 B", boardRef: { boardId: volSeedB } } });
  await request("POST", `/api/boards/${volSeedB}/cards`, { body: { type: "board", title: "回 A", boardRef: { boardId: volSeedA } } });
  const volCycle = await request("GET", `/api/boards/export?ids=${volSeedA}&format=json&assets=0`);
  assert.equal(volCycle.status, 200, "互相指的两块板不该把挑板转成死循环");
  assert.deepEqual(
    volCycle.data.bundle.boards.map((board) => board.id).sort(),
    [volSeedA, volSeedB, volKid].sort(),
    "子板与被 board 卡指到的板都要跟着走",
  );

  for (const id of volIds) await request("DELETE", `/api/boards/${id}`);

  /* 9.8.1 帮助文档（docs/guide/*.md → /api/docs + /docs 页） */
  step("docs");
  const docIndex = await request("GET", "/api/docs");
  assert.equal(docIndex.status, 200);
  assert.ok(docIndex.data.total >= 1, `帮助页数 ${docIndex.data.total}`);
  assert.ok(docIndex.data.groups.length >= 1, "目录要分组");
  const docFlat = docIndex.data.groups.flatMap((group) => group.docs);
  assert.equal(docFlat.length, docIndex.data.total, "分组里的页数要等于总数");
  assert.ok(
    docFlat.every((item) => item.slug && item.title && Number.isFinite(item.order)),
    "每一页都要有 slug / 标题 / 序号（frontmatter 缺了也得有兜底）",
  );
  // 组内按 order 递增，组的先后 = 组内最小序号的先后（listDocs 的口径）
  assert.deepEqual(
    docFlat.map((item) => item.order),
    [...docFlat.map((item) => item.order)].sort((a, b) => a - b),
    "整份目录要按 order 排好",
  );
  const firstDoc = docFlat[0].slug;
  const docOne = await request("GET", `/api/docs?slug=${firstDoc}`);
  assert.equal(docOne.status, 200);
  assert.equal(docOne.data.doc.slug, firstDoc);
  assert.ok(docOne.data.doc.body.length > 40, "正文不能是空的");
  assert.ok(!docOne.data.doc.body.startsWith("---"), "frontmatter 要被剥掉，别当正文渲染");
  const docMd = await fetch(`${base}/api/docs?slug=${firstDoc}&format=md`);
  assert.equal(docMd.status, 200);
  assert.ok((docMd.headers.get("content-type") || "").includes("markdown"), "format=md 要给 text/markdown");
  assert.equal(await docMd.text(), docOne.data.doc.body, "两种格式必须是同一份正文");
  // slug 是文件名，不能变成任意路径：穿越与不存在都得是 404 而不是读到别的文件
  assert.equal((await request("GET", "/api/docs?slug=../../package")).status, 404, "路径穿越要挡住");
  assert.equal((await request("GET", "/api/docs?slug=no-such-page")).status, 404);
  const docPage = await fetch(`${base}/docs`);
  assert.equal(docPage.status, 200);
  assert.ok((await docPage.text()).includes("帮助"), "帮助页要能打开");

  /* 10. 持久化 + 页面 */
  /* 9.9 性能相关的新接口：条件拉取 / 批量改删 / 响应压缩 */
  step("since");
  const fullBoard = await request("GET", `/api/boards/${boardId}`);
  assert.equal(fullBoard.status, 200);
  const rev = fullBoard.data.board.updatedAt;
  const unchanged = await request("GET", `/api/boards/${boardId}?since=${rev}`);
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.data.unchanged, true, "版本号一致时应只回 unchanged");
  assert.equal(unchanged.data.board, undefined, "unchanged 时不该再带整块板");
  const staleSince = await request("GET", `/api/boards/${boardId}?since=${rev - 1}`);
  assert.ok(staleSince.data.board, "版本号对不上时应返回整块板");

  step("bulk-cards");
  const bulkIds = [];
  for (let i = 0; i < 3; i += 1) {
    const made = await request("POST", `/api/boards/${boardId}/cards`, {
      body: { type: "text", title: `批量-${i}`, content: "批量操作用", x: 1000 + i * 40, y: 1000 },
    });
    assert.equal(made.status, 201);
    assert.ok(made.data.updatedAt > 0, "写接口应带回服务端 updatedAt");
    bulkIds.push(made.data.card.id);
  }
  const bulkPatch = await request("PATCH", `/api/boards/${boardId}/cards`, {
    body: { ids: bulkIds, patch: { color: "violet" } },
  });
  assert.equal(bulkPatch.status, 200);
  assert.equal(bulkPatch.data.updated, 3);
  assert.ok(bulkPatch.data.cards.every((card) => card.color === "violet"), "批量改色应全部生效");
  const bulkBadIds = await request("PATCH", `/api/boards/${boardId}/cards`, { body: { ids: [], patch: {} } });
  assert.equal(bulkBadIds.status, 400, "空 ids 应被拒绝");
  const bulkDelete = await request("DELETE", `/api/boards/${boardId}/cards`, {
    body: { ids: [...bulkIds, "c_not_there"] },
  });
  assert.equal(bulkDelete.status, 200);
  assert.equal(bulkDelete.data.removed.length, 3, "不存在的 id 应被跳过而不是报错");
  const afterBulk = await request("GET", `/api/boards/${boardId}`);
  assert.ok(
    bulkIds.every((id) => !afterBulk.data.board.cards.some((card) => card.id === id)),
    "批量删除后卡片不该还在",
  );
  const bulkNoAuth = await fetch(`${base}/api/boards/${boardId}/cards`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: bulkIds }),
  });
  assert.equal(bulkNoAuth.status, 403, "批量接口同样要走写鉴权");

  /* 9.5 评论（画板批注）：右键标记 → 处理 → 归档，以及它跟卡片/连线的级联 */
  step("comments");
  const cmCardA = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "text", title: "要评论的卡", content: "这段文案再想想", x: 2000, y: 100 },
  });
  const cmCardB = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "text", title: "评论的另一头", x: 2400, y: 100 },
  });
  const cmCardAId = cmCardA.data.card.id;
  const cmCardBId = cmCardB.data.card.id;
  const cmEdge = await request("POST", `/api/boards/${boardId}/edges`, {
    body: { from: cmCardAId, to: cmCardBId, label: "评论用" },
  });
  const cmEdgeId = cmEdge.data.edge.id;

  const cardComment = await request("POST", `/api/boards/${boardId}/comments`, {
    body: { target: "card", targetId: cmCardAId, text: "标题太长了，砍成一句" },
  });
  assert.equal(cardComment.status, 201);
  assert.match(cardComment.data.comment.id, /^cm_[a-z0-9]+$/);
  assert.equal(cardComment.data.comment.resolved, false);
  assert.ok(cardComment.data.updatedAt > 0, "评论写接口应带回服务端 updatedAt");
  const cardCommentId = cardComment.data.comment.id;

  const edgeComment = await request("POST", `/api/boards/${boardId}/comments`, {
    body: { target: "edge", targetId: cmEdgeId, text: "这条线的语义应该是阻塞" },
  });
  assert.equal(edgeComment.status, 201);
  const edgeCommentId = edgeComment.data.comment.id;

  const pinComment = await request("POST", `/api/boards/${boardId}/comments`, {
    body: { target: "board", text: "这一片留白之后补个流程图", x: 2200, y: 600 },
  });
  assert.equal(pinComment.status, 201);
  assert.equal(pinComment.data.comment.x, 2200);
  const boardNote = await request("POST", `/api/boards/${boardId}/comments`, {
    body: { target: "board", text: "整块板的口径统一成「切片」" },
  });
  assert.equal(boardNote.data.comment.x, null, "不给坐标就是不钉在画布上的整板留言");

  // 校验：空正文、指向不存在的目标、目标 id 类型不对，都不该落库
  const emptyComment = await request("POST", `/api/boards/${boardId}/comments`, {
    body: { target: "card", targetId: cmCardAId, text: "   " },
  });
  assert.equal(emptyComment.status, 400);
  const ghostTarget = await request("POST", `/api/boards/${boardId}/comments`, {
    body: { target: "card", targetId: "c_not_here", text: "挂在不存在的卡上" },
  });
  assert.equal(ghostTarget.status, 404);
  const wrongIdKind = await request("POST", `/api/boards/${boardId}/comments`, {
    body: { target: "edge", targetId: cmCardAId, text: "拿卡片 id 当连线 id" },
  });
  assert.equal(wrongIdKind.status, 400);

  const anonComment = await request("POST", `/api/boards/${boardId}/comments`, {
    headers: { "content-type": "application/json" },
    body: { target: "board", text: "匿名评论" },
  });
  assert.equal(anonComment.status, 403, "评论同样要走写鉴权");

  // agent 也能评论：这是「读完板子把意见写回去」那条路
  const agentComment = await request("POST", `/api/boards/${boardId}/comments`, {
    headers: AGENT(RUNNER_TOKEN),
    body: { target: "card", targetId: cmCardAId, text: "agent：这里缺一个数据来源", createdBy: "agent" },
  });
  assert.equal(agentComment.status, 201);
  assert.equal(agentComment.data.comment.createdBy, "agent");

  // 读：默认只回未解决的
  const openList = await request("GET", `/api/boards/${boardId}/comments`);
  assert.equal(openList.status, 200);
  assert.equal(openList.data.total, 5, `未解决评论数 ${openList.data.total}`);
  const byCard = await request("GET", `/api/boards/${boardId}/comments?target=card&targetId=${cmCardAId}`);
  assert.equal(byCard.data.total, 2, "按目标收窄应只回这张卡上的");

  // 回复：挂在原评论下面，不另起一条
  const replied = await request("POST", `/api/boards/${boardId}/comments/${cardCommentId}/replies`, {
    body: { text: "改完了，见新标题" },
  });
  assert.equal(replied.status, 201);
  assert.equal(replied.data.comment.replies.length, 1);
  assert.equal(replied.data.comment.replies[0].text, "改完了，见新标题");
  const emptyReply = await request("POST", `/api/boards/${boardId}/comments/${cardCommentId}/replies`, { body: { text: "" } });
  assert.equal(emptyReply.status, 400);

  // 改正文 / 标记解决
  const edited = await request("PATCH", `/api/boards/${boardId}/comments/${cardCommentId}`, {
    body: { text: "标题砍成一句，别超过 12 个字" },
  });
  assert.equal(edited.data.comment.text, "标题砍成一句，别超过 12 个字");
  const resolved = await request("PATCH", `/api/boards/${boardId}/comments/${cardCommentId}`, { body: { resolved: true } });
  assert.equal(resolved.data.comment.resolved, true);
  assert.ok(resolved.data.comment.resolvedAt > 0);
  const afterResolve = await request("GET", `/api/boards/${boardId}/comments`);
  assert.equal(afterResolve.data.total, 4, "解决后不该再出现在默认列表里");
  const resolvedOnly = await request("GET", `/api/boards/${boardId}/comments?status=resolved`);
  assert.equal(resolvedOnly.data.total, 1);
  const allComments = await request("GET", `/api/boards/${boardId}/comments?status=all`);
  assert.equal(allComments.data.total, 5);
  const ghostComment = await request("PATCH", `/api/boards/${boardId}/comments/cm_nothere`, { body: { resolved: true } });
  assert.equal(ghostComment.status, 404);

  // 整块板的 GET 自带评论表 + 计数（前端画气泡、左栏角标都吃这一份）
  const boardWithComments = await request("GET", `/api/boards/${boardId}`);
  assert.equal(boardWithComments.data.board.comments.length, 5);
  assert.equal(boardWithComments.data.board.counts.openComments, 4);
  const listWithComments = await request("GET", "/api/boards");
  assert.equal(listWithComments.data.boards[0].counts.openComments, 4);

  // 导出：卡片评论跟着卡片走，画布/连线评论单列一节
  const mdWithComments = await fetch(`${base}/api/boards/${boardId}/export?format=md`, { headers: BROWSER });
  const mdText = await mdWithComments.text();
  assert.ok(mdText.includes("agent：这里缺一个数据来源"), "导出的 Markdown 要带上卡片评论");
  assert.ok(mdText.includes("这一片留白之后补个流程图"), "画布评论也要出现在导出里");
  const jsonWithComments = await request("GET", `/api/boards/${boardId}/export?format=json`);
  assert.equal(jsonWithComments.data.board.comments.length, 5);

  // 转 Issue 时把这张卡上还没处理的评论一起下发
  const noteTask = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "task", title: "按评论改文案", task: { goal: "按画板上的评论改文案" } },
  });
  const noteTaskId = noteTask.data.card.id;
  await request("POST", `/api/boards/${boardId}/comments`, {
    body: { target: "card", targetId: noteTaskId, text: "改的时候顺手把口径统一成「切片」" },
  });
  const noteIssue = await request("POST", `/api/boards/${boardId}/cards/${noteTaskId}/issue`);
  assert.equal(noteIssue.status, 201);
  assert.ok(
    lastIssueDescription.includes("改的时候顺手把口径统一成「切片」"),
    "未解决的评论应随卡片一起进 Issue 描述",
  );

  // 级联：删连线带走线上的评论，删卡带走卡上的评论（和它那些线上的）
  await request("DELETE", `/api/boards/${boardId}/edges/${cmEdgeId}`);
  const afterEdgeDrop = await request("GET", `/api/boards/${boardId}/comments?status=all`);
  assert.ok(
    !afterEdgeDrop.data.comments.some((comment) => comment.id === edgeCommentId),
    "连线删掉后，挂在它上面的评论不该留成孤儿",
  );
  await request("DELETE", `/api/boards/${boardId}/cards/${cmCardAId}`);
  const afterCardDrop = await request("GET", `/api/boards/${boardId}/comments?status=all`);
  assert.ok(
    !afterCardDrop.data.comments.some((comment) => comment.targetId === cmCardAId),
    "卡片删掉后，挂在它上面的评论也要一起走",
  );

  // 手动删一条
  const dropped = await request("DELETE", `/api/boards/${boardId}/comments/${boardNote.data.comment.id}`);
  assert.equal(dropped.status, 200);
  const afterDrop = await request("GET", `/api/boards/${boardId}/comments?status=all`);
  assert.ok(!afterDrop.data.comments.some((comment) => comment.id === boardNote.data.comment.id));

  // whole 不传 comments 时不该把评论清空（agent 重写卡片不等于清批注）
  const beforeWhole = await request("GET", `/api/boards/${boardId}`);
  const keptComments = beforeWhole.data.board.comments.length;
  assert.ok(keptComments > 0, "这一步得有评论在，才测得出 whole 会不会清空");
  const wholeKeep = await request("PUT", `/api/boards/${boardId}/whole`, {
    body: { cards: beforeWhole.data.board.cards, edges: [] },
  });
  assert.equal(wholeKeep.status, 200);
  const afterWhole = await request("GET", `/api/boards/${boardId}`);
  assert.equal(afterWhole.data.board.comments.length, keptComments, "whole 不传 comments 就不该动评论表");

  /**
   * comments 是**三态**，三条各来一次（口径见 lib/board-service.ts 的 whole 分支）：
   *   ① 不传（上面那条）→ 原样保留；
   *   ② 传非空数组   → 整表替换（落脚点已经不在的评论顺带剪掉）；
   *   ③ 传 `[]`      → 显式清空（这是「一次清掉全部批注」唯一的口）。
   * 三条都要有断言守着：② 与 ③ 缺了的话，把 `Array.isArray` 写成 `body.comments?.length`
   * 这种改动能悄悄把「清空」退化成「不动」，而 ① 的用例照样绿。
   */
  const liveCardId = beforeWhole.data.board.cards[0]?.id;
  assert.ok(liveCardId, "替换语义得有一张活着的卡当落脚点");
  const wholeReplace = await request("PUT", `/api/boards/${boardId}/whole`, {
    body: {
      cards: beforeWhole.data.board.cards,
      edges: [],
      comments: [{ target: "card", targetId: liveCardId, text: "整表替换后只剩这一条" }],
    },
  });
  assert.equal(wholeReplace.status, 200);
  const afterReplace = await request("GET", `/api/boards/${boardId}/comments?status=all`);
  assert.equal(afterReplace.data.comments.length, 1, "传了 comments 数组 = 整表替换");
  assert.equal(afterReplace.data.comments[0].text, "整表替换后只剩这一条");

  const wholeClear = await request("PUT", `/api/boards/${boardId}/whole`, {
    body: { cards: beforeWhole.data.board.cards, edges: [], comments: [] },
  });
  assert.equal(wholeClear.status, 200);
  const afterClear = await request("GET", `/api/boards/${boardId}/comments?status=all`);
  assert.equal(afterClear.data.comments.length, 0, "comments: [] = 显式清空，不是「不动」");

  /**
   * 连线上的批注要挺过整板改写（曾经挺不过）。
   *
   * whole 以前给每条边无条件重发 id，于是最保守的写法——GET 整块板、一个字不改、原样 PUT 回去——
   * 也会把挂在连线上的评论连根剪掉：评论按存活 edge id 过滤，id 一换就全成了悬空的。
   * 而指南写的是「comments 不传 = 一个字不动」，两边对不上，agent 无从察觉自己刚删了用户的批注。
   * 口径改成「同一对 from/to 就是同一条线」，这里把整条链路钉死。
   */
  {
    const eb = (await request("POST", "/api/boards", { body: { name: "连线评论往返" } })).data.board.id;
    const ea = (await request("POST", `/api/boards/${eb}/cards`, { body: { type: "text", title: "起点" } })).data.card.id;
    const ec = (await request("POST", `/api/boards/${eb}/cards`, { body: { type: "text", title: "终点" } })).data.card.id;
    const ed = (await request("POST", `/api/boards/${eb}/cards`, { body: { type: "text", title: "旁支" } })).data.card.id;
    const edge1 = (await request("POST", `/api/boards/${eb}/edges`, { body: { from: ea, to: ec, label: "原始标签" } })).data.edge;
    const edge2 = (await request("POST", `/api/boards/${eb}/edges`, { body: { from: ea, to: ed } })).data.edge;
    await request("POST", `/api/boards/${eb}/comments`, { body: { target: "card", targetId: ea, text: "卡片批注" } });
    await request("POST", `/api/boards/${eb}/comments`, { body: { target: "edge", targetId: edge1.id, text: "这条线画错了方向" } });
    await request("POST", `/api/boards/${eb}/comments`, { body: { target: "edge", targetId: edge2.id, text: "这条要删" } });

    // ① 原样回写：id 不变、三条评论一条不少
    const snap = (await request("GET", `/api/boards/${eb}`)).data.board;
    assert.equal(snap.comments.length, 3);
    const asIs = await request("PUT", `/api/boards/${eb}/whole`, { body: { cards: snap.cards, edges: snap.edges } });
    assert.equal(asIs.status, 200);
    const afterAsIs = (await request("GET", `/api/boards/${eb}`)).data.board;
    assert.deepEqual(
      afterAsIs.edges.map((edge) => edge.id).sort(),
      snap.edges.map((edge) => edge.id).sort(),
      "原样回写不该给连线换 id",
    );
    assert.equal(afterAsIs.comments.length, 3, "原样回写一条评论都不该丢（连线上的也是）");
    assert.ok(
      afterAsIs.comments.some((comment) => comment.target === "edge" && comment.targetId === edge1.id),
      "连线批注要跟着原来那条线",
    );
    assert.equal(afterAsIs.edges.find((edge) => edge.id === edge1.id).createdAt, snap.edges.find((edge) => edge.id === edge1.id).createdAt, "留住 id 就一并留住生日");

    // ② 改标签 + 换顺序：还是同一条线
    const shuffled = [...afterAsIs.edges].reverse().map((edge) => (edge.id === edge1.id ? { ...edge, label: "改过的标签", kind: "blocks" } : edge));
    assert.equal((await request("PUT", `/api/boards/${eb}/whole`, { body: { cards: afterAsIs.cards, edges: shuffled } })).status, 200);
    const afterEdit = (await request("GET", `/api/boards/${eb}`)).data.board;
    const relabeled = afterEdit.edges.find((edge) => edge.id === edge1.id);
    assert.ok(relabeled, "改标签 / 换顺序都不该换 id");
    assert.equal(relabeled.label, "改过的标签");
    assert.equal(relabeled.kind, "blocks");
    assert.equal(afterEdit.comments.length, 3, "改标签也不该动评论表");

    // ③ 真删掉一条线：只有它那条评论跟着走（「删边 = 连它的批注也走」这条语义没变）
    assert.equal(
      (await request("PUT", `/api/boards/${eb}/whole`, {
        body: { cards: afterEdit.cards, edges: afterEdit.edges.filter((edge) => edge.id === edge1.id) },
      })).status,
      200,
    );
    const afterDrop = (await request("GET", `/api/boards/${eb}`)).data.board;
    assert.equal(afterDrop.edges.length, 1);
    assert.equal(afterDrop.edges[0].id, edge1.id);
    assert.equal(afterDrop.comments.length, 2, "被删掉那条线的批注要一起清掉");
    assert.ok(!afterDrop.comments.some((comment) => comment.targetId === edge2.id), "悬空的连线批注不该留着");

    // ④ 显式 comments=[] 照旧是清空；未知字段与任务引用不受影响
    const taskCard = (await request("POST", `/api/boards/${eb}/cards`, { body: { type: "task", title: "任务卡" } })).data.card;
    const issued = await request("POST", `/api/boards/${eb}/cards/${taskCard.id}/issue`);
    assert.equal(issued.status, 201);
    assert.ok(issued.data.card.task.issueId, "转 Issue 之后卡上应有 issueId，才测得出整板改写会不会把它抹掉");
    const withTask = (await request("GET", `/api/boards/${eb}`)).data.board;
    // 顺带守住铁律 1：这条路上塞一张未知类型的卡，它的专属字段要原样活下来
    const alien = { id: "c_edge_alien", type: "not-a-real-pack", title: "外星卡", mysteryField: { keep: "me" } };
    assert.equal(
      (await request("PUT", `/api/boards/${eb}/whole`, {
        body: { cards: [...withTask.cards, alien], edges: withTask.edges, comments: [] },
      })).status,
      200,
    );
    const cleared = (await request("GET", `/api/boards/${eb}`)).data.board;
    assert.equal(cleared.comments.length, 0, "comments: [] 还是显式清空");
    assert.equal(cleared.edges[0].id, edge1.id, "清评论不影响连线 id");
    assert.deepEqual(cleared.cards.find((card) => card.id === alien.id).mysteryField, { keep: "me" }, "未知字段照旧只存不洗");
    assert.equal(
      cleared.cards.find((card) => card.id === taskCard.id).task.issueId,
      withTask.cards.find((card) => card.id === taskCard.id).task.issueId,
      "整板改写不该抹掉任务卡的 Issue 账本",
    );

    // ⑤ 回滚：快照回来的板，连线 id 与批注是那一刻的样子
    const cps = (await request("GET", `/api/boards/${eb}/checkpoints`)).data.checkpoints;
    assert.ok(cps.length, "whole 是打点入口，这一串改写应该留下快照");
    const restored = await request("POST", `/api/boards/${eb}/checkpoints/${cps[cps.length - 1].stamp}/restore`);
    assert.equal(restored.status, 200);
    const back = (await request("GET", `/api/boards/${eb}`)).data.board;
    assert.ok(back.comments.length >= 1, "回滚要把当时的批注带回来");
    assert.ok(back.edges.some((edge) => edge.id === edge1.id), "回滚回来的连线 id 还是原来那个");

    /**
     * **组合回归**：whole 保连线 id × 画板包搬家。
     *
     * 「原样 whole 不动连线 id」与「导出→导入连线评论跟着走」各有各的用例，
     * 但两件事接起来才是用户真正的动作：改完一轮板，再把它备份 / 搬到另一台。
     * 只要 whole 那步换了 id 而导出用的是换之前的评论表，批注就会在搬家途中掉队——
     * 掉的是用户写的字，且要等到搬完打开才发现。
     */
    const rtSnap = (await request("GET", `/api/boards/${eb}`)).data.board;
    const rtEdgeComment = rtSnap.comments.find((comment) => comment.target === "edge");
    assert.ok(rtEdgeComment, "这块板上得有一条连线批注，才测得出它会不会在搬家途中掉队");
    // 先原样 whole 一遍（模拟 agent 改完板回写），再导出成画板包
    assert.equal(
      (await request("PUT", `/api/boards/${eb}/whole`, { body: { cards: rtSnap.cards, edges: rtSnap.edges } })).status,
      200,
    );
    const rtExport = await request("GET", `/api/boards/export?ids=${eb}&format=json&assets=0`);
    assert.equal(rtExport.status, 200);
    const rtBundleBoard = rtExport.data.bundle.boards.find((board) => board.id === eb);
    const rtExported = rtBundleBoard.comments.find((comment) => comment.target === "edge");
    assert.ok(rtExported, "原样 whole 之后导出，连线批注不能凭空少一条");
    assert.ok(
      rtBundleBoard.edges.some((edge) => edge.id === rtExported.targetId),
      "导出的包里，连线批注指的那条边必须真的还在包里（whole 换 id 的话这里就悬空了）",
    );
    // 搬到另一台：副本会重发 id，批注要跟着新 id 走，不能指向不存在的边
    const rtCopy = await xferImportBundle(rtExport.data.bundle);
    assert.equal(rtCopy.status, 201);
    const rtCopyId = rtCopy.data.imported[0].id;
    const rtCopyBoard = (await request("GET", `/api/boards/${rtCopyId}`)).data.board;
    const rtCopyComment = rtCopyBoard.comments.find((comment) => comment.target === "edge");
    assert.ok(rtCopyComment, "搬过去的副本上，连线批注要还在");
    assert.equal(rtCopyComment.text, rtExported.text, "批注的正文是用户写的字，一个字都不能变");
    assert.ok(
      rtCopyBoard.edges.some((edge) => edge.id === rtCopyComment.targetId),
      "副本里的连线批注要挂在副本自己的那条边上",
    );
    await request("DELETE", `/api/boards/${rtCopyId}`);

    await request("DELETE", `/api/boards/${eb}`);
  }

  await request("DELETE", `/api/boards/${boardId}/cards/${cmCardBId}`);

  step("gzip");
  const packed = await fetch(`${base}/api/boards/${boardId}`, {
    headers: { ...BROWSER, "accept-encoding": "gzip" },
  });
  assert.equal(packed.headers.get("content-encoding"), "gzip", "够大的 JSON 响应应该压缩");
  const packedBody = await packed.json();
  assert.ok(packedBody.board.cards.length > 0, "压缩后的内容仍要能正常解出来");

  /* 10. 持久化 + 页面（存储是一板一文件：data/boards/<id>.json + _index.json） */
  step("persist");
  const boardsDir = path.join(dataDir, "boards");
  const boardFiles = fs.readdirSync(boardsDir).filter((name) => /^b_[a-z0-9_]+\.json$/.test(name));
  assert.equal(boardFiles.length, 1, `落库画板文件数 ${boardFiles.length}`);
  const persisted = JSON.parse(fs.readFileSync(path.join(boardsDir, boardFiles[0]), "utf8"));
  assert.ok(persisted.cards.length >= 11, `落库卡片数 ${persisted.cards.length}`);
  const persistedIndex = JSON.parse(fs.readFileSync(path.join(boardsDir, "_index.json"), "utf8"));
  assert.deepEqual(persistedIndex.order, [persisted.id], "索引顺序应与实际板文件一致");

  step("page");
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  // 功能开关经 body dataset 下发：这个实例只配了任务后端。
  // 只看 <body> 标签本身——RSC flight 载荷里 undefined 的 prop 会以 "$undefined" 带着键名出现，
  // 但那不落到 DOM 上，dataset 的真相在标签属性里
  const pageBody = (await page.text()).match(/<body[^>]*>/)?.[0] || "";
  assert.ok(pageBody.includes('data-features="tasks"'), `dataset 应只报 tasks 开着：${pageBody}`);
  assert.ok(pageBody.includes('data-task-backend="goal-agent"'), `dataset 应下发任务后端种类：${pageBody}`);
  assert.ok(!pageBody.includes("data-aidocs-base"), "知识库没配置就不该下发它的地址");
  assert.ok(!pageBody.includes("data-book-library"), "书库没配置就不该下发它的地址");

  /* 11. 能力自描述（配置形态：tasks 开、search/library 关） */
  /* 端口自动顺延：占住一个口，让新实例从它开始要——应该落到下一个，且自己知道自己在哪 */
  step("port-fallback");
  {
    const squatted = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => resolve(s));  // 占 127.0.0.1 就够：探测两个地址都查
    });
    const taken = squatted.address().port;
    const fbData = path.join(tmpRoot, "fallback-data");
    const fbChild = spawn(process.execPath, ["server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        BLOTBOARD_PORT: String(taken),
        BLOTBOARD_DATA_DIR: fbData,
        BLOTBOARD_GOAL_AGENT_SETTINGS: "",
        GOAL_AGENT_RUNNER_URL: "",
        AIDOCS_URL: "",
        BOOK_LIBRARY_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const landed = taken + 1;
      const base = `http://127.0.0.1:${landed}`;
      await waitForHealth(base, fbChild);
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.port, landed, "被占用时应顺延到下一个端口，且 health 报的是实际端口");
      // 实际端口要落盘，脚本/MCP 靠它找服务，不用去翻日志
      assert.equal(fs.readFileSync(path.join(fbData, "port"), "utf8").trim(), String(landed));
    } finally {
      fbChild.kill("SIGTERM");
      squatted.close();
    }
  }

  /**
   * 被删画板留下的快照目录：**故意留一段时间，但不是永远留**（lib/checkpoints.ts 孤儿清理）。
   *
   * 两条判定各验一次：板还在的目录一根汗毛都不能动；板没了、且目录闲置超过 TTL 才整个收走。
   * 顺带验 `TTL=0 = 永不清`。
   *
   * 为什么要起两个实例：清理是**进程内一次性**的（第一次 `GET /api/boards` 时触发），
   * 同一个进程里没法验两种 TTL。第一个实例用 TTL=0 建好现场并确认「不清」，
   * 第二个实例接同一个数据目录、TTL=30，确认「该清的清了、不该清的没动」。
   */
  step("checkpoint-orphans");
  {
    const orphanData = path.join(tmpRoot, "orphan-data");
    const cpDir = (boardId) => path.join(orphanData, "checkpoints", boardId);
    const spawnOrphan = async (ttlDays) => {
      const port = await freePort();
      const proc = spawn(process.execPath, ["server.mjs"], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          NODE_ENV: "production",
          BLOTBOARD_PORT: String(port),
          BLOTBOARD_PORT_STRICT: "1",
          BLOTBOARD_HOST: "127.0.0.1",
          BLOTBOARD_DATA_DIR: orphanData,
          BLOTBOARD_DATA_FILE: path.join(orphanData, "boards.json"),
          BLOTBOARD_UPLOADS_DIR: path.join(orphanData, "uploads"),
          BLOTBOARD_GOAL_AGENT_SETTINGS: "",
          GOAL_AGENT_RUNNER_URL: "",
          BLOTBOARD_RUNNER_URL: "",
          GOAL_AGENT_WEB_URL: "",
          AIDOCS_URL: "",
          BOOK_LIBRARY_URL: "",
          BLOTBOARD_CHECKPOINT_ORPHAN_TTL_DAYS: String(ttlDays),
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      proc.stderr.on("data", (chunk) => process.stderr.write(`[orphan] ${chunk}`));
      const orphanBase = `http://127.0.0.1:${port}`;
      await waitForHealth(orphanBase, proc);
      return { proc, base: orphanBase };
    };
    const orphanCall = async (base, method, url, body) => {
      const response = await fetch(`${base}${url}`, {
        method,
        headers: { "content-type": "application/json", "x-board-web": "1", origin: base },
        body: body == null ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json().catch(() => null) };
    };

    let first = null;
    let second = null;
    try {
      first = await spawnOrphan(0);
      // 两块板各打一份点：一块留着，一块删掉
      const alive = (await orphanCall(first.base, "POST", "/api/boards", { name: "留着的板" })).data.board.id;
      const doomed = (await orphanCall(first.base, "POST", "/api/boards", { name: "要删的板" })).data.board.id;
      for (const id of [alive, doomed]) {
        await orphanCall(first.base, "POST", `/api/boards/${id}/cards`, { type: "text", title: "一张卡" });
        // whole 是会打点的批量入口
        const detail = (await orphanCall(first.base, "GET", `/api/boards/${id}`)).data.board;
        await orphanCall(first.base, "PUT", `/api/boards/${id}/whole`, { cards: detail.cards, edges: [] });
        assert.ok(fs.existsSync(cpDir(id)), `${id} 该有快照目录了`);
      }

      assert.equal((await orphanCall(first.base, "DELETE", `/api/boards/${doomed}`)).status, 200);
      // 删板**不清**快照：那时候快照恰恰是把整块板捞回来的唯一依据
      assert.ok(fs.existsSync(cpDir(doomed)), "板刚删掉时快照目录必须还在（这是设计，不是遗漏）");

      // 把两个目录都拨到 40 天前：一个孤儿、一个板还活着
      const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      for (const id of [alive, doomed]) fs.utimesSync(cpDir(id), longAgo, longAgo);

      // TTL=0：一个都不许动
      assert.equal((await orphanCall(first.base, "GET", "/api/boards")).status, 200);
      assert.ok(fs.existsSync(cpDir(doomed)), "TTL=0 = 永不清，孤儿目录也得留着");
      assert.ok(fs.existsSync(cpDir(alive)), "TTL=0 时活着的板的快照当然也在");

      first.proc.kill("SIGTERM");
      // 等它真退出再起第二个：两个实例同时抱着一个数据目录，断言会打在半路上
      for (let i = 0; i < 80 && first.proc.exitCode === null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.notEqual(first.proc.exitCode, null, "第一个 orphan 实例没退干净");
      first = null;

      // TTL=30：孤儿收走，活着的板一根汗毛不动
      second = await spawnOrphan(30);
      assert.equal((await orphanCall(second.base, "GET", "/api/boards")).status, 200);
      assert.ok(!fs.existsSync(cpDir(doomed)), "板没了又闲置超过 TTL，快照目录该整个清掉");
      assert.ok(fs.existsSync(cpDir(alive)), "板还在就不许清，哪怕目录很久没动过");
      // 板本身也没被顺手动过
      assert.equal((await orphanCall(second.base, "GET", `/api/boards/${alive}`)).status, 200);
    } finally {
      for (const item of [first, second]) {
        if (!item) continue;
        item.proc.kill("SIGTERM");
      }
    }
  }

  /* CSS 变量体检：写了不存在的变量，CSS 会静默退成「无背景 / 无颜色」——
     浮层背景变透明就是这么来的，没有报错、只有肉眼能看出来，所以拿测试盯着 */
  step("css-vars");
  {
    const css = fs.readFileSync(path.join(PROJECT_ROOT, "app", "globals.css"), "utf8");
    const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
    // 运行时由内联 style 注入的（见 CardNode / CompareModal），静态文件里当然找不到
    defined.add("--card-accent");
    const missing = [...css.matchAll(/var\((--[a-z0-9-]+)\s*(?!,)\)/g)]
      .map((m) => m[1])
      .filter((name) => !defined.has(name));
    assert.deepEqual([...new Set(missing)], [], "globals.css 里用了没定义、也没给兜底值的 CSS 变量");
  }

  step("capabilities");
  const caps = await request("GET", "/api/capabilities");
  assert.equal(caps.status, 200);
  assert.equal(caps.data.service, "blotboard");
  assert.match(String(caps.data.version), /^\d+\.\d+\.\d+/);
  assert.deepEqual(caps.data.features, { tasks: true, search: false, library: false });
  // 任务后端自描述：这个实例配了 GOAL_AGENT_RUNNER_URL → goal-agent
  assert.deepEqual(caps.data.tasks, { backend: "goal-agent" });
  assert.equal(caps.data.cardTypes.length, 21, `卡片类型应 21 种，实际 ${caps.data.cardTypes.length}`);
  assert.ok(caps.data.cardTypes.includes("excalidraw") && caps.data.cardTypes.includes("data"));
  assert.ok(
    ["code", "table", "chart"].every((type) => caps.data.cardTypes.includes(type)),
    "第二波三种卡片包要出现在能力自描述里",
  );
  assert.equal(caps.data.envelope.format, "blotboard.cards");
  // 整理模式自描述：agent 不用猜 mode 怎么拼（真源是 lib/layout.ts 的 LAYOUT_MODES，一处改三处跟）
  assert.deepEqual(
    caps.data.layouts.map((item) => item.mode),
    ["tidy", "flow", "LR", "TB", "group", "grid", "timeline", "kanban", "matrix", "swimlane", "cluster"],
    "capabilities 要列出全部整理模式",
  );
  assert.ok(caps.data.layouts.every((item) => item.label && item.desc), "每种模式都要有人话说明");
  // mermaid 的诚实声明：卡面什么语法都渲，服务端导出只有流程图能出矢量图，其余降级源码块
  assert.deepEqual(caps.data.mermaid.serverExport, ["flowchart"]);
  assert.ok(caps.data.mermaid.clientRenders.includes("mermaid"), caps.data.mermaid.clientRenders);
  assert.ok(caps.data.mermaid.serverFallback.includes("源码块"), caps.data.mermaid.serverFallback);
  // 图表卡走同一条客户端渲染路径，但降级方式不同（出数据表而不是源码块）——也要说清楚
  assert.ok(caps.data.mermaid.chartCard.includes("数据表"), caps.data.mermaid.chartCard);
  // /api/skill?focus= 的合法值也自描述；skill 字段本身保持旧形状（已有调用方拿它直接拼 URL）
  assert.equal(caps.data.skillFocus.always, "auth", "鉴权那节永远附带，要说清楚");
  // 改板安全网：agent 探一次就知道「大改要不要自己先备份」
  assert.equal(caps.data.checkpoints.enabled, true);
  assert.equal(caps.data.checkpoints.keep, 5, "这个实例把保留上限压到 5（见启动 env）");
  assert.ok(caps.data.checkpoints.reasons.includes("whole") && caps.data.checkpoints.reasons.includes("ingest"), "要列出会打点的入口");
  assert.ok(caps.data.skillFocus.usage.includes("focus="), caps.data.skillFocus.usage);
  // 没有同名 focus 的那几类活也要自描述，别让调用方在十个名字里猜（桥接 Skill 漂移的根）
  assert.ok(
    caps.data.skillFocus.notSections.some((item) => item.wanted === "layout" && item.where === "api"),
    "capabilities 要说清楚「布局」这类活归在哪一节",
  );
  assert.ok(
    caps.data.skillFocus.values.some((item) => item.value === "cards" && item.hint),
    "focus 每个值都要带一句「这是哪类活」",
  );
  assert.deepEqual(caps.data.envelope.legacy, ["goal-board.cards"]);
  assert.ok(caps.data.specs.total >= 10, `规格总数 ${caps.data.specs.total}`);
  assert.ok(Array.isArray(caps.data.specs.enabled) && caps.data.specs.enabled.includes("feishu-message"));
  // 鉴权自描述：agent 探一次就知道 token 在哪、用哪个头，不用撞 403 再猜
  assert.equal(caps.data.auth.header, "x-auth-key");
  assert.equal(caps.data.auth.webHeader, "x-board-web");
  assert.equal(caps.data.auth.status, 403);
  // 这个实例用 BLOTBOARD_GOAL_AGENT_SETTINGS 共用 token
  assert.equal(caps.data.auth.source, "goal-agent-settings");
  assert.ok(caps.data.auth.hint.includes("internalApiToken"), caps.data.auth.hint);
  assert.ok(
    !JSON.stringify(caps.data.auth).includes(tmpRoot),
    `鉴权自描述不该泄露本机绝对路径：${JSON.stringify(caps.data.auth)}`,
  );
  // token 镜像：生效源是 settings.json，但 data/token 里也必须是同一个值——
  // 所有文档都教 agent「cat 数据目录下的 token」，这个文件一旦是旧值就是全员 403（真踩过）
  const mirrored = fs.readFileSync(path.join(dataDir, "token"), "utf8").trim();
  assert.equal(mirrored, RUNNER_TOKEN, "启动时应把生效 token 同步进 <数据目录>/token");
  const health = await request("GET", "/api/health");
  assert.equal(health.data.tokenSource, "goal-agent-settings", "health 要报出生效源，方便排 403");
  // 指南也只教这一条路：那个环境变量只存在于服务进程里，agent 的 shell 读不到
  const authShellSection = String((await request("GET", "/api/skill")).data);
  assert.ok(
    authShellSection.includes('TOKEN=$(cat "${BLOTBOARD_DATA_DIR:-./data}/token")'),
    "共用 token 形态也该教 cat data/token（别教读服务端才有的环境变量）",
  );
  // 配了外部 Runner 时，本地 Issue 端点一律 501 指路——真源在 Runner，不造第二份账本
  const issues501 = await request("GET", "/api/issues");
  assert.equal(issues501.status, 501, `goal-agent 模式下 /api/issues 应 501，实际 ${issues501.status}`);
  assert.ok(issues501.data.error.includes("Runner"), issues501.data.error);
  const issuePatch501 = await request("PATCH", "/api/issues/i_whatever", { body: { status: "done" } });
  assert.equal(issuePatch501.status, 501);

  /* /api/skill：按部署现场拼装的 agent 指南（这台是 goal-agent 后端 + 全部包打开 + search/library 未配） */
  step("skill");
  assert.equal(caps.data.skill, "/api/skill", "capabilities 应给 skill 指路");
  const skillMd = await request("GET", "/api/skill");
  assert.equal(skillMd.status, 200);
  const skillText = String(skillMd.data);
  assert.ok(skillText.includes("生成于"), "指南开头要注明生成时间");
  assert.ok(skillText.includes("Issue 真源在外部 Runner"), "goal-agent 形态应讲外部 Runner 链路");
  assert.ok(!skillText.includes("issues.json"), "goal-agent 形态不该讲 local 回写细节");
  assert.ok(skillText.includes("### 网页嵌入（html）"), "启用的包要有自己的小节");
  assert.ok(skillText.includes("### 待办（todo）"));
  assert.ok(!skillText.includes("### 图书（book）"), "book 包开着但书库未配置 → 小节略过");
  assert.ok(!skillText.includes("### 资料组（ref）"), "ref 同理");
  assert.ok(skillText.includes("外部服务未配置"), "略过的包要在摘要里交代原因");
  assert.ok(skillText.includes("feishu-message"), "启用规格清单要在指南里");
  // 鉴权章节：一条可复制的 shell 摆在最前面，且不吐本机绝对路径
  const authSection = skillText.split("\n## ").find((section) => section.startsWith("鉴权")) || "";
  assert.ok(authSection.includes("先把 token 拿到手"), "鉴权章节要开门见山讲 token 怎么拿");
  assert.ok(authSection.includes('curl -s -X POST') && authSection.includes("x-auth-key: $TOKEN"), authSection);
  assert.ok(authSection.includes("internalApiToken"), "这个实例与 Goal Agent 共用 token，要说清在哪");
  assert.ok(authSection.includes("/api/capabilities"), "要指路机器可读版");
  assert.ok(!skillText.includes(tmpRoot), "指南不该带本机绝对路径");
  /**
   * `x-forwarded-*` 默认不信（BLOTBOARD_TRUST_PROXY 没开）：这两个头谁都能伪造，
   * 信了的话「导出 / 指南里回指画板的链接」会整批指向攻击者那台机器。
   * 只有真站在反代后面才该开——那时候是代理写的，客户端带来的会被它覆盖。
   */
  const spoofed = await fetch(`${base}/api/skill?format=md&focus=api`, {
    headers: { "x-forwarded-host": "evil.example.com", "x-forwarded-proto": "https" },
  });
  const spoofedText = await spoofed.text();
  assert.ok(!spoofedText.includes("evil.example.com"), "默认不该信 x-forwarded-host");
  const exportSpoofed = await fetch(`${base}/api/boards/${boardId}/export?format=md`, {
    headers: { ...BROWSER, "x-forwarded-host": "evil.example.com" },
  });
  assert.ok(!(await exportSpoofed.text()).includes("evil.example.com"), "导出同样不该信 x-forwarded-host");
  // 读板与列板的差别（误报过：以为 /api/boards/{id} 不返回 cards）
  assert.ok(skillText.includes("不含 cards") && skillText.includes("带 cards / edges / comments"), "要讲清列表口与单板口的差别");
  // 外部后端下本地 Issue 端点回 501 是设计，不是坏了
  assert.ok(skillText.includes("501") && skillText.includes("设计不是坏了"), "要说明 501 是设计");
  const skillJson = await request("GET", "/api/skill?format=json");
  assert.equal(skillJson.status, 200);
  assert.equal(skillJson.data.taskBackend, "goal-agent");
  assert.deepEqual(skillJson.data.cardsSkipped, ["ref", "book"]);
  assert.ok(skillJson.data.cards.includes("html") && !skillJson.data.cards.includes("book"));
  assert.ok(Array.isArray(skillJson.data.sections) && skillJson.data.sections.length >= 8, `分节数 ${skillJson.data.sections?.length}`);
  assert.ok(skillJson.data.sections.every((section) => section.title && section.body));
  assert.equal(skillJson.data.focus, null, "不传 focus 就是全量");

  /* ?focus=：只输出相关章节（全量一两万字，agent 往往只是要往板上加几张卡）；鉴权那节永远附上 */
  const focusedJson = await request("GET", "/api/skill?format=json&focus=cards,tasks");
  assert.equal(focusedJson.status, 200);
  assert.deepEqual(focusedJson.data.focus, ["cards", "tasks"]);
  assert.deepEqual(
    focusedJson.data.sections.map((section) => section.id),
    ["auth", "cards", "tasks"],
    "focus=cards,tasks 只留这三节（auth 是永远附带的那节）",
  );
  /* 三条最短路（批量加内容 / 导入导出 / 只改布局）跟着 API 那节走，所以 /agent 页链的快速指南里就有 */
  const quickstartMd = String((await request("GET", "/api/skill?format=md&focus=api,pitfalls,links")).data);
  assert.ok(quickstartMd.includes("三条最短路"), "快速指南要带上三条最短操作示例");
  for (const snippet of ["/ingest", "download=1", "/tidy", "/state"]) {
    assert.ok(quickstartMd.includes(snippet), `三条最短路里少了 ${snippet}`);
  }
  assert.ok(quickstartMd.includes("别拿 `format=md` 当备份"), "要写明 markdown 不是可恢复的备份");

  const focusedMd = String((await request("GET", "/api/skill?focus=specs")).data);
  assert.ok(focusedMd.includes("focus=specs"), "markdown 抬头要说明这份是筛过的，别让 agent 以为文档残缺");
  assert.ok(focusedMd.includes("已启用的卡片规格"), "specs 这类活要拿到规格清单");
  assert.ok(!focusedMd.includes("## 常见坑"), "没要的章节不该出现");
  assert.ok(focusedMd.includes("## 鉴权"), "鉴权那节永远在");
  const badFocus = await request("GET", "/api/skill?focus=cards,nope");
  assert.equal(badFocus.status, 400, "focus 写错要 400，不能静默给一份少了几节的指南");
  assert.ok(badFocus.data.error.includes("nope") && badFocus.data.error.includes("envelope"), badFocus.data.error);

  /**
   * 400 之外还要**指路**：SKILL_FOCUS 是按活分的，「我只想改布局」这种明确的活没有同名 focus
   * （整理归在 api 那节）。外部桥接 Skill 就是这么把 focus 写成 `layout` 的——
   * 光回一句「不是合法取值 + 十个候选」，等于让 agent 在十个不像的名字里猜。
   */
  const layoutFocus = await request("GET", "/api/skill?focus=layout");
  assert.equal(layoutFocus.status, 400, "layout 不是合法 focus，照旧 400（不做静默别名）");
  assert.ok(layoutFocus.data.error.includes("tidy"), layoutFocus.data.error);
  assert.ok(layoutFocus.data.error.includes("layouts"), "要指到 /api/capabilities 的 layouts");
  const pluralFocus = await request("GET", "/api/skill?focus=card");
  assert.equal(pluralFocus.status, 400);
  assert.ok(pluralFocus.data.error.includes("cards"), pluralFocus.data.error);

  // /api/health 兼容：老字段都在，features 是加出来的
  const healthNow = await request("GET", "/api/health");
  assert.equal(healthNow.data.service, "blotboard");
  assert.equal(healthNow.data.runner, true, "配置了 mock Runner 时健康检查应探到它");
  assert.deepEqual(healthNow.data.features, { tasks: true, search: false, library: false });

  /* 11.5 卡片包：capabilities.cards 形状 · 开关 API · 停用挡新建 · 未知类型透传往返 */
  step("card-packs");
  // capabilities 的 cards 形状：[{ type, enabled }] × 21（cardTypes 兼容保留，前面已断言）
  assert.ok(Array.isArray(caps.data.cards), "capabilities 应带 cards 数组");
  assert.equal(caps.data.cards.length, 21, `cards 应 21 个包，实际 ${caps.data.cards?.length}`);
  assert.ok(
    caps.data.cards.every((pack) => typeof pack.type === "string" && typeof pack.enabled === "boolean"),
    "cards 每项都是 { type, enabled }",
  );

  const packList = await request("GET", "/api/card-packs");
  assert.equal(packList.status, 200);
  assert.deepEqual(
    packList.data.packs.map((pack) => pack.type).sort(),
    [...ALL_CARD_TYPES].sort(),
    "GET /api/card-packs 应列出全部 20 个包",
  );
  assert.ok(packList.data.packs.every((pack) => pack.enabled === true), "主实例种子把全部包打开");

  /* 升级路径：老实例的 card-packs.json 里没有新加的包。
     缺省口径必须跟着各包自己的 meta.defaultEnabled 走——
     code/table（默认集成员）自动可用，chart（声明了默认不启用）不能不请自来。
     写文件 → 读接口 → 建卡验证 → 复原，全程只碰这个隔离实例的数据目录。 */
  const packsFile = path.join(dataDir, "card-packs.json");
  const packsBackup = fs.readFileSync(packsFile, "utf8");
  const legacyTypes = ALL_CARD_TYPES.filter((type) => !["code", "table", "chart"].includes(type));
  fs.writeFileSync(
    packsFile,
    JSON.stringify({ version: "1", enabled: Object.fromEntries(legacyTypes.map((type) => [type, true])) }, null, 2),
  );
  const upgraded = await request("GET", "/api/card-packs");
  const upgradedMap = Object.fromEntries(upgraded.data.packs.map((pack) => [pack.type, pack.enabled]));
  assert.equal(upgradedMap.code, true, "文件里没有的新包 code 应按 defaultEnabled=true 自动可用");
  assert.equal(upgradedMap.table, true, "文件里没有的新包 table 应按 defaultEnabled=true 自动可用");
  assert.equal(upgradedMap.chart, false, "chart 声明了默认不启用，老实例升级后不该不请自来");
  const upgradedCode = await request("POST", `/api/boards/${boardId}/cards`, {
    body: { type: "code", code: { source: "ok" } },
  });
  assert.equal(upgradedCode.status, 201, "清单说开着，建卡就得能建（两处缺省口径必须一致）");
  await request("DELETE", `/api/boards/${boardId}/cards/${upgradedCode.data.card.id}`);
  const upgradedChart = await request("POST", `/api/boards/${boardId}/cards`, { body: { type: "chart" } });
  assert.equal(upgradedChart.status, 400, "默认不启用的包在老实例上照样挡新建");
  assert.ok(upgradedChart.data.error.includes("chart"), upgradedChart.data.error);
  // mtime 是秒级以下的浮点，但两次写有可能落在同一个刻度上：等一下再复原，免得缓存认不出变化
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(packsFile, packsBackup);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    (await request("GET", "/api/card-packs")).data.packs.every((pack) => pack.enabled === true),
    "复原之后仍是全开，后面的用例不受影响",
  );

  // 开关是写操作：匿名（无 web 头无 token）应 403
  const anonToggle = await request("PATCH", "/api/card-packs", {
    headers: { "content-type": "application/json" },
    body: { type: "svg", enabled: false },
  });
  assert.equal(anonToggle.status, 403, "card-packs PATCH 必须过鉴权");

  // 停用 svg 包 → 新建 400（结构化报错）→ 信封 strict 整批拒 / lenient 跳过 → 重新启用后恢复
  const packBoard = await request("POST", "/api/boards", { body: { name: "卡片包开关验证" } });
  assert.equal(packBoard.status, 201);
  const packBoardId = packBoard.data.board.id;

  const svgOff = await request("PATCH", "/api/card-packs", { body: { type: "svg", enabled: false } });
  assert.equal(svgOff.status, 200);
  assert.equal(svgOff.data.packs.find((pack) => pack.type === "svg")?.enabled, false);

  const blockedCreate = await request("POST", `/api/boards/${packBoardId}/cards`, {
    body: { type: "svg", svg: { source: "<svg viewBox='0 0 10 10'></svg>" } },
  });
  assert.equal(blockedCreate.status, 400, `停用的包新建应 400，实际 ${blockedCreate.status}`);
  assert.ok(blockedCreate.data.error.includes("已停用"), blockedCreate.data.error);
  assert.ok(blockedCreate.data.error.includes("svg"), "报错要点名是哪个包");

  const unknownCreate = await request("POST", `/api/boards/${packBoardId}/cards`, {
    body: { type: "widget", title: "不存在的类型" },
  });
  assert.equal(unknownCreate.status, 400, "未知类型新建应 400（建卡严）");
  assert.ok(unknownCreate.data.error.includes("未知卡片类型"), unknownCreate.data.error);

  const strictEnvelope = await request("POST", `/api/boards/${packBoardId}/ingest`, {
    body: { format: "blotboard.cards", version: 1, cards: [{ type: "svg", title: "拒收", svg: { source: "<svg/>" } }] },
  });
  assert.equal(strictEnvelope.status, 409, "strict 模式下停用包的卡应整批拒");
  assert.ok(String(strictEnvelope.data.error).includes("已停用"), strictEnvelope.data.error);

  const lenientEnvelope = await request("POST", `/api/boards/${packBoardId}/ingest`, {
    body: {
      format: "blotboard.cards",
      version: 1,
      mode: "lenient",
      cards: [
        { type: "svg", title: "被跳过", svg: { source: "<svg/>" } },
        { type: "text", title: "照常收下", content: "lenient 只跳坏卡" },
      ],
    },
  });
  assert.equal(lenientEnvelope.status, 201);
  assert.equal(lenientEnvelope.data.created.length, 1, "lenient 收下 text，跳过停用的 svg");
  assert.equal(lenientEnvelope.data.rejected.length, 1);

  // 已有卡片不受停用影响：svg 停用期间，画板上已有的 svg 卡照常读、照常改标题
  const svgOn = await request("PATCH", "/api/card-packs", { body: { type: "svg", enabled: true } });
  assert.equal(svgOn.data.packs.find((pack) => pack.type === "svg")?.enabled, true);
  const reCreate = await request("POST", `/api/boards/${packBoardId}/cards`, {
    body: { type: "svg", svg: { source: "<svg viewBox='0 0 10 10'></svg>" } },
  });
  assert.equal(reCreate.status, 201, "重新启用后建卡恢复");

  /* 批量开关：装机 / 换形态要改的从来不是一个包——整批先校验再一次落盘 */
  const batchOff = await request("PATCH", "/api/card-packs", { body: { enabled: { svg: false, html: false } } });
  assert.equal(batchOff.status, 200);
  const batchMap = Object.fromEntries(batchOff.data.packs.map((pack) => [pack.type, pack.enabled]));
  assert.equal(batchMap.svg, false);
  assert.equal(batchMap.html, false);
  assert.equal(batchMap.text, true, "没提到的包不受影响");
  // 一个类型名写错 → 整批不落盘（要么全改要么全不改，不留改了一半的开关表）
  const batchBad = await request("PATCH", "/api/card-packs", { body: { enabled: { svg: true, "not-a-pack": true } } });
  assert.equal(batchBad.status, 400);
  assert.ok(batchBad.data.error.includes("not-a-pack"), batchBad.data.error);
  assert.equal(
    (await request("GET", "/api/card-packs")).data.packs.find((pack) => pack.type === "svg").enabled,
    false,
    "整批校验没过时一个都不该被改",
  );
  assert.equal((await request("PATCH", "/api/card-packs", { body: { enabled: { svg: "yes" } } })).status, 400, "值必须是布尔");
  // 单个开关的老路径继续可用（界面上的开关走它）
  const batchOn = await request("PATCH", "/api/card-packs", { body: { enabled: { svg: true, html: true } } });
  assert.ok(
    batchOn.data.packs.filter((pack) => ["svg", "html"].includes(pack.type)).every((pack) => pack.enabled),
    "批量再开回来",
  );

  /* 未知类型透传往返（铁律 1）：PUT whole 塞一个伪 type 带自定义字段 → 读回逐字节还在 → 再存一轮仍在 */
  const alienFields = {
    widget: { gauge: "cpu", threshold: 0.85, series: [1, 2, 3], nested: { deep: { keep: "me" } } },
    customNote: "这段必须原样活下来 \n 换行也是",
    customFlag: true,
  };
  const alienCard = {
    id: "c_alien_1",
    type: "widget-gauge",
    title: "未来类型的卡",
    content: "本机没有这个包",
    x: 10,
    y: 20,
    w: 300,
    h: 200,
    ...alienFields,
  };
  const wholeAlien = await request("PUT", `/api/boards/${packBoardId}/whole`, {
    body: { cards: [alienCard], edges: [] },
  });
  assert.equal(wholeAlien.status, 200, `未知类型走 whole 应收下，实际 ${wholeAlien.status}: ${JSON.stringify(wholeAlien.data)}`);

  const pickAlien = (board) => board.cards.find((card) => card.id === "c_alien_1");
  const round1 = pickAlien((await request("GET", `/api/boards/${packBoardId}`)).data.board);
  assert.ok(round1, "透传卡要读得回来");
  assert.equal(round1.type, "widget-gauge", "未知 type 原样保留（不再硬掰成 text）");
  for (const key of Object.keys(alienFields)) {
    assert.deepEqual(round1[key], alienFields[key], `专属字段 ${key} 必须逐字节保住`);
  }
  // 再保存一轮（读板 → 保存 → 再读）：把读回的整板原样 PUT 回去
  const exported = (await request("GET", `/api/boards/${packBoardId}/export?format=json`)).data;
  const round2Put = await request("PUT", `/api/boards/${packBoardId}/whole`, {
    body: { cards: exported.board.cards, edges: exported.board.edges },
  });
  assert.equal(round2Put.status, 200);
  const round2 = pickAlien((await request("GET", `/api/boards/${packBoardId}`)).data.board);
  assert.equal(
    JSON.stringify(Object.fromEntries(Object.keys(alienFields).map((key) => [key, round2[key]]))),
    JSON.stringify(alienFields),
    "第二轮往返后专属字段仍逐字节一致",
  );
  assert.equal(round2.title, "未来类型的卡");

  /* 11.55 透传铁律的**属性式**用例。
     上面那条是「一张手写的刁钻卡片」，守得住已知的坑；这条是程序按固定种子生成一批，
     守的是**还没想到的**坑——未知类型带多层嵌套自定义字段、二十万字的长文、
     字符串里塞 NUL / emoji / RTL 控制符 / 引号 / 反斜杠、坐标给极值、空数组与 null。
     一律走 `PUT /whole` 落盘再读回，然后：
       ① 未知类型的**专属字段逐字节比对**（JSON 序列化后必须完全相同）；
       ② 公共字段按文档的 clamp 区间断言（透传铁律管的是专属字段，公共字段照常收敛）；
       ③ 「读→写→读」幂等：把读回的整板原样 PUT 回去，第二次读到的必须与第一次一模一样。
          ③ 比 ① 更狠——它不需要我们事先知道服务端会怎么处理，只要求「处理完再处理一次不变」，
          任何一处「每存一次就多剥一层」的 bug 都会在这里现形。
     种子默认随机，失败时打印复现命令；想固定就 `SMOKE_SEED=12345 npm run smoke`。 */
  step("passthrough-fuzz");
  {
    const seed = Number(process.env.SMOKE_SEED) || Math.floor(Math.random() * 2 ** 31);
    // mulberry32：三行的确定性伪随机，够生成夹具用（不引依赖）
    let state = seed >>> 0;
    const rand = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
    const pick = (items) => items[int(0, items.length - 1)];

    /** 字符串夹具的碎片表：每一条都是历史上「在某个环节被吃掉过」的那类字符 */
    const NASTY = [
      "\u0000", // 裸 NUL：JSON 能带，公共字段会被 cleanText 剥掉，专属字段必须留着
      "😀🎨👩‍💻🇨🇳", // 组合 emoji / 零宽连接符 / 区域指示符（代理对）
      "‫مرحبا بالعالم‬", // RTL 与方向控制符
      'he said "hi" \'ok\'',
      "back\\slash\\\\double",
      "</script><script>alert(1)</script>",
      "${injected} `tpl` {{mustache}}",
      "换行\n制表\t回车\r",
      "ȩ́ 组合附加符",
      "　全角空格与  连续空格  ",
      "𝕌𝕟𝕚𝕔𝕠𝕕𝕖 𝔻𝕠𝕦𝕓𝕝𝕖 𝕊𝕥𝕣𝕦𝕔𝕜",
      "一段普通中文",
    ];
    const weirdString = () => Array.from({ length: int(1, 4) }, () => pick(NASTY)).join("｜");
    const EXTREME_NUMBERS = [0, 1, -1, 0.1 + 0.2, 1e308, -1e308, 5e-324, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1e7, -1e7];
    // NaN / Infinity / -0 不进表：JSON 表示不了它们（会变成 null / 0），
    // 那是 JSON 的性质不是画板的 bug，混进来只会让断言在错误的地方红
    const weirdValue = (depth = 0) => {
      const kind = depth >= 3 ? int(0, 3) : int(0, 6);
      switch (kind) {
        case 0: return weirdString();
        case 1: return pick(EXTREME_NUMBERS);
        case 2: return rand() < 0.5;
        case 3: return null;
        case 4: return Array.from({ length: int(0, 3) }, () => weirdValue(depth + 1));
        case 5: return Object.fromEntries(Array.from({ length: int(1, 3) }, (_, i) => [`k${i}_${weirdString().slice(0, 6)}`, weirdValue(depth + 1)]));
        default: return { deep: { deeper: { deepest: weirdValue(depth + 2) }, list: [weirdValue(depth + 2), []] } };
      }
    };

    const fuzzBoardId = (await request("POST", "/api/boards", { body: { name: "透传属性测试" } })).data.board.id;
    const LONG_TEXT = `${"长文".repeat(30_000)}尾巴`; // 6 万字符，远超 content 的 2 万上限
    const fuzzCards = [];
    for (let i = 0; i < 12; i++) {
      // 一半未知类型（透传铁律的正主），一半已知类型（验证两者能共存于同一块板）
      const unknown = i % 2 === 0;
      const custom = {};
      for (let f = 0; f < int(1, 4); f++) custom[`field_${i}_${f}`] = weirdValue();
      custom.emptyList = [];
      custom.nullish = null;
      custom.nested = { list: [[], {}, [{ a: [null, weirdString()] }]] };
      fuzzCards.push({
        id: `c_fuzz_${String(i).padStart(2, "0")}`,
        type: unknown ? `x-fuzz-${i}` : pick(["text", "quote", "todo"]),
        title: weirdString(),
        content: i === 0 ? LONG_TEXT : weirdString(),
        // 极值坐标：公共字段会被 clamp，下面按文档区间断言
        x: pick([-1e9, -100_001, 0, 1e9]),
        y: pick([-1e9, 100_001, 42, 1e9]),
        w: pick([0, 139, 300, 99_999]),
        h: pick([0, 79, 180, 99_999]),
        // 自定义字段**两种类型都塞**：未知类型必须原样留住，已知类型必须一个不留
        //（后者是反向断言：透传要是哪天被「顺手」扩到已知类型上，脏字段就会在库里永久寄生）
        ...custom,
      });
    }

    const fail = (message) => {
      throw new Error(`${message}\n  复现：SMOKE_SEED=${seed} npm run smoke`);
    };
    // 字段**整个不见了**是最可能的失败形态，而 JSON.stringify(undefined) 返回的是 undefined
    // 不是字符串——直接 .slice() 会让报错信息自己先崩掉，把真正的失败原因盖住
    const preview = (value) => (value === undefined ? "(字段不存在)" : String(JSON.stringify(value)).slice(0, 200));
    const put1 = await request("PUT", `/api/boards/${fuzzBoardId}/whole`, { body: { cards: fuzzCards, edges: [] } });
    if (put1.status !== 200) fail(`刁钻卡片整批 whole 应收下，实际 ${put1.status}: ${JSON.stringify(put1.data).slice(0, 300)}`);

    const read1 = (await request("GET", `/api/boards/${fuzzBoardId}`)).data.board;
    const byId1 = Object.fromEntries(read1.cards.map((card) => [card.id, card]));
    if (read1.cards.length !== fuzzCards.length) fail(`落盘后卡片数不对：期望 ${fuzzCards.length}，实际 ${read1.cards.length}`);

    const clamp = (value, min, max) => Math.round(Math.min(max, Math.max(min, value)));
    for (const input of fuzzCards) {
      const got = byId1[input.id];
      if (!got) fail(`卡片 ${input.id} 读不回来`);
      // ① 未知类型的专属字段：逐字节（JSON 序列化后完全相同）
      if (input.type.startsWith("x-fuzz-")) {
        if (got.type !== input.type) fail(`${input.id} 的未知 type 被改写成了 ${got.type}`);
        for (const key of Object.keys(input)) {
          if (["id", "type", "title", "content", "x", "y", "w", "h"].includes(key)) continue;
          if (JSON.stringify(got[key]) !== JSON.stringify(input[key])) {
            fail(
              `${input.id} 的专属字段 \`${key}\` 没能原样透传\n  存进去：${preview(input[key])}\n  读回来：${preview(got[key])}`,
            );
          }
        }
      } else {
        // 已知类型走的是「按 schema 重建」：同样塞了自定义字段，但一个都不该留下来
        const leaked = Object.keys(got).filter((key) => key.startsWith("field_") || ["emptyList", "nullish", "nested"].includes(key));
        if (leaked.length) fail(`${input.id} 是已知类型 ${got.type}，不该保留自定义字段：${leaked.join(",")}`);
      }
      // ② 公共字段照常收敛（区间见 lib/board-schema.ts 的 clampNumber 调用）
      if (got.x !== clamp(input.x, -100_000, 100_000)) fail(`${input.id} 的 x 没按 [-100000,100000] clamp：传 ${input.x} 得 ${got.x}`);
      if (got.y !== clamp(input.y, -100_000, 100_000)) fail(`${input.id} 的 y 没按 [-100000,100000] clamp：传 ${input.y} 得 ${got.y}`);
      if (got.w !== clamp(input.w, 140, 1600)) fail(`${input.id} 的 w 没按 [140,1600] clamp：传 ${input.w} 得 ${got.w}`);
      if (got.h !== clamp(input.h, 80, 2400)) fail(`${input.id} 的 h 没按 [80,2400] clamp：传 ${input.h} 得 ${got.h}`);
      if (got.title.includes("\u0000") || got.content.includes("\u0000")) {
        fail(`${input.id} 的公共文本字段没剥掉 NUL——那正是让 grep 把整个文件当二进制的字节`);
      }
      if (got.content.length > 20_000) fail(`${input.id} 的 content 超过 2 万字符上限：${got.content.length}`);
    }

    // ③ 「读→写→读」幂等：把读回的整板原样 PUT 回去，两次读到的卡片必须一模一样
    const put2 = await request("PUT", `/api/boards/${fuzzBoardId}/whole`, {
      body: { cards: read1.cards, edges: read1.edges },
    });
    if (put2.status !== 200) fail(`把读回来的整板原样存回去应该成功，实际 ${put2.status}`);
    const read2 = (await request("GET", `/api/boards/${fuzzBoardId}`)).data.board;
    // updatedAt 是服务端每次写都要重算的（已知类型），比它没有意义；其余字段一个都不许变
    const stripVolatile = (card) => JSON.stringify(Object.fromEntries(Object.entries(card).filter(([key]) => key !== "updatedAt").sort()));
    const byId2 = Object.fromEntries(read2.cards.map((card) => [card.id, card]));
    for (const card of read1.cards) {
      const again = byId2[card.id];
      if (!again) fail(`幂等回合里卡片 ${card.id} 丢了`);
      if (stripVolatile(card) !== stripVolatile(again)) {
        fail(
          `${card.id} 不幂等：同一份数据存第二次读出来变了\n  第一次：${stripVolatile(card).slice(0, 300)}\n  第二次：${stripVolatile(again).slice(0, 300)}`,
        );
      }
    }
    // 未知类型的 updatedAt 也要留住（passthroughCard 有意保留它：这一路没有包，不敢替它重算）
    for (const card of read1.cards.filter((item) => item.type.startsWith("x-fuzz-"))) {
      if (card.updatedAt !== undefined && byId2[card.id].updatedAt !== card.updatedAt) {
        fail(`未知类型 ${card.id} 的 updatedAt 被重算了：${card.updatedAt} → ${byId2[card.id].updatedAt}`);
      }
    }
    console.log(`   透传属性测试 ${fuzzCards.length} 张（种子 ${seed}）`);
  }

  /* 11.6 建卡严：公共枚举字段的非法值不再被静默吞掉。
        原来传 color:"neon" 会被默默变成 slate，agent 以为设置成功了，
        要到打开画板才发现颜色不对——而那时已经无从判断是哪一步吞掉的。 */
  step("strict-enums");
  {
    const strictBoard = (await request("POST", "/api/boards", { body: { name: "枚举校验" } })).data.board.id;

    const badColor = await request("POST", `/api/boards/${strictBoard}/cards`, {
      body: { type: "text", title: "霓虹", color: "neon" },
    });
    assert.equal(badColor.status, 400, `非法 color 应 400，实际 ${badColor.status}`);
    assert.ok(
      badColor.data.error.includes("neon") && badColor.data.error.includes("violet"),
      `报错要点名非法值并列出合法值：${badColor.data.error}`,
    );

    // 合法值照收；null / 不传仍是「跟随默认」，不能报错
    const okColor = await request("POST", `/api/boards/${strictBoard}/cards`, {
      body: { type: "text", title: "紫的", color: "violet" },
    });
    assert.equal(okColor.data.card.color, "violet");
    const nullColor = await request("POST", `/api/boards/${strictBoard}/cards`, {
      body: { type: "text", title: "默认色", color: null },
    });
    assert.equal(nullColor.status, 201, "color:null = 不设置，不该报错");
    assert.equal(nullColor.data.card.color, "slate");

    // 改卡 / 批量改卡走同一条闸
    assert.equal(
      (await request("PATCH", `/api/boards/${strictBoard}/cards/${okColor.data.card.id}`, { body: { color: "neon" } })).status,
      400,
    );
    assert.equal(
      (
        await request("PATCH", `/api/boards/${strictBoard}/cards`, {
          body: { ids: [okColor.data.card.id], patch: { color: "neon" } },
        })
      ).status,
      400,
    );

    // 任务卡的 status / priority 同理（原来会静默变成 idea / none）
    const badStatus = await request("POST", `/api/boards/${strictBoard}/cards`, {
      body: { type: "task", title: "坏状态", task: { status: "doing" } },
    });
    assert.equal(badStatus.status, 400);
    assert.ok(
      badStatus.data.error.includes("task.status") && badStatus.data.error.includes("running"),
      badStatus.data.error,
    );
    const strictTask = await request("POST", `/api/boards/${strictBoard}/cards`, {
      body: { type: "task", title: "好任务", task: { status: "issued", priority: "high" } },
    });
    assert.equal(strictTask.data.card.task.priority, "high");
    assert.equal(
      (
        await request("PATCH", `/api/boards/${strictBoard}/cards/${strictTask.data.card.id}`, {
          body: { task: { priority: "P0" } },
        })
      ).status,
      400,
      "priority 写错也要 400",
    );

    // 连线上的四个枚举：kind / color / style / width
    const fromId = okColor.data.card.id;
    const toId = strictTask.data.card.id;
    for (const [body, field] of [
      [{ from: fromId, to: toId, kind: "depends" }, "kind"],
      [{ from: fromId, to: toId, color: "neon" }, "color"],
      [{ from: fromId, to: toId, style: "wavy" }, "style"],
      [{ from: fromId, to: toId, width: 9 }, "width"],
    ]) {
      const res = await request("POST", `/api/boards/${strictBoard}/edges`, { body });
      assert.equal(res.status, 400, `连线 ${field} 非法值应 400，实际 ${res.status}`);
      assert.ok(res.data.error.includes(field), res.data.error);
    }
    const goodEdge = await request("POST", `/api/boards/${strictBoard}/edges`, {
      body: { from: fromId, to: toId, kind: "blocks", color: "rose", style: "dashed", width: 3 },
    });
    assert.equal(goodEdge.status, 201);
    assert.equal(
      (await request("PATCH", `/api/boards/${strictBoard}/edges/${goodEdge.data.edge.id}`, { body: { style: "wavy" } }))
        .status,
      400,
    );
    // null 是「恢复跟随语义」，不是错值
    const clearedStyle = await request("PATCH", `/api/boards/${strictBoard}/edges/${goodEdge.data.edge.id}`, {
      body: { color: null, style: null, width: null },
    });
    assert.equal(clearedStyle.status, 200);
    assert.equal(clearedStyle.data.edge.color, null);

    // 「收卡宽」那几条路不受影响：不能因为一个颜色把整块板 / 整封信打回去
    const lenientWhole = await request("PUT", `/api/boards/${strictBoard}/whole`, {
      body: { cards: [{ id: "c_lenient_1", type: "text", title: "宽收的卡", color: "neon" }], edges: [] },
    });
    assert.equal(lenientWhole.status, 200, "whole 是收卡宽的路，非法 color 仍旧兜底");
    assert.equal(lenientWhole.data.board.cards[0].color, "slate");
    const lenientIngest = await request("POST", `/api/boards/${strictBoard}/ingest`, {
      body: { format: "blotboard.cards", version: 1, cards: [{ type: "text", title: "信封收的卡", color: "neon" }] },
    });
    assert.equal(lenientIngest.status, 201, "信封同理");
  }

  /* 11.7 两种新整理模式：timeline（一天一列）与 kanban（按状态分列）。
        断言的是分列 / 分组的坐标关系，不验像素——间距是可以调的实现细节。 */
  step("layout-modes");
  {
    const layoutBoard = (await request("POST", "/api/boards", { body: { name: "整理模式" } })).data.board.id;
    const mk = async (body) => (await request("POST", `/api/boards/${layoutBoard}/cards`, { body })).data.card;
    // incident-fix：第一个 date 字段是 fixedAt，状态 enum 的 options 顺序是 fixed → mitigated → watching → open
    const incident = (title, status, fixedAt) => ({
      type: "data",
      data: { specId: "incident-fix", fields: { title, symptom: "现象", rootCause: "根因", fix: "修法", status, fixedAt } },
    });
    // 时刻取正午前后：换个时区跑也还是同一天
    const dayA1 = await mk(incident("一月甲", "fixed", "2026-01-05T12:00:00Z"));
    const dayA2 = await mk(incident("一月乙", "open", "2026-01-05T13:00:00Z"));
    const dayB = await mk(incident("三月丙", "fixed", "2026-03-09T12:00:00Z"));
    const layoutTask = await mk({ type: "task", title: "任务卡", task: { status: "running" } });
    const layoutText = await mk({ type: "text", title: "白文本" });
    const positions = async () =>
      Object.fromEntries(
        (await request("GET", `/api/boards/${layoutBoard}`)).data.board.cards.map((card) => [
          card.id,
          { x: card.x, y: card.y },
        ]),
      );

    const timeline = await request("POST", `/api/boards/${layoutBoard}/tidy`, { body: { mode: "timeline" } });
    assert.equal(timeline.status, 200);
    assert.equal(timeline.data.mode, "timeline");
    assert.equal(timeline.data.moved, 5);
    const tl = await positions();
    assert.equal(tl[dayA1.id].x, tl[dayA2.id].x, "同一天的卡在同一列");
    assert.notEqual(tl[dayA1.id].y, tl[dayA2.id].y, "同一天的卡纵向堆叠，不重叠");
    assert.ok(tl[dayA1.id].x < tl[dayB.id].x, "早的一天排在左边");
    // 任务卡 / 文本卡没有业务时间，落到建卡时间（今天）→ 在两条历史日期的右边
    assert.ok(tl[layoutTask.id].x > tl[dayB.id].x, "取不到业务时间就按建卡时间，排到最右");
    assert.equal(tl[layoutTask.id].x, tl[layoutText.id].x, "同一天建的卡同列");

    const kanban = await request("POST", `/api/boards/${layoutBoard}/tidy`, { body: { mode: "kanban" } });
    assert.equal(kanban.data.mode, "kanban");
    const kb = await positions();
    assert.equal(kb[dayA1.id].x, kb[dayB.id].x, "同一个状态（fixed）分到同一列");
    assert.notEqual(kb[dayA1.id].y, kb[dayB.id].y, "同列内纵向排列");
    assert.ok(kb[dayA1.id].x < kb[dayA2.id].x, "列顺序照 enum options：fixed 在 open 之前");
    assert.ok(kb[layoutTask.id].x < kb[dayA1.id].x, "任务卡的四态列排在规格列之前");
    assert.ok(kb[layoutText.id].x > kb[dayA2.id].x, "没有状态可分的卡按类型成列，排在后面");

    // 老的六种模式一个不少；显式拼错模式必须拒绝，不能悄悄改成另一个整理操作。
    for (const mode of ["tidy", "flow", "LR", "TB", "group", "grid"]) {
      assert.equal((await request("POST", `/api/boards/${layoutBoard}/tidy`, { body: { mode } })).data.mode, mode);
    }
    assert.equal((await request("POST", `/api/boards/${layoutBoard}/tidy`, { body: { mode: "nope" } })).status, 400);

    /* 四象限：这块板上有任务卡 → 走「重要 × 已开工」那组维度。
       断言的是格与格之间的相对关系（同格同坐标区、跨格拉开），不验像素。 */
    const urgentIdea = await mk({ type: "task", title: "重要没开工", task: { status: "idea", priority: "urgent" } });
    const urgentRun = await mk({ type: "task", title: "重要在跑", task: { status: "running", priority: "high" } });
    const lowIdea = await mk({ type: "task", title: "次要没开工", task: { status: "idea", priority: "low" } });
    const matrix = await request("POST", `/api/boards/${layoutBoard}/tidy`, { body: { mode: "matrix" } });
    assert.equal(matrix.status, 200);
    assert.equal(matrix.data.mode, "matrix");
    const mx = await positions();
    // 重要在上：两张 urgent/high 的 y 都小于次要那张
    assert.ok(mx[urgentIdea.id].y < mx[lowIdea.id].y, "重要的排在上排、次要的在下排");
    assert.equal(mx[urgentIdea.id].y, mx[urgentRun.id].y, "同一排（都重要）的顶边对齐");
    // 已开工在右：running 的 x 大于 idea 的
    assert.ok(mx[urgentRun.id].x > mx[urgentIdea.id].x, "已开工的排右列、还是想法的在左列");
    assert.equal(mx[urgentIdea.id].x, mx[lowIdea.id].x, "同一列（都没开工）的左边界对齐");
    // 非任务卡在这组维度下归不了类 → 甩到四象限右侧的「未归类」区，比塞进某一格诚实
    assert.ok(mx[layoutText.id].x > mx[urgentRun.id].x, "归不了类的卡摆在四象限右边");
    assert.ok(mx[dayA1.id].x > mx[urgentRun.id].x, "规格卡在任务维度下也归不了类");

    /* 泳道：行 = 卡片类型、列 = 状态（列口径与 kanban 同源） */
    const swim = await request("POST", `/api/boards/${layoutBoard}/tidy`, { body: { mode: "swimlane" } });
    assert.equal(swim.data.mode, "swimlane");
    const sw = await positions();
    // 同类型 = 同一行：任务卡三张的顶边在同一条线上（同格内也可能堆叠，取最上那张比较）
    const taskRowY = Math.min(sw[urgentIdea.id].y, sw[urgentRun.id].y, sw[lowIdea.id].y);
    assert.ok(
      [urgentIdea.id, urgentRun.id, lowIdea.id, layoutTask.id].every((id) => sw[id].y >= taskRowY),
      "任务卡都落在任务那一行里",
    );
    // 文本卡是另一种类型 → 另起一行，且行与行之间拉开（行的先后按 groupOrder，不假设谁在上）
    assert.ok(
      Math.abs(sw[layoutText.id].y - taskRowY) > 100,
      `不同类型分到不同的行，行间留白明显（文本 ${sw[layoutText.id].y} / 任务 ${taskRowY}）`,
    );
    // 同一行里，状态不同的分到不同列（idea 与 running 不在一列）
    assert.notEqual(sw[urgentIdea.id].x, sw[urgentRun.id].x, "同一行里状态不同的分列");
    assert.equal(sw[urgentIdea.id].x, sw[lowIdea.id].x, "同一行同一状态的在同一列");

    /* 子图分簇：连成一片的排一簇，孤立卡聚到最后一簇 */
    const clusterBoardId = (await request("POST", "/api/boards", { body: { name: "分簇" } })).data.board.id;
    const cmk = async (title) =>
      (await request("POST", `/api/boards/${clusterBoardId}/cards`, { body: { type: "text", title } })).data.card;
    const [a1, a2, b1, b2, lone] = [await cmk("A1"), await cmk("A2"), await cmk("B1"), await cmk("B2"), await cmk("孤")];
    for (const [from, to] of [[a1, a2], [b1, b2]]) {
      assert.equal(
        (await request("POST", `/api/boards/${clusterBoardId}/edges`, { body: { from: from.id, to: to.id } })).status,
        201,
      );
    }
    const cluster = await request("POST", `/api/boards/${clusterBoardId}/tidy`, { body: { mode: "cluster" } });
    assert.equal(cluster.data.mode, "cluster");
    assert.equal(cluster.data.moved, 5);
    const cl = Object.fromEntries(
      (await request("GET", `/api/boards/${clusterBoardId}`)).data.board.cards.map((card) => [
        card.id,
        { x: card.x, y: card.y },
      ]),
    );
    const spanA = Math.abs(cl[a1.id].x - cl[a2.id].x);
    const gapAB = Math.min(
      ...[b1.id, b2.id].map((id) => Math.min(...[a1.id, a2.id].map((other) => Math.abs(cl[id].x - cl[other].x)))),
    );
    assert.ok(gapAB > spanA, `簇与簇之间要比簇内拉得开（簇内 ${spanA} / 簇间 ${gapAB}）`);
    // 孤立卡是最后一簇：横坐标在两簇之后
    assert.ok(
      cl[lone.id].x > Math.max(cl[a1.id].x, cl[a2.id].x, cl[b1.id].x, cl[b2.id].x),
      "孤立卡聚成最后一簇，排在所有有连线的簇之后",
    );
  }

  /* 11.7b 连线的语义两件套：weight（关系强弱 1-5）与 tags（≤6 个短标签）。
        跟外观三件套同一口径——「建卡严」写错点名 400，null / [] 是合法的「取消标注」。 */
  step("edge-weight-tags");
  {
    const relBoard = (await request("POST", "/api/boards", { body: { name: "连线语义" } })).data.board.id;
    const one = (await request("POST", `/api/boards/${relBoard}/cards`, { body: { type: "text", title: "起" } })).data.card;
    const two = (await request("POST", `/api/boards/${relBoard}/cards`, { body: { type: "text", title: "落" } })).data.card;

    // 正例：建线时直接带上
    const created = await request("POST", `/api/boards/${relBoard}/edges`, {
      body: { from: one.id, to: two.id, kind: "blocks", weight: 5, tags: ["主线", "风险", "主线"] },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.edge.weight, 5);
    assert.deepEqual(created.data.edge.tags, ["主线", "风险"], "标签自动去重");
    const edgeId = created.data.edge.id;

    // 反例：非法值点名 400（不静默兜底），文案要说清楚它不是线宽
    for (const [body, needle] of [
      [{ weight: 0 }, "weight"],
      [{ weight: 6 }, "weight"],
      [{ weight: 2.5 }, "weight"],
      [{ tags: "主线" }, "tags"],
      [{ tags: ["a", "b", "c", "d", "e", "f", "g"] }, "tags"],
      [{ tags: [1] }, "tags"],
    ]) {
      const res = await request("PATCH", `/api/boards/${relBoard}/edges/${edgeId}`, { body });
      assert.equal(res.status, 400, `连线 ${needle} 非法值应 400，实际 ${res.status}：${JSON.stringify(res.data)}`);
      assert.ok(res.data.error.includes(needle), res.data.error);
    }
    assert.ok(
      (await request("PATCH", `/api/boards/${relBoard}/edges/${edgeId}`, { body: { weight: 9 } })).data.error.includes("width"),
      "weight 的报错要点明「画多粗看 width」，不然调用方会拿它当线宽",
    );

    // null / [] 是「取消标注」，不是错值
    const cleared = await request("PATCH", `/api/boards/${relBoard}/edges/${edgeId}`, { body: { weight: null, tags: [] } });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.edge.weight, null);
    assert.deepEqual(cleared.data.edge.tags, []);

    // 再标回去，看导出三条路带不带得上
    await request("PATCH", `/api/boards/${relBoard}/edges/${edgeId}`, { body: { weight: 4, tags: ["主线"] } });
    const relMd = await (await fetch(`${base}/api/boards/${relBoard}/export?format=md`)).text();
    assert.ok(relMd.includes("强度 4/5"), `md 导出要带上关系强弱：${relMd.slice(-400)}`);
    assert.ok(relMd.includes("#主线"), "md 导出要带上关系标签");
    const relHtml = await (await fetch(`${base}/api/boards/${relBoard}/export?format=html`)).text();
    assert.ok(relHtml.includes("关系一览"), "标注过的连线要在 HTML 导出里单列一节");
    assert.ok(relHtml.includes("rel-weight"), "HTML 导出要画出关系强弱");
    const relEnvelope = (await request("GET", `/api/boards/${relBoard}/export?format=cards`)).data.envelope;
    assert.equal(relEnvelope.edges[0].weight, 4, "信封要自包含关系强弱");
    assert.deepEqual(relEnvelope.edges[0].tags, ["主线"], "信封要自包含关系标签");

    // 收卡宽：信封收进来的连线也认这两个字段，写错不打回整封
    const relInbox = (await request("POST", "/api/boards", { body: { name: "连线语义收件箱" } })).data.board.id;
    const ingested = await request("POST", `/api/boards/${relInbox}/ingest`, {
      body: {
        format: "blotboard.cards",
        version: 1,
        cards: [
          { id: "n1", type: "text", title: "甲" },
          { id: "n2", type: "text", title: "乙" },
        ],
        edges: [{ from: "n1", to: "n2", weight: 3, tags: ["来自信封"] }, { from: "n1", to: "n2", weight: 99 }],
      },
    });
    assert.equal(ingested.status, 201);
    const inboxEdges = (await request("GET", `/api/boards/${relInbox}`)).data.board.edges;
    assert.equal(inboxEdges.length, 1, "同向重复的连线只收一条");
    assert.equal(inboxEdges[0].weight, 3);
    assert.deepEqual(inboxEdges[0].tags, ["来自信封"]);

    // whole 也是收卡宽的路：非法 weight 兜底成 null，整块板照样存得下
    const wholeRes = await request("PUT", `/api/boards/${relInbox}/whole`, {
      body: {
        cards: inboxEdges.length ? (await request("GET", `/api/boards/${relInbox}`)).data.board.cards : [],
        edges: [{ from: inboxEdges[0].from, to: inboxEdges[0].to, weight: "很强", tags: ["保住"] }],
      },
    });
    assert.equal(wholeRes.status, 200, "whole 是收卡宽的路，非法 weight 不该把整块板打回去");
    assert.equal(wholeRes.data.board.edges[0].weight, null);
    assert.deepEqual(wholeRes.data.board.edges[0].tags, ["保住"]);
  }

  /* 11.8 新内置规格 prompt：「新需求先问能不能下沉 Tier 1」的示范——只加一个 JSON，零代码 */
  step("prompt-spec");
  {
    const promptSpec = await request("GET", "/api/card-specs/prompt");
    assert.equal(promptSpec.status, 200);
    assert.equal(promptSpec.data.spec.name, "提示词");
    assert.deepEqual(
      promptSpec.data.spec.fields
        .filter((field) => field.required)
        .map((field) => field.key)
        .sort(),
      ["name", "purpose", "user"],
    );
    assert.equal(promptSpec.data.spec.display.body, "user", "正文摆在卡面正文位");
    // 规格文件读盘时 example 已被真校验；这里再干跑一遍确认它拼成信封也能过
    const promptDry = (
      await request("POST", "/api/card-specs/validate", {
        body: { format: "blotboard.cards", version: 1, cards: [{ spec: "prompt", fields: promptSpec.data.spec.example }] },
      })
    ).data.report;
    assert.equal(promptDry.counts.rejected, 0, JSON.stringify(promptDry.cards[0]?.problems));

    const promptBoard = (await request("POST", "/api/boards", { body: { name: "提示词库" } })).data.board.id;
    const promptCard = await request("POST", `/api/boards/${promptBoard}/cards`, {
      body: {
        type: "data",
        data: {
          specId: "prompt",
          fields: { name: "选题打分", purpose: "给选题打分", user: "给下面的选题打分：{topic}", variables: "topic, audience" },
        },
      },
    });
    assert.equal(promptCard.status, 201);
    assert.equal(promptCard.data.card.title, "选题打分", "标题按 display.title 生成");
    assert.deepEqual(promptCard.data.card.data.fields.variables, ["topic", "audience"], "tags 收逗号分隔的字符串");
  }

  /* 12. 零配置形态：三个外部服务 env 全空 → search/library 隐藏并回 503；
        任务链路退到 local 后端（永远可用）：Issue 落本地 issues.json，
        「发起任务」生成 prompt，agent 经 /api/issues 回写状态（docs/RUNNER.md §3） */
  step("unconfigured");
  {
    const bareData = path.join(tmpRoot, "bare-data");
    fs.mkdirSync(bareData, { recursive: true });
    const barePort = await freePort();
    const bareBase = `http://127.0.0.1:${barePort}`;
    bareChild = spawn(process.execPath, ["server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        BLOTBOARD_PORT: String(barePort),
        BLOTBOARD_PORT_STRICT: "1",
        BLOTBOARD_HOST: "127.0.0.1",
        BLOTBOARD_DATA_DIR: bareData,
        BLOTBOARD_DATA_FILE: path.join(bareData, "boards.json"),
        BLOTBOARD_UPLOADS_DIR: path.join(bareData, "uploads"),
        BLOTBOARD_AGENT_COMMANDS_FILE: path.join(bareData, "agent-commands.json"),
        // 开源用户的默认处境：三个外部服务一个都没有（显式清空，防外层 shell 漏进来）
        GOAL_AGENT_RUNNER_URL: "",
        BLOTBOARD_RUNNER_URL: "",
        GOAL_AGENT_WEB_URL: "",
        AIDOCS_URL: "",
        BOOK_LIBRARY_URL: "",
        BLOTBOARD_GOAL_AGENT_SETTINGS: "",
        // local 后端的自动同步也要断言，防抖压短（与主实例同一理由）
        BLOTBOARD_ISSUE_SYNC_DEBOUNCE_MS: "120",
        // 这个实例顺便覆盖「把快照功能整个关掉」的形态（keep=0）
        BLOTBOARD_CHECKPOINT_KEEP: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    bareChild.stderr.on("data", (chunk) => process.stderr.write(`[bare] ${chunk}`));
    await waitForHealth(bareBase, bareChild);

    const bare = async (method, url, body) => {
      const response = await fetch(`${bareBase}${url}`, {
        method,
        headers: { "content-type": "application/json", "x-board-web": "1", origin: bareBase },
        body: body == null ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json().catch(() => null) };
    };

    const bareCaps = await bare("GET", "/api/capabilities");
    assert.equal(bareCaps.status, 200);
    // 任务功能不再随外部服务隐没：没配 Runner = local 后端，tasks 恒为 true
    assert.deepEqual(bareCaps.data.features, { tasks: true, search: false, library: false });
    assert.deepEqual(bareCaps.data.tasks, { backend: "local" });
    // 快照功能可以整个关掉（BLOTBOARD_CHECKPOINT_KEEP=0）：能力自描述要说实话，agent 据此决定要不要自己先导一份
    assert.equal(bareCaps.data.checkpoints.enabled, false);
    assert.equal(bareCaps.data.checkpoints.keep, 0);
    {
      // 关掉之后**一个点都不打**：批量写照常成功（安全网不是写入的前提），清单恒空
      const offBoard = (await bare("POST", "/api/boards", { name: "关掉快照的板" })).data.board.id;
      const offCard = (await bare("POST", `/api/boards/${offBoard}/cards`, { type: "text", title: "甲" })).data.card.id;
      const offWhole = await bare("PUT", `/api/boards/${offBoard}/whole`, { cards: [{ id: offCard, type: "text", title: "乙" }] });
      assert.equal(offWhole.status, 200, "关掉快照不影响批量写本身");
      const offList = await bare("GET", `/api/boards/${offBoard}/checkpoints`);
      assert.equal(offList.data.enabled, false);
      assert.equal(offList.data.checkpoints.length, 0, "keep=0 时不打点");
      // 日志跟快照是两件事：不打点也照样记「谁改了什么」，只是 checkpoint 为 null
      const offLog = (await bare("GET", `/api/boards/${offBoard}/activity`)).data.activity;
      assert.equal(offLog.length, 1);
      assert.equal(offLog[0].checkpoint, null, "没打点时日志里的 checkpoint 是 null");
      await bare("DELETE", `/api/boards/${offBoard}`);
    }
    assert.equal(bareCaps.data.cardTypes.length, 21, "功能关掉不影响卡片类型清单");
    // 首启（没有 card-packs.json、boards 目录空）：默认集 = 方案默认 9 种
    //（∪ 存量类型——这里没有存量，所以正好是精简默认；老实例首启会自动并上自己用过的类型）
    assert.deepEqual(
      bareCaps.data.cards.filter((pack) => pack.enabled).map((pack) => pack.type).sort(),
      ["code", "data", "link", "media", "mermaid", "quote", "table", "task", "text", "todo"],
      "新装机的默认启用集应是方案默认 10 种（第二波加了 code / table；media 靠拖文件建卡、没有工具条入口）",
    );
    assert.equal(bareCaps.data.cards.length, 21, "停用的包也在清单里（enabled: false）");
    // 默认集之外的类型：新建被拒、报错指路
    const bareSvg = await bare("POST", `/api/boards/${(await bare("POST", "/api/boards", { name: "默认集验证" })).data.board.id}/cards`, {
      type: "svg",
      svg: { source: "<svg/>" },
    });
    assert.equal(bareSvg.status, 400, "默认集之外的类型在新装机上新建应 400");
    assert.ok(bareSvg.data.error.includes("已停用"), bareSvg.data.error);

    const bareHealth = await bare("GET", "/api/health");
    assert.equal(bareHealth.status, 200, "画板本体零依赖也要能活");
    assert.equal(bareHealth.data.runner, false, "runner 字段仍指「外部 Runner 探活」，local 下保持 false");
    assert.deepEqual(bareHealth.data.features, { tasks: true, search: false, library: false });

    // 三条集成路由：503 + 结构化错误 + 文案指路（该配哪个 env），绝不 500、不带本机路径
    const bareSearch = await bare("POST", "/api/aidocs/search", { query: "任意词" });
    assert.equal(bareSearch.status, 503, `aidocs 未配置应 503，实际 ${bareSearch.status}`);
    assert.equal(bareSearch.data.ok, false);
    assert.ok(bareSearch.data.error.includes("AIDOCS_URL"), bareSearch.data.error);
    assert.ok(!bareSearch.data.error.includes("/Users"), "错误信息不能带本机路径");

    const bareBooks = await bare("GET", "/api/books");
    assert.equal(bareBooks.status, 503);
    assert.ok(bareBooks.data.error.includes("BOOK_LIBRARY_URL"), bareBooks.data.error);
    const bareCover = await bare("GET", "/api/books/some-book/cover");
    assert.equal(bareCover.status, 503);

    // Runner 直通代理在 local 下就地服务：不认识的 run id 是 404（不是 503——功能是在的）
    const bareRunner = await bare("GET", "/api/runner/tasks/task-x");
    assert.equal(bareRunner.status, 404, `local 下查不存在的任务应 404，实际 ${bareRunner.status}`);
    // 白名单仍然先行：没开放的路径照旧 404，不泄露有没有后端
    const bareOff = await bare("GET", "/api/runner/settings");
    assert.equal(bareOff.status, 404);
    // Agent 自由派单必须有真的执行方：local 给 501 并指路
    const bareDispatch = await bare("POST", "/api/runner/tasks", { goal: "随便派点什么" });
    assert.equal(bareDispatch.status, 501);
    assert.ok(bareDispatch.data.error.includes("BLOTBOARD_RUNNER_URL"), bareDispatch.data.error);

    /* ── local 任务后端全链路：建卡 → 转 Issue → launch 拿 prompt →
          模拟 agent 回写 → task-status 反映 → 任务台列表 / 详情 / 镜头计数 → 孤儿 Issue ── */
    step("local-issues");
    const bareBoard = await bare("POST", "/api/boards", { name: "零依赖画板" });
    assert.equal(bareBoard.status, 201, "没有任何外部服务也能建板");
    const bareBoardId = bareBoard.data.board.id;
    const bareTask = await bare("POST", `/api/boards/${bareBoardId}/cards`, {
      type: "task",
      title: "本地任务卡",
      task: { goal: "不接后端也能整个闭环", priority: "high" },
    });
    assert.equal(bareTask.status, 201, "任务卡本体是本地功能，照常能建");
    const bareCardId = bareTask.data.card.id;

    // 转 Issue：落本地 issues.json，卡片拿到引用 id 与编号
    const bareIssued = await bare("POST", `/api/boards/${bareBoardId}/cards/${bareCardId}/issue`);
    assert.equal(bareIssued.status, 201, `local 转 Issue 应 201，实际 ${bareIssued.status}: ${JSON.stringify(bareIssued.data)}`);
    const bareIssueId = bareIssued.data.issue.id;
    assert.match(bareIssueId, /^i_/, "local Issue id 应是 i_ 前缀");
    assert.equal(bareIssued.data.issue.number, "L-1", "本地编号从 L-1 起");
    assert.equal(bareIssued.data.card.task.status, "issued");
    assert.ok(fs.existsSync(path.join(bareData, "issues.json")), "Issue 应落在 <data>/issues.json");

    // 幂等：再转一次是 200 + alreadyIssued
    const bareAgain = await bare("POST", `/api/boards/${bareBoardId}/cards/${bareCardId}/issue`);
    assert.equal(bareAgain.status, 200);
    assert.equal(bareAgain.data.alreadyIssued, true);

    // 列表 + 镜头计数：刚建的 Issue 在「待派」桶里
    let bareList = await bare("GET", "/api/issues");
    assert.equal(bareList.status, 200);
    assert.equal(bareList.data.total, 1);
    assert.equal(bareList.data.counts.pending, 1);
    assert.equal(bareList.data.issues[0].boardName, "零依赖画板");
    assert.equal(bareList.data.issues[0].orphan, false);

    // 发起任务 = 生成 prompt 挂成 run（不真派单）；卡片进入 running、taskId = runId
    const bareLaunch = await bare("POST", `/api/boards/${bareBoardId}/cards/${bareCardId}/launch`, { mode: "implement" });
    assert.equal(bareLaunch.status, 201, `local launch 应 201，实际 ${bareLaunch.status}: ${JSON.stringify(bareLaunch.data)}`);
    const bareRunId = bareLaunch.data.task.sessionId;
    assert.match(bareRunId, /^r_/, "local run id 应是 r_ 前缀");
    assert.equal(bareLaunch.data.card.task.status, "running");

    // 详情：runs 带完整 prompt（正文 + 画板深链 + 回写指引），顶层 prompt 直接可复制
    const bareDetail = await bare("GET", `/api/issues/${bareIssueId}`);
    assert.equal(bareDetail.status, 200);
    assert.equal(bareDetail.data.issue.runs.length, 1);
    assert.equal(bareDetail.data.issue.runs[0].status, "pending", "run 初始状态是待派");
    const barePrompt = bareDetail.data.prompt;
    assert.ok(barePrompt.includes("不接后端也能整个闭环"), "prompt 应含 Issue 正文");
    assert.ok(barePrompt.includes(`/?board=${bareBoardId}&card=${bareCardId}`), "prompt 应含画板深链");
    assert.ok(barePrompt.includes(`/api/issues/${bareIssueId}/runs/${bareRunId}`), "prompt 应含回写端点");
    assert.ok(barePrompt.includes("x-auth-key"), "prompt 应说明鉴权头");
    // prompt 随免鉴权的 `GET /api/issues/:id` 一起吐出去：token 的落点只能给相对表述
    assert.ok(barePrompt.includes("BLOTBOARD_INTERNAL_TOKEN"), "prompt 应指出 token 的 env 名");
    assert.ok(!/\/(Users|home|root|var|private)\//.test(barePrompt), `prompt 里不许出现本机绝对路径：${barePrompt}`);

    // 任务卡轮询：run 还没被接手 → 待派
    let bareStatus = await bare("GET", `/api/boards/${bareBoardId}/task-status`);
    assert.equal(bareStatus.data.statuses[bareCardId].status, "pending");
    // 前端直通代理也认这个 run（任务抽屉的进展 / 复制 prompt 用它）
    const bareProxyTask = await bare("GET", `/api/runner/tasks/${bareRunId}`);
    assert.equal(bareProxyTask.status, 200);
    assert.equal(bareProxyTask.data.task.prompt, bareDetail.data.issue.runs[0].prompt);

    // 模拟 agent 回写：token 用画板自管的 <data>/token（首启自动生成，回写契约见 RUNNER.md §3）
    const bareToken = fs.readFileSync(path.join(bareData, "token"), "utf8").trim();
    assert.ok(bareToken.length >= 32, "首启应自动生成内部 token");
    const agentPatch = (url, body) =>
      fetch(`${bareBase}${url}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-auth-key": bareToken },
        body: JSON.stringify(body),
      }).then(async (response) => ({ status: response.status, data: await response.json().catch(() => null) }));

    // 无鉴权的回写要被拒（agent 回写口也是写口）
    const noAuthPatch = await fetch(`${bareBase}/api/issues/${bareIssueId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.equal(noAuthPatch.status, 403, "无鉴权回写应 403");

    // 开工：run running → Issue 自动进「进行中」；task-status 跟着变
    const runRunning = await agentPatch(`/api/issues/${bareIssueId}/runs/${bareRunId}`, { status: "running" });
    assert.equal(runRunning.status, 200);
    assert.equal(runRunning.data.issue.status, "in_progress", "run running 应把 Issue 推到 in_progress");
    bareStatus = await bare("GET", `/api/boards/${bareBoardId}/task-status`);
    assert.equal(bareStatus.data.statuses[bareCardId].status, "running");
    bareList = await bare("GET", "/api/issues");
    assert.equal(bareList.data.counts.in_progress, 1);
    assert.equal(bareList.data.counts.pending, 0);

    // 失败 → 「等我处理」镜头；镜头筛选也能把它筛出来
    await agentPatch(`/api/issues/${bareIssueId}/runs/${bareRunId}`, { status: "failed", note: "跑到一半缺依赖" });
    bareList = await bare("GET", "/api/issues?status=attention");
    assert.equal(bareList.data.total, 1, "失败的 run 应落进「等我处理」镜头");
    assert.equal(bareList.data.issues[0].status, "blocked");

    // 完成 → Issue 自动 done；备注留在 run 上，操作日志有账
    const runDone = await agentPatch(`/api/issues/${bareIssueId}/runs/${bareRunId}`, { status: "completed", note: "已完成：闭环打通" });
    assert.equal(runDone.data.issue.status, "done");
    assert.equal(runDone.data.run.note, "已完成：闭环打通");
    bareStatus = await bare("GET", `/api/boards/${bareBoardId}/task-status`);
    assert.equal(bareStatus.data.statuses[bareCardId].status, "completed");
    assert.equal(bareStatus.data.statuses[bareCardId].summary, "已完成：闭环打通");
    bareList = await bare("GET", "/api/issues?status=done");
    assert.equal(bareList.data.total, 1);

    // Issue 级回写：note 追加日志；无效状态给结构化 400
    const notePatch = await agentPatch(`/api/issues/${bareIssueId}`, { note: "agent 的收尾备注", labels: ["board", "smoke"] });
    assert.equal(notePatch.status, 200);
    assert.ok(notePatch.data.issue.log.some((entry) => entry.detail === "agent 的收尾备注"));
    assert.deepEqual(notePatch.data.issue.labels, ["board", "smoke"]);
    const badStatus = await agentPatch(`/api/issues/${bareIssueId}`, { status: "nonsense" });
    assert.equal(badStatus.status, 400);
    assert.ok(badStatus.data.error.includes("状态无效"), badStatus.data.error);

    // 关键词 / 画板收窄
    const bareQ = await bare("GET", `/api/issues?q=${encodeURIComponent("本地任务卡")}`);
    assert.equal(bareQ.data.total, 1);
    const bareQMiss = await bare("GET", `/api/issues?q=${encodeURIComponent("不存在的词xyz")}`);
    assert.equal(bareQMiss.data.total, 0);
    const bareByBoard = await bare("GET", `/api/issues?board=${bareBoardId}`);
    assert.equal(bareByBoard.data.total, 1);

    // 编辑卡片正文 → 自动同步回本地 Issue（issue-sync 走 local 后端，不再 disabled）
    await bare("PATCH", `/api/boards/${bareBoardId}/cards/${bareCardId}`, { task: { goal: "改过之后的目标正文" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const syncedDetail = await bare("GET", `/api/issues/${bareIssueId}`);
    assert.ok(syncedDetail.data.issue.description.includes("改过之后的目标正文"), "卡片编辑应同步进本地 Issue 正文");

    // 孤儿 Issue：删掉来源画板，任务台照样列出（orphan: true）——本板视角永远看不到它
    await bare("DELETE", `/api/boards/${bareBoardId}`);
    bareList = await bare("GET", "/api/issues");
    assert.equal(bareList.data.total, 1, "画板删了 Issue 还在");
    assert.equal(bareList.data.issues[0].orphan, true);
    assert.equal(bareList.data.issues[0].boardName, null);

    // 页面壳：tasks 恒在 dataset 里，任务后端种类一并下发；未配置的服务地址仍不下发
    const bareHtml = await (await fetch(`${bareBase}/`)).text();
    const bareBody = bareHtml.match(/<body[^>]*>/)?.[0] || "";
    assert.ok(bareBody.includes('data-features="tasks"'), `local 形态 dataset 应含 tasks：${bareBody}`);
    assert.ok(bareBody.includes('data-task-backend="local"'), `dataset 应报 local 后端：${bareBody}`);
    for (const attr of ["data-aidocs-base", "data-book-library", "data-goal-agent-web"]) {
      assert.ok(!bareBody.includes(attr), `未配置形态不该下发 ${attr}`);
    }

    /* /api/skill 的另一种形态：local 后端 + 精简默认 7 包——同一个口，拼出来的指南完全不同 */
    step("skill-local");
    const bareSkill = await (await fetch(`${bareBase}/api/skill`)).text();
    assert.ok(bareSkill.includes("local 后端"), "local 形态应讲本地任务链路");
    assert.ok(bareSkill.includes("回写契约") && bareSkill.includes("issues.json"), "local 形态要带回写指引");
    assert.ok(!bareSkill.includes("Issue 真源在外部 Runner"), "local 形态不讲外部 Runner");
    assert.ok(bareSkill.includes("### 待办（todo）"), "默认集里的包要有小节");
    assert.ok(!bareSkill.includes("### 网页嵌入（html）"), "默认集之外的包不该出现");
    assert.ok(!bareSkill.includes("### 自由画（excalidraw）"));
    // 自管 token 形态：给一条能直接粘的 shell，且用相对表述（不吐绝对路径）
    assert.ok(bareSkill.includes('TOKEN=$(cat "${BLOTBOARD_DATA_DIR:-./data}/token")'), "自管 token 形态要给可复制 shell");
    assert.ok(bareSkill.includes("首次启动自动生成"), bareSkill.slice(0, 400));
    assert.ok(!bareSkill.includes(bareData), "指南不该带本机绝对路径");
    const bareAuth = (await (await fetch(`${bareBase}/api/capabilities`)).json()).auth;
    assert.equal(bareAuth.source, "data-dir");
    assert.equal(bareAuth.tokenFile, "<数据目录>/token");
    assert.ok(!JSON.stringify(bareAuth).includes(bareData), "能力自描述不该带绝对路径");

    /* ── 13. ACP 派单（docs/RUNNER.md §4）：注册 mock agent → 真 spawn 子进程跑一轮 ──
          覆盖：runner-settings CRUD 与鉴权 / env 不回显；auto-finish 全自动完成 +
          transcript 增量；ask 档权限请求进「等我处理」→ API 选择 → 完成；auto 档全自动；
          并发闸 409；cancel 链路（hang → aborted）；服务重启兜底（真重启一次 bare 实例）。 */
    step("acp-runner-settings");
    const MOCK_AGENT = path.join(PROJECT_ROOT, "scripts", "mock-acp-agent.mjs");
    const waitFor = async (fn, what, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      /* eslint-disable no-await-in-loop */
      while (Date.now() < deadline) {
        const value = await fn();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error(`等待超时：${what}`);
    };

    let rs = await bare("GET", "/api/runner-settings");
    assert.equal(rs.status, 200);
    assert.equal(rs.data.backend, "local");
    assert.deepEqual(rs.data.settings.agents, []);
    assert.equal(rs.data.settings.permissionMode, "ask", "权限档位默认 ask");

    // 写口鉴权：无凭据的 PATCH 要被拒
    const rsNoAuth = await fetch(`${bareBase}/api/runner-settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissionMode: "auto" }),
    });
    assert.equal(rsNoAuth.status, 403, "runner-settings 写口应鉴权");

    // 注册三个 mock agent（同一脚本三种模式）；env 值绝不回显
    rs = await bare("PATCH", "/api/runner-settings", {
      agents: [
        { id: "mock-auto", name: "Mock 自动跑完", command: process.execPath, args: [MOCK_AGENT, "--mode", "auto-finish"], env: { MOCK_SECRET: "s3cret-value" } },
        { id: "mock-perm", name: "Mock 要授权", command: process.execPath, args: [MOCK_AGENT, "--mode", "need-permission"] },
        { id: "mock-hang", name: "Mock 挂住", command: process.execPath, args: [MOCK_AGENT, "--mode", "hang"] },
      ],
      defaultAgentId: "mock-auto",
    });
    assert.equal(rs.status, 200, JSON.stringify(rs.data));
    assert.equal(rs.data.settings.agents.length, 3);
    assert.deepEqual(rs.data.settings.agents[0].envKeys, ["MOCK_SECRET"], "env 只回 key 名");
    assert.ok(!JSON.stringify(rs.data).includes("s3cret-value"), "env 值绝不回显给浏览器");
    assert.equal(rs.data.settings.defaultAgentId, "mock-auto");

    // 带已有 id 且不带 env 字段 = 保留存盘 env（浏览器拿不到值，只能这么表达「别动」）
    const keepEnv = await bare("PATCH", "/api/runner-settings", {
      agents: rs.data.settings.agents.map(({ envKeys, ...agent }) => agent),
    });
    assert.deepEqual(keepEnv.data.settings.agents.find((a) => a.id === "mock-auto").envKeys, ["MOCK_SECRET"], "不带 env 字段应保留原值");

    const badMode = await bare("PATCH", "/api/runner-settings", { permissionMode: "yolo" });
    assert.equal(badMode.status, 400);
    const badAgent = await bare("PATCH", "/api/runner-settings", { agents: [{ name: "没命令" }] });
    assert.equal(badAgent.status, 400);
    assert.ok(badAgent.data.error.includes("command"), badAgent.data.error);

    /* auto-finish：card launch 带 agentId → 真 spawn → 流式 transcript → 自动完成 */
    step("acp-launch-auto");
    const acpBoard = (await bare("POST", "/api/boards", { name: "ACP 派单板" })).data.board.id;
    const acpCard = (await bare("POST", `/api/boards/${acpBoard}/cards`, {
      type: "task",
      title: "ACP 冒烟任务",
      task: { goal: "让 mock agent 跑一轮", priority: "medium" },
    })).data.card.id;
    const acpIssueId = (await bare("POST", `/api/boards/${acpBoard}/cards/${acpCard}/issue`)).data.issue.id;

    const badAgentLaunch = await bare("POST", `/api/boards/${acpBoard}/cards/${acpCard}/launch`, { mode: "implement", agentId: "不存在的" });
    assert.equal(badAgentLaunch.status, 400, `未知 agentId 应 400，实际 ${badAgentLaunch.status}`);
    assert.ok(badAgentLaunch.data.error.includes("Runner 设置"), badAgentLaunch.data.error);

    const acpLaunch = await bare("POST", `/api/boards/${acpBoard}/cards/${acpCard}/launch`, { mode: "implement", agentId: "mock-auto" });
    assert.equal(acpLaunch.status, 201, JSON.stringify(acpLaunch.data));
    const acpRunId = acpLaunch.data.task.sessionId;
    assert.match(acpRunId, /^r_/);
    assert.equal(acpLaunch.data.card.task.status, "running", "spawn 即开工");

    await waitFor(async () => (await bare("GET", `/api/issues/${acpIssueId}`)).data.issue.status === "done", "auto-finish run 完成");
    const acpDetail = await bare("GET", `/api/issues/${acpIssueId}`);
    const acpRun = acpDetail.data.issue.runs.find((run) => run.id === acpRunId);
    assert.equal(acpRun.status, "completed");
    assert.equal(acpRun.kind, "acp");
    assert.equal(acpRun.agentName, "Mock 自动跑完");

    // transcript：流式 update 都在（消息块 + plan），增量口径正确
    const tr1 = await bare("GET", `/api/issues/${acpIssueId}/runs/${acpRunId}/transcript`);
    assert.equal(tr1.status, 200);
    const kinds = tr1.data.entries.filter((entry) => entry.type === "update").map((entry) => entry.update.sessionUpdate);
    assert.ok(kinds.includes("agent_message_chunk"), `transcript 应有消息块：${kinds}`);
    assert.ok(kinds.includes("plan"), `transcript 应有 plan：${kinds}`);
    assert.ok(tr1.data.entries.some((entry) => entry.type === "status" && entry.status === "stop" && entry.detail === "end_turn"));
    assert.equal(tr1.data.run.status, "completed");
    const tr2 = await bare("GET", `/api/issues/${acpIssueId}/runs/${acpRunId}/transcript?offset=${tr1.data.offset}`);
    assert.equal(tr2.data.entries.length, 0, "增量读：offset 之后没有新条目");
    assert.equal(tr2.data.offset, tr1.data.offset);
    // 任务卡轮询同一份 run：连身份信息一起带回
    const acpTask = await bare("GET", `/api/runner/tasks/${acpRunId}`);
    assert.equal(acpTask.data.task.status, "completed");
    assert.equal(acpTask.data.task.kind, "acp");

    /* ask 档：request_permission → run waiting → Issue 进「等我处理」→ API 选择 → 完成 */
    step("acp-permission-ask");
    const permLaunch = await bare("POST", `/api/issues/${acpIssueId}/launch`, { mode: "implement", agentId: "mock-perm" });
    assert.equal(permLaunch.status, 201, JSON.stringify(permLaunch.data));
    const permRunId = permLaunch.data.task.sessionId;
    await waitFor(async () => {
      const detail = await bare("GET", `/api/issues/${acpIssueId}`);
      const run = detail.data.issue.runs.find((item) => item.id === permRunId);
      return run.status === "waiting" && run.permissionRequest;
    }, "权限请求挂起");
    const attention = await bare("GET", "/api/issues?status=attention");
    assert.ok(attention.data.issues.some((item) => item.id === acpIssueId), "等授权的 Issue 应进「等我处理」镜头");
    const permDetail = await bare("GET", `/api/issues/${acpIssueId}`);
    const permRun = permDetail.data.issue.runs.find((item) => item.id === permRunId);
    assert.equal(permRun.permissionRequest.options.length, 2);
    assert.ok(permRun.permissionRequest.title.includes("写一个文件"), permRun.permissionRequest.title);

    const permNoAuth = await fetch(`${bareBase}/api/issues/${acpIssueId}/runs/${permRunId}/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "allow" }),
    });
    assert.equal(permNoAuth.status, 403, "权限选择也是写口");
    const permBadOption = await bare("POST", `/api/issues/${acpIssueId}/runs/${permRunId}/permission`, { optionId: "nope" });
    assert.equal(permBadOption.status, 400);

    const permAllow = await bare("POST", `/api/issues/${acpIssueId}/runs/${permRunId}/permission`, { optionId: "allow" });
    assert.equal(permAllow.status, 200, JSON.stringify(permAllow.data));
    await waitFor(async () => {
      const detail = await bare("GET", `/api/issues/${acpIssueId}`);
      return detail.data.issue.runs.find((item) => item.id === permRunId).status === "completed";
    }, "授权后 run 完成");
    const permTr = await bare("GET", `/api/issues/${acpIssueId}/runs/${permRunId}/transcript`);
    assert.ok(permTr.data.entries.some((entry) => entry.type === "permission_request"));
    assert.ok(permTr.data.entries.some((entry) => entry.type === "permission_decision" && entry.optionId === "allow" && entry.auto === false));

    /* auto 档：同一个要授权的 agent，全自动放行跑完 */
    step("acp-permission-auto");
    await bare("PATCH", "/api/runner-settings", { permissionMode: "auto" });
    const autoLaunch = await bare("POST", `/api/issues/${acpIssueId}/launch`, { agentId: "mock-perm" });
    const autoRunId = autoLaunch.data.task.sessionId;
    await waitFor(async () => {
      const detail = await bare("GET", `/api/issues/${acpIssueId}`);
      return detail.data.issue.runs.find((item) => item.id === autoRunId).status === "completed";
    }, "auto 档全自动完成");
    const autoTr = await bare("GET", `/api/issues/${acpIssueId}/runs/${autoRunId}/transcript`);
    assert.ok(autoTr.data.entries.some((entry) => entry.type === "permission_decision" && entry.auto === true), "auto 档要留自动放行的账");
    await bare("PATCH", "/api/runner-settings", { permissionMode: "ask" });

    /* cancel 链路：hang 住的 agent → 并发闸 409 → 中止 → session/cancel 收尾 */
    step("acp-cancel");
    const hangLaunch = await bare("POST", `/api/issues/${acpIssueId}/launch`, { agentId: "mock-hang" });
    assert.equal(hangLaunch.status, 201);
    const hangRunId = hangLaunch.data.task.sessionId;
    await waitFor(async () => {
      const detail = await bare("GET", `/api/issues/${acpIssueId}`);
      return detail.data.issue.runs.find((item) => item.id === hangRunId).status === "running";
    }, "hang run 进入 running");
    const conflictLaunch = await bare("POST", `/api/issues/${acpIssueId}/launch`, { agentId: "mock-auto" });
    assert.equal(conflictLaunch.status, 409, `同一 Issue 并发派单应 409，实际 ${conflictLaunch.status}`);

    const abortPatch = await agentPatch(`/api/issues/${acpIssueId}/runs/${hangRunId}`, { status: "aborted" });
    assert.equal(abortPatch.status, 200);
    // mock 收到 session/cancel 会以 cancelled 收束；run 保持 aborted、Issue 回到待派（可重派）
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterAbort = await bare("GET", `/api/issues/${acpIssueId}`);
    assert.equal(afterAbort.data.issue.runs.find((item) => item.id === hangRunId).status, "aborted");
    assert.equal(afterAbort.data.issue.status, "pending", "aborted 应把 Issue 推回待派");
    const hangTr = await bare("GET", `/api/issues/${acpIssueId}/runs/${hangRunId}/transcript`);
    assert.ok(hangTr.data.entries.some((entry) => entry.type === "status" && entry.status === "cancel"), "transcript 应记 cancel");

    /**
     * transcript 硬上限：写到顶就停笔并留一条「已截断」记号。
     * 收的是别人进程的 stdout，一个跑飞的 agent 能按 MB/s 往这写，
     * 而 append 这条路上没有任何天然的刹车（见 lib/acp/transcript.ts MAX_TRANSCRIPT_BYTES）。
     *
     * 怎么测：再起一个 hang run（它说完一句就安静了，transcript 从此稳定），
     * 手工把文件垫到离上限只差一点，再中止它——中止那条 status 就是越线的那一条。
     */
    step("acp-transcript-cap");
    {
      const CAP = 8 * 1024 * 1024; // 与 lib/acp/transcript.ts 的 MAX_TRANSCRIPT_BYTES 同一个数
      const capLaunch = await bare("POST", `/api/issues/${acpIssueId}/launch`, { agentId: "mock-hang" });
      assert.equal(capLaunch.status, 201);
      const capRunId = capLaunch.data.task.sessionId;
      await waitFor(async () => {
        const detail = await bare("GET", `/api/issues/${acpIssueId}`);
        return detail.data.issue.runs.find((item) => item.id === capRunId).status === "running";
      }, "cap run 进入 running");

      const capFile = path.join(bareData, "runs", `${capRunId}.jsonl`);
      // agent 那句开场白先落进来再垫，免得它排在垫料后面（spawn 即算 running，两者是并发的）
      await waitFor(() => fs.existsSync(capFile) && fs.readFileSync(capFile, "utf8").includes("agent_message_chunk"), "开场白落盘");

      /**
       * 垫到**离上限只差几十字节**：留宽了（比如还剩 400 KB）后面那几条状态记录照样塞得下，
       * 这个用例就会在「什么都没截断」的情况下绿着过去——第一版就是这么翻车的。
       * 一行 200 KB 地垫，最后再补一条长度算准的，别写几万行。
       */
      const padLine = (n) => `${JSON.stringify({ at: 0, type: "update", pad: "x".repeat(n) })}\n`;
      const padOverhead = Buffer.byteLength(padLine(0));
      let gap = CAP - fs.statSync(capFile).size - 1;
      while (gap > padOverhead + 1) {
        fs.appendFileSync(capFile, padLine(Math.min(gap - padOverhead, 200_000)));
        gap = CAP - fs.statSync(capFile).size - 1;
      }
      const padded = fs.statSync(capFile).size;
      assert.ok(padded < CAP && CAP - padded < 128, `垫完该贴着上限，实际还差 ${CAP - padded} 字节`);

      assert.equal((await agentPatch(`/api/issues/${acpIssueId}/runs/${capRunId}`, { status: "aborted" })).status, 200);

      // 中止会连写几条（cancel / stop / 状态），第一条就越线——之后一条都不许再落下来
      await waitFor(() => fs.readFileSync(capFile, "utf8").includes('"truncated":true'), "写满上限后留下「已截断」记号");
      const lines = fs.readFileSync(capFile, "utf8").trimEnd().split("\n");
      const last = JSON.parse(lines[lines.length - 1]);
      assert.equal(last.truncated, true, `记号必须是最后一条，实际是 ${lines[lines.length - 1].slice(0, 200)}`);
      assert.ok(last.detail.includes(String(CAP)), "记号里要说清上限是多少");
      const cappedSize = fs.statSync(capFile).size;
      assert.ok(cappedSize - padded < 1024, `封顶后只该多出一条记号，实际多了 ${cappedSize - padded} 字节`);
      // run 本身照常收尾——截断的是观测面，不是执行
      assert.equal(
        (await bare("GET", `/api/issues/${acpIssueId}`)).data.issue.runs.find((item) => item.id === capRunId).status,
        "aborted",
        "transcript 封顶不该影响 run 的状态流转",
      );
    }

    /* 服务重启兜底：hang run 在跑时真杀掉 bare 实例再拉起来——
          内存表没了、状态还是 running 的 run 必须被启动扫描标成 aborted */
    step("acp-restart-sweep");
    const lostLaunch = await bare("POST", `/api/issues/${acpIssueId}/launch`, { agentId: "mock-hang" });
    const lostRunId = lostLaunch.data.task.sessionId;
    await waitFor(async () => {
      const detail = await bare("GET", `/api/issues/${acpIssueId}`);
      return detail.data.issue.runs.find((item) => item.id === lostRunId).status === "running";
    }, "重启前 run 进入 running");
    bareChild.kill("SIGTERM");
    await waitFor(() => bareChild.exitCode !== null, "bare 实例退出", 8_000);
    bareChild = spawn(process.execPath, ["server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        BLOTBOARD_PORT: String(barePort),
        BLOTBOARD_PORT_STRICT: "1",
        BLOTBOARD_HOST: "127.0.0.1",
        BLOTBOARD_DATA_DIR: bareData,
        BLOTBOARD_DATA_FILE: path.join(bareData, "boards.json"),
        BLOTBOARD_UPLOADS_DIR: path.join(bareData, "uploads"),
        BLOTBOARD_AGENT_COMMANDS_FILE: path.join(bareData, "agent-commands.json"),
        GOAL_AGENT_RUNNER_URL: "",
        BLOTBOARD_RUNNER_URL: "",
        GOAL_AGENT_WEB_URL: "",
        AIDOCS_URL: "",
        BOOK_LIBRARY_URL: "",
        BLOTBOARD_GOAL_AGENT_SETTINGS: "",
        BLOTBOARD_ISSUE_SYNC_DEBOUNCE_MS: "120",
        // 重启要还原同一形态（含「快照关掉」），否则后面的 MCP 用例会对着另一台机器断言
        BLOTBOARD_CHECKPOINT_KEEP: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    bareChild.stderr.on("data", (chunk) => process.stderr.write(`[bare2] ${chunk}`));
    await waitForHealth(bareBase, bareChild);
    const swept = await bare("GET", `/api/issues/${acpIssueId}`);
    const lostRun = swept.data.issue.runs.find((item) => item.id === lostRunId);
    assert.equal(lostRun.status, "aborted", "重启后启动扫描应把丢会话的 run 标中止");
    assert.ok(lostRun.note.includes("服务重启"), lostRun.note);
    const lostTr = await bare("GET", `/api/issues/${acpIssueId}/runs/${lostRunId}/transcript`);
    assert.ok(lostTr.data.entries.some((entry) => entry.type === "status" && String(entry.detail || "").includes("服务重启")));

    /* ── 14. MCP server（bin/blotboard.mjs mcp）：SDK client 起子进程连 stdio，
          对这台隔离的 local 实例跑一遍 工具清单 → capabilities → 建板 → 建卡（含 todo/mermaid 糖）→
          连线 → 评论全链路 → 信封 dry_run/落板 → 读板 md → 整理 → 停用包报错 → 只读模式。 ── */
    step("mcp");
    {
      const text = (result) => result?.content?.[0]?.text || "";
      const parse = (result) => JSON.parse(text(result));
      const mcp = new McpClient({ name: "smoke", version: "0.0.0" });
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.join(PROJECT_ROOT, "bin", "blotboard.mjs"), "mcp"],
          cwd: PROJECT_ROOT,
          env: { ...process.env, BLOTBOARD_URL: bareBase, BLOTBOARD_TOKEN: bareToken },
          stderr: "pipe",
        }),
      );
      const call = (name, args = {}) => mcp.callTool({ name, arguments: args });

      const toolList = await mcp.listTools();
      const toolNames = toolList.tools.map((tool) => tool.name).sort();
      assert.equal(toolNames.length, 18, `MCP 工具应 18 个，实际 ${toolNames.length}`);
      for (const name of [
        "board_list", "board_create", "board_add_card", "board_update_card", "board_delete_card",
        "board_link", "board_edge", "board_layout", "board_comments", "board_card_specs",
        "board_ingest_cards", "board_checkpoints", "board_export", "board_import", "board_to_issue",
        "board_launch", "board_tasks", "blotboard_capabilities",
      ]) {
        assert.ok(toolNames.includes(name), `缺工具 ${name}`);
      }

      const mcpCaps = parse(await call("blotboard_capabilities"));
      assert.equal(mcpCaps.service, "blotboard");
      assert.equal(mcpCaps.tasks.backend, "local");
      assert.ok(String(mcpCaps.connection.write).includes("可写"), mcpCaps.connection.write);
      assert.ok(mcpCaps.connection.skillGuide.endsWith("/api/skill?format=md"));

      const mcpBoard = parse(await call("board_create", { name: "MCP 冒烟板" }));
      const mcpBoardId = mcpBoard.board.id;
      assert.match(mcpBoardId, /^b_[a-z0-9]+$/);

      const mcpText = parse(await call("board_add_card", { board_id: mcpBoardId, title: "MCP 建的卡", content: "由 MCP 工具写入" }));
      const mcpTextId = mcpText.card.id;
      assert.match(mcpTextId, /^c_/);
      assert.ok(mcpText.deepLink.includes(`board=${mcpBoardId}`) && mcpText.deepLink.includes(`card=${mcpTextId}`), "建卡要回深链");

      const mcpTodo = parse(await call("board_add_card", {
        board_id: mcpBoardId, type: "todo", title: "清单",
        todo_items: ["第一件", { text: "第二件", done: true }],
      }));
      assert.equal(mcpTodo.card.todo.items.length, 2, "todo_items 糖要落成 todo.items");
      assert.equal(mcpTodo.card.todo.items[1].done, true);

      const mcpMermaid = parse(await call("board_add_card", { board_id: mcpBoardId, type: "mermaid", title: "流程", diagram: "graph TD; A-->B" }));
      assert.ok(mcpMermaid.card.mermaid.source.includes("A-->B"), "diagram 糖按 type 落到 mermaid.source");

      const mcpEdge = parse(await call("board_link", { board_id: mcpBoardId, from: mcpTextId, to: mcpTodo.card.id, kind: "enables", label: "先想" }));
      assert.match(mcpEdge.edge.id, /^e_/);
      assert.equal(mcpEdge.edge.kind, "enables");

      // 评论全链路：add → list（未解决）→ reply → resolve → 待处理清零
      const mcpComment = parse(await call("board_comments", { board_id: mcpBoardId, action: "add", target_id: mcpTextId, text: "MCP 加的批注" }));
      const mcpCommentId = mcpComment.comment.id;
      assert.match(mcpCommentId, /^cm_/);
      assert.equal(mcpComment.comment.target, "card", "target 从 target_id 前缀推断");
      const mcpOpen = parse(await call("board_comments", { board_id: mcpBoardId }));
      assert.equal(mcpOpen.total, 1);
      const mcpReplied = parse(await call("board_comments", { board_id: mcpBoardId, action: "reply", comment_id: mcpCommentId, text: "已按这条处理" }));
      assert.equal(mcpReplied.comment.replies.length, 1);
      assert.equal(mcpReplied.comment.replies[0].createdBy, "agent");
      const mcpResolved = parse(await call("board_comments", { board_id: mcpBoardId, action: "resolve", comment_id: mcpCommentId }));
      assert.equal(mcpResolved.comment.resolved, true);
      assert.equal(parse(await call("board_comments", { board_id: mcpBoardId })).total, 0, "解决后未处理清单应清零");

      // 信封：dry_run 干跑（不落库）→ 真落板
      const mcpDry = parse(await call("board_ingest_cards", {
        dry_run: true,
        cards: [{ type: "text", title: "信封干跑" }, { spec: "no-such-spec", fields: { a: 1 } }],
      }));
      assert.equal(mcpDry.report.counts.cards, 2);
      assert.equal(mcpDry.report.specs.find((spec) => spec.id === "no-such-spec")?.installed, false);
      const boardsBeforeIngest = parse(await call("board_list", {})).total;
      const mcpIngest = parse(await call("board_ingest_cards", {
        board_id: mcpBoardId,
        cards: [{ type: "text", title: "信封收进来的卡", content: "batch" }],
      }));
      assert.equal(mcpIngest.created.length, 1);
      assert.equal(parse(await call("board_list", {})).total, boardsBeforeIngest, "ingest 不该多出画板");

      // 读板：列表 → 整板 markdown（评论摊在卡片下面的那份）
      const mcpList = parse(await call("board_list", {}));
      assert.ok(mcpList.boards.some((board) => board.id === mcpBoardId));
      const mcpMd = text(await call("board_list", { board_id: mcpBoardId, as_markdown: true }));
      assert.ok(mcpMd.includes("MCP 建的卡") && mcpMd.includes("信封收进来的卡"), "as_markdown 要给整板 md");

      const mcpTidy = parse(await call("board_layout", { board_id: mcpBoardId, mode: "tidy" }));
      assert.equal(mcpTidy.mode, "tidy");

      // 搬家：board_export format=bundle → board_import，agent 也能备份 / 迁移画板
      const mcpBundle = parse(await call("board_export", { board_id: mcpBoardId, format: "bundle" }));
      assert.equal(mcpBundle.format, "blotboard.boards");
      assert.equal(mcpBundle.boards.length, 1);
      const mcpImported = parse(await call("board_import", { content: JSON.stringify(mcpBundle), group: "搬家过来的" }));
      assert.equal(mcpImported.imported.length, 1);
      assert.notEqual(mcpImported.imported[0].id, mcpBoardId, "导入是新建，不覆盖原板");
      assert.equal(mcpImported.imported[0].group, "搬家过来的");
      const mcpImportedBoard = parse(await call("board_list", { board_id: mcpImported.imported[0].id }));
      assert.equal(mcpImportedBoard.cards.length, mcpBundle.boards[0].cards.length);
      const mcpBadImport = await call("board_import", { content: "{\"hello\":\"world\"}" });
      assert.equal(mcpBadImport.isError, true);
      assert.ok(text(mcpBadImport).includes("画板"), text(mcpBadImport));

      /**
       * 导出范围必须**明确选一个**。以前没给 board_id / group 就默认 `all=1`，
       * 于是显式写了 `all:false` 的调用照样把整个库导出来——参数说的和干的相反，
       * 返回的还是成功。少打一个 board_id 就整库出走，这种默认值不该存在。
       */
      const mcpNoScope = await call("board_export", { format: "bundle" });
      assert.equal(mcpNoScope.isError, true, "format=bundle 不给范围要报错，不能默认导全库");
      assert.ok(text(mcpNoScope).includes("board_id") && text(mcpNoScope).includes("all=true"), text(mcpNoScope));
      const mcpAllFalse = await call("board_export", { format: "bundle", all: false, with_assets: false });
      assert.equal(mcpAllFalse.isError, true, "all=false 不是「导全库」的意思");
      assert.ok(text(mcpAllFalse).includes("all=false"), text(mcpAllFalse));
      const mcpTwoScopes = await call("board_export", { format: "bundle", board_id: mcpBoardId, group: "搬家过来的" });
      assert.equal(mcpTwoScopes.isError, true, "范围只能给一个");
      const mcpAllTrue = parse(await call("board_export", { format: "bundle", all: true, with_assets: false }));
      assert.ok(mcpAllTrue.boards.length >= 2, "显式 all=true 才导整个库");

      /**
       * **组合回归**：分卷（服务端不再截断，超限回 413 附计划）× MCP 导出范围。
       *
       * 这两处改动各自都对，合起来却留了个缝：413 的正文说「给同一个地址加 volume=N」，
       * 而 MCP 的 board_export 当时根本没有 volume 参数——agent 收到一句自己执行不了的指路，
       * 库一超过上限，整库 / 整组导出就是死路。谁单独跑自己的用例都发现不了，
       * 因为一边只测 HTTP、一边的库里没那么多板。
       */
      const mcpVolGroup = "MCP 分卷组（冒烟）";
      const mcpVolIds = [];
      for (let at = 0; at < 201; at += 1) {
        mcpVolIds.push((await bare("POST", "/api/boards", { name: `MCP 卷${at}`, group: mcpVolGroup })).data.board.id);
      }
      // 不给 volume：不能是半份，也不能是一句只有 HTTP 语义的报错
      const mcpOver = await call("board_export", { format: "bundle", group: mcpVolGroup, with_assets: false });
      assert.equal(mcpOver.isError, true, "超过上限不能返回半份画板包");
      const mcpOverText = text(mcpOver);
      assert.ok(mcpOverText.includes("201"), mcpOverText.slice(0, 300));
      assert.ok(mcpOverText.includes("volume=1"), "报错要给出 MCP 自己能执行的下一步");
      assert.ok(mcpOverText.includes("board_import"), "要说清逐卷取回后怎么还原");
      // plan：只看计划不打包
      const mcpPlan = parse(await call("board_export", { format: "bundle", group: mcpVolGroup, plan: true }));
      assert.equal(mcpPlan.total, 201, "计划要报完整总数，不是截断后的 200");
      assert.equal(mcpPlan.volumes, 2, "201 块按上限 200 应分 2 卷");
      // 逐卷取回：两卷合起来 201 块，一块不重不漏
      const mcpVol1 = parse(await call("board_export", { format: "bundle", group: mcpVolGroup, volume: 1, with_assets: false }));
      const mcpVol2 = parse(await call("board_export", { format: "bundle", group: mcpVolGroup, volume: 2, with_assets: false }));
      assert.equal(mcpVol1.volume.index, 1, "卷上要写清自己是第几卷");
      assert.equal(mcpVol1.volume.total, 2);
      const mcpVolSeen = new Set([...mcpVol1.boards, ...mcpVol2.boards].map((board) => board.id));
      assert.equal(mcpVolSeen.size, 201, "两卷合起来必须正好是那 201 块，不重不漏");
      // 每一卷都得是能原样导回去的完整包（分卷不是「另一种格式」）
      const mcpVolBack = parse(await call("board_import", { content: JSON.stringify(mcpVol2) }));
      assert.ok(mcpVolBack.imported.length >= 1, "取回的卷要能原样 board_import 回去");
      for (const id of mcpVolBack.imported.map((item) => item.id)) mcpVolIds.push(id);
      for (const id of mcpVolIds) await bare("DELETE", `/api/boards/${id}`);

      /**
       * 机器要再吃回去的产物**不许静默截断**。
       *
       * 以前所有输出都走同一条 160000 字的截断：导出一份大画板包，工具返回 isError=false、
       * 文本末尾一句「已截断」，而那份 JSON 根本解析不了——agent 把它当备份存起来，
       * 等真要恢复的那天才发现什么都没有。现在超长直接报错，并给出能拿到完整产物的确切 HTTP 路径。
       */
      const mcpBigBoard = parse(await call("board_create", { name: "MCP 大板" })).board.id;
      const mcpFiller = "整板导出体积测试 ".repeat(2000);
      for (let i = 0; i < 18; i += 1) {
        await call("board_add_card", { board_id: mcpBigBoard, title: `大卡 ${i}`, content: mcpFiller });
      }
      const mcpBig = await call("board_export", { board_id: mcpBigBoard, format: "bundle" });
      assert.equal(mcpBig.isError, true, "超长的画板包不能当成功返回半份");
      const mcpBigText = text(mcpBig);
      assert.ok(mcpBigText.includes("超过 MCP 单次输出上限"), mcpBigText.slice(0, 200));
      assert.ok(!mcpBigText.includes("已截断"), "不该再返回截断产物");
      assert.ok(mcpBigText.includes("别拿 format=md"), "要明说 markdown 不是备份");
      // 报错里给的那条路必须真能拿到**可再导入**的完整产物，agent 才接得下去
      const mcpHref = /curl -fsS '([^']+)'/.exec(mcpBigText);
      assert.ok(mcpHref, mcpBigText.slice(0, 400));
      const mcpDownloaded = await (await fetch(mcpHref[1])).text();
      const mcpDownloadedBundle = JSON.parse(mcpDownloaded);
      assert.equal(mcpDownloadedBundle.format, "blotboard.boards", "下载口给的应该是标准画板包，不用再剥壳");
      const mcpBigBack = parse(await call("board_import", { content: mcpDownloaded }));
      assert.equal(mcpBigBack.imported.length, 1, "下载下来的那份要能原样导回去");

      /* MCP annotations（C4）：给客户端展示用的提示，不是权限校验 */
      const byName = Object.fromEntries(toolList.tools.map((tool) => [tool.name, tool]));
      for (const tool of toolList.tools) {
        assert.ok(tool.annotations, `${tool.name} 少了 annotations`);
        assert.ok(tool.annotations.title, `${tool.name} 的 annotations 要有 title`);
      }
      assert.equal(byName.board_export.annotations.readOnlyHint, true, "导出是只读的");
      assert.equal(byName.board_export.annotations.destructiveHint, false, "只读的不该同时标 destructive");
      assert.equal(byName.board_list.annotations.readOnlyHint, true);
      assert.equal(byName.board_delete_card.annotations.readOnlyHint, false);
      assert.equal(byName.board_delete_card.annotations.destructiveHint, true, "删卡要标 destructive");
      assert.equal(byName.board_import.annotations.destructiveHint, true, "restore + replace 会覆盖同 id 的板");
      assert.equal(byName.board_ingest_cards.annotations.destructiveHint, false, "信封是纯追加");
      assert.equal(byName.board_to_issue.annotations.idempotentHint, true, "转 Issue 是幂等的");
      assert.equal(byName.board_launch.annotations.openWorldHint, true, "发起执行会跑到外部 Runner 上");
      assert.equal(byName.board_create.annotations.openWorldHint, false, "建板就在这一台画板上，是闭域");

      // 服务端报错要变成工具结果（isError + 原文），不是协议层异常：svg 在这台的默认集之外
      const mcpBlocked = await call("board_add_card", { board_id: mcpBoardId, type: "svg", diagram: "<svg/>" });
      assert.equal(mcpBlocked.isError, true);
      assert.ok(text(mcpBlocked).includes("已停用"), text(mcpBlocked));

      // 这台实例把快照关了：board_checkpoints 要说实话并指路（别让 agent 以为「还没有快照」）
      const mcpCpOff = parse(await call("board_checkpoints", { board_id: mcpBoardId }));
      assert.equal(mcpCpOff.enabled, false);
      assert.equal(mcpCpOff.total, 0);
      assert.ok(String(mcpCpOff.note).includes("board_export"), mcpCpOff.note);
      // 日志与快照是两件事：不打点也照样有「谁改了什么」
      const mcpCpLog = parse(await call("board_checkpoints", { board_id: mcpBoardId, action: "activity" }));
      assert.ok(mcpCpLog.activity.some((entry) => entry.action === "ingest"), "刚才那次信封落板应记上一条");
      const mcpCpBad = await call("board_checkpoints", { board_id: mcpBoardId, action: "restore" });
      assert.equal(mcpCpBad.isError, true);
      assert.ok(text(mcpCpBad).includes("stamp"), text(mcpCpBad));

      await mcp.close();

      /* 同一套工具打**主实例**（那台开着快照）：走一遍完整的「批量写 → 列表 → 回滚」 */
      const mcpMain = new McpClient({ name: "smoke-main", version: "0.0.0" });
      await mcpMain.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.join(PROJECT_ROOT, "bin", "blotboard.mjs"), "mcp"],
          cwd: PROJECT_ROOT,
          env: { ...process.env, BLOTBOARD_URL: base, BLOTBOARD_TOKEN: RUNNER_TOKEN },
          stderr: "pipe",
        }),
      );
      {
        const mainCall = (name, args = {}) => mcpMain.callTool({ name, arguments: args });
        const board = parse(await mainCall("board_create", { name: "MCP 快照板" })).board;
        await mainCall("board_add_card", { board_id: board.id, type: "text", title: "MCP 原始卡" });
        // 批量入口（信封）→ 自动打点
        await mainCall("board_ingest_cards", { board_id: board.id, cards: [{ type: "text", title: "信封加的" }] });
        const listed = parse(await mainCall("board_checkpoints", { board_id: board.id }));
        assert.equal(listed.enabled, true);
        assert.equal(listed.total, 1, "信封落板前要打一份点");
        assert.equal(listed.checkpoints[0].reason, "ingest");
        assert.equal(listed.checkpoints[0].counts.cards, 1, "快照里是收信之前那一张");
        const rolled = parse(await mainCall("board_checkpoints", {
          board_id: board.id,
          action: "restore",
          stamp: listed.checkpoints[0].stamp,
        }));
        assert.equal(rolled.restored, listed.checkpoints[0].stamp);
        assert.ok(rolled.undoCheckpoint, "回滚前那一刻也要留一份，回滚本身才有回头路");
        assert.equal(rolled.board.counts.cards, 1, "回滚后回到收信之前");
        await request("DELETE", `/api/boards/${board.id}`, { headers: AGENT(RUNNER_TOKEN) });
      }
      await mcpMain.close();

      // 只读模式：没 token、端口又不是默认 8567 → 不去磁盘摸 token；读工具照常，写工具指路
      const readonly = new McpClient({ name: "smoke-ro", version: "0.0.0" });
      await readonly.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.join(PROJECT_ROOT, "bin", "blotboard.mjs"), "mcp"],
          cwd: PROJECT_ROOT,
          env: { ...process.env, BLOTBOARD_URL: bareBase, BLOTBOARD_TOKEN: "", BLOTBOARD_DATA_DIR: "" },
          stderr: "pipe",
        }),
      );
      const roList = await readonly.callTool({ name: "board_list", arguments: {} });
      assert.ok(JSON.parse(roList.content[0].text).total >= 1, "只读模式读工具照常");
      const roWrite = await readonly.callTool({ name: "board_create", arguments: { name: "不该建出来" } });
      assert.equal(roWrite.isError, true);
      assert.ok(roWrite.content[0].text.includes("只读模式"), roWrite.content[0].text);
      await readonly.close();
    }

    bareChild.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (bareChild.exitCode === null) bareChild.kill("SIGKILL");
    bareChild = null;
  }

  console.log("✅ blotboard API 冒烟测试全部通过");
}

async function cleanup() {
  for (const proc of [child, bareChild]) {
    if (proc && proc.exitCode === null) {
      proc.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  }
  await new Promise((resolve) => runner.close(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`❌ blotboard 冒烟测试失败（步骤 ${mark}）：`, err);
    await cleanup();
    process.exit(1);
  });
