#!/usr/bin/env node
/**
 * 两条可选集成的**参考实现**（知识库 + 书库），docs/INTEGRATIONS.md 的可执行版本。
 *
 * 用途有三个，都不是玩具：
 *  1. **验形状**：自己写了知识库 / 书库服务，拿这份对照着比字段；
 *  2. **跑通卡片**：没有真服务时也能把资料卡与图书卡完整走一遍（本地开发 / 演示 / 录屏）；
 *  3. **当文档**：协议文档会过期，能跑起来的代码不会——这个文件与 docs/INTEGRATIONS.md
 *     必须同时改。
 *
 * 刻意写成**零依赖单文件**（只用 node: 内置模块），复制走就能改。
 * 数据是写死的假数据，不读磁盘、不联网、不落任何东西。
 *
 * 用法：
 *   node scripts/mock-integrations.mjs                 # 默认 8899
 *   node scripts/mock-integrations.mjs --port 9100
 *
 * 然后：
 *   AIDOCS_URL=http://127.0.0.1:8899 BOOK_LIBRARY_URL=http://127.0.0.1:8899 npm run dev
 */
import http from "node:http";

const port = (() => {
  const index = process.argv.indexOf("--port");
  const value = index >= 0 ? Number(process.argv[index + 1]) : Number(process.env.PORT);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 8899;
})();

/* ── 假数据 ───────────────────────────────────────── */

const DOCS = [
  {
    resource_id: "doc:bilibili:186864",
    doc_id: "186864",
    title: "从零做一块给 agent 用的画板",
    platform: "bilibili",
    source_url: "https://example.com/video/1",
    snippet: "画板与 agent 之间只有一份 HTTP API：人在页面上做的每件事，agent 也能做。",
    score: 0.91,
  },
  {
    resource_id: "doc:wechat:186865",
    doc_id: "186865",
    title: "本地优先：数据放在自己盘上意味着什么",
    platform: "wechat",
    source_url: "https://example.com/article/2",
    snippet: "没有账号体系、没有多租户，边界落在网络层——这是取舍，不是遗漏。",
    score: 0.77,
  },
  {
    resource_id: "doc:web:186866",
    doc_id: "186866",
    title: "卡片规格：把「加一种卡」从写代码降成填 JSON",
    platform: "web",
    source_url: "https://example.com/post/3",
    snippet: "能下沉成规格 JSON 的需求，就不该写成一个代码包。",
    score: 0.64,
  },
];

const BOOKS = [
  {
    id: "how-boards-work",
    name: "画板是怎么工作的",
    subtitle: "一本给 agent 看的说明书",
    author: "参考实现",
    desc: "演示用的假书：书目 / 封面 / 三个阅读入口，协议要求的字段这里都有。",
    files: { html: "read.html", pdf: "book.pdf", md: "book.md" },
    model: "mock-pipeline-v1",
    created: "2026-01-02",
    updated: "2026-03-04",
  },
  {
    id: "local-first-notes",
    name: "本地优先札记",
    author: "参考实现",
    desc: "只登记了 Markdown 一个产物——协议允许缺，缺的那两个入口就地不渲染。",
    files: { md: "notes.md" },
    created: "2026-02-10",
    updated: "2026-02-11",
  },
];

/** 封面：一张自绘 SVG，不引外部资源（画板会给这条响应挂禁脚本的 CSP）。 */
function coverSvg(book) {
  const title = String(book.name || book.id).replace(/[&<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420" width="300" height="420">
  <rect width="300" height="420" fill="#1f2937"/>
  <rect x="16" y="16" width="268" height="388" fill="none" stroke="#64748b" stroke-width="2"/>
  <text x="150" y="200" fill="#e2e8f0" font-family="sans-serif" font-size="20" text-anchor="middle">${title}</text>
  <text x="150" y="236" fill="#94a3b8" font-family="sans-serif" font-size="13" text-anchor="middle">mock cover</text>
</svg>`;
}

/* ── 路由 ─────────────────────────────────────────── */

const json = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

/** 检索：对标题 / 摘要做子串匹配就够了——这里演示的是**形状**，不是检索质量。 */
function search(query, limit, platform) {
  const needle = String(query || "").trim().toLowerCase();
  const rows = DOCS.filter((doc) => {
    if (platform && doc.platform !== platform) return false;
    if (!needle) return true;
    return `${doc.title}${doc.snippet}`.toLowerCase().includes(needle);
  });
  // 一条都没命中时回全部：演示场景里空结果最没意思
  return (rows.length ? rows : DOCS).slice(0, Math.max(1, Math.min(30, Number(limit) || 10)));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const route = `${req.method} ${url.pathname}`;

  /* —— 知识库 —— */
  // 向量检索用 top_k、混合检索用 limit：参数名不同是历史形状，画板照实发
  if (route === "POST /api/agent/vectors/search" || route === "POST /api/agent/search") {
    const body = await readBody(req);
    const vector = url.pathname.endsWith("/vectors/search");
    const results = search(body.query, vector ? body.top_k : body.limit, body.platform);
    return json(res, 200, {
      query_interpreted: String(body.query || ""),
      total: results.length,
      results,
    });
  }

  /* —— 书库 —— */
  if (route === "GET /api/books") {
    return json(res, 200, { books: BOOKS });
  }

  const cover = /^\/covers\/([a-z0-9_-]+)\.svg$/.exec(url.pathname);
  if (req.method === "GET" && cover) {
    const book = BOOKS.find((item) => item.id === cover[1]);
    if (!book) return json(res, 404, { error: "没有这本书的封面" });
    const body = coverSvg(book);
    res.writeHead(200, { "content-type": "image/svg+xml", "content-length": Buffer.byteLength(body) });
    return res.end(body);
  }

  // 产物文件：真实书库这里是静态站点，mock 回一句话证明链接是通的
  const file = /^\/books\/([a-z0-9_-]+)\/(.+)$/.exec(url.pathname);
  if (req.method === "GET" && file) {
    const book = BOOKS.find((item) => item.id === file[1]);
    if (!book) return json(res, 404, { error: "没有这本书" });
    const body = `# ${book.name}\n\n参考实现的占位正文（${file[2]}）。真实书库这里应该是那本书的产物文件。\n`;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(body);
  }

  json(res, 404, { error: `参考实现没有这个口：${route}（协议见 docs/INTEGRATIONS.md）` });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-integrations] http://127.0.0.1:${port}`);
  console.log("  知识库： POST /api/agent/vectors/search · POST /api/agent/search");
  console.log("  书  库： GET /api/books?full=1 · GET /covers/{id}.svg · GET /books/{id}/{file}");
  console.log("");
  console.log(`  AIDOCS_URL=http://127.0.0.1:${port} BOOK_LIBRARY_URL=http://127.0.0.1:${port} npm run dev`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
