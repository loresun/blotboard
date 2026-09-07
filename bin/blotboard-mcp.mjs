/**
 * blotboard MCP server（stdio）：把画板 HTTP API 包成一套 board_* 工具。
 *
 * 设计取舍：
 *  - 薄代理，不落任何本地状态——数据真源永远是画板服务，这里只做「HTTP → 工具」的翻译
 *    与少量 agent 友好的糖（outline → 导图树、todo_items → todo.items、错误带指路文案）；
 *  - 用 SDK 的低层 Server + 原生 JSON Schema，不经 zod——本仓库新增依赖只有
 *    @modelcontextprotocol/sdk 一个，不把它的传递依赖变成我们的 API；
 *  - stdout 归 JSON-RPC 专用，诊断一律走 stderr（console.error）。
 *
 * 环境变量：BLOTBOARD_URL（默认 http://127.0.0.1:8567）· BLOTBOARD_TOKEN（写操作）
 * · BLOTBOARD_DATA_DIR（只用来找 token 文件）。token 找不到时进入只读模式：
 * 读工具照常，写工具返回指路提示（而不是让 agent 对着 403 猜）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/**
 * 画板地址：env 显式指定优先；否则看数据目录里的 `port` 文件——
 * 画板启动时会把**实际落位**的端口写在那儿（默认 8567，被占则顺延 8568…），
 * 没有它就只能猜默认端口，画板一顺延这条 MCP 就连了个空。
 */
function resolveBase() {
  if (process.env.BLOTBOARD_URL) return process.env.BLOTBOARD_URL.replace(/\/+$/, "");
  const candidates = [
    process.env.BLOTBOARD_DATA_DIR ? path.join(path.resolve(process.env.BLOTBOARD_DATA_DIR), "port") : null,
    path.join(process.cwd(), "data", "port"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "port"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const port = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
    } catch {
      /* 下一个候选 */
    }
  }
  return "http://127.0.0.1:8567";
}

const BASE = (() => {
  let url;
  try { url = new URL(resolveBase()); }
  catch { throw new Error("BLOTBOARD_URL 必须是有效的 HTTP/HTTPS 画板地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("BLOTBOARD_URL 不能包含凭据、查询参数或片段；凭据请使用 BLOTBOARD_TOKEN");
  }
  return url.href.replace(/\/+$/, "");
})();

/**
 * token 三级来源：env BLOTBOARD_TOKEN → <data>/token 文件（只在连**本机**画板时才去
 * 磁盘上摸——URL 指向远程时，本机文件里的 token 跟对端毫无关系）→ 没有 = 只读模式。
 * 文件候选按「用户显式说的优先」：BLOTBOARD_DATA_DIR → 当前目录 ./data → 本包旁边的 data/
 * （从仓库 checkout 里 npx --no-install 跑的场景）。
 */
function resolveToken() {
  if (process.env.BLOTBOARD_TOKEN) return { token: process.env.BLOTBOARD_TOKEN.trim(), source: "env BLOTBOARD_TOKEN" };
  let url = null;
  try {
    url = new URL(BASE);
  } catch {
    return { token: null, source: null };
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  // 「本机默认实例」的判定跟着 BASE 走：BASE 可能是从 <data>/port 读出来的顺延端口，
  // 那同样是本机自己的画板，token 文件当然算数
  const defaultPort = !process.env.BLOTBOARD_URL || (url.port || "80") === "8567";
  // 非默认端口通常是隔离实例（冒烟 / 多开），除非用户用 BLOTBOARD_DATA_DIR 显式指了数据目录
  if (!loopback || (!defaultPort && !process.env.BLOTBOARD_DATA_DIR)) return { token: null, source: null };
  const candidates = [
    process.env.BLOTBOARD_DATA_DIR ? path.join(path.resolve(process.env.BLOTBOARD_DATA_DIR), "token") : null,
    path.join(process.cwd(), "data", "token"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "token"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const token = fs.readFileSync(file, "utf8").trim();
      if (token) return { token, source: "<数据目录>/token" };
    } catch {
      /* 下一个候选 */
    }
  }
  return { token: null, source: null };
}

const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken();

const READONLY_HINT =
  "当前是只读模式（没找到写操作 token）。解决：设环境变量 BLOTBOARD_TOKEN，" +
  "或在画板仓库目录里跑（会读 <data>/token，首次启动画板时自动生成并打印路径）。";

/** 工具层的已知错误：消息直接回给 agent（isError 结果），不当成协议层异常。 */
class ToolError extends Error {
  /** HTTP 状态码（只有从 `api()` 抛出来的才有）：调用方要按状态分支时用它，别去正则匹配错误文案。 */
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

async function api(method, pathname, { body, rawBody, write = false, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  // rawBody：导入那条路要原样发文件内容（JSON 或 HTML），不能再被 JSON.stringify 包一层
  if (rawBody !== undefined) headers["content-type"] = "text/plain;charset=utf-8";
  if (write || rawBody !== undefined) {
    if (!TOKEN) throw new ToolError(READONLY_HINT);
    headers["x-auth-key"] = TOKEN;
  }
  let response;
  try {
    response = await fetch(`${BASE}${pathname}`, {
      method,
      headers,
      body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  } catch (err) {
    throw new ToolError(
      "连不上已配置的画板（连接失败、超时或重定向）。" +
        "确认服务在跑（画板仓库里 npm start），或用 BLOTBOARD_URL 指对地址。",
    );
  }
  const text = await response.text();
  if (raw) {
    if (!response.ok) throw new ToolError(`HTTP ${response.status}：${text.slice(0, 500)}`);
    return text;
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 响应走下面的兜底 */
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}：${data?.error || text.slice(0, 300) || "（无正文）"}`;
    if (write && response.status === 403) {
      message += `\n${TOKEN ? `画板不认这个 token（来源：${TOKEN_SOURCE}）。确认它与画板的内部 token 一致（env BLOTBOARD_INTERNAL_TOKEN 或画板 <data>/token）。` : READONLY_HINT}`;
    }
    const error = new ToolError(message, response.status);
    // 413 的正文里带着整份分卷计划，调用方要照着它给出下一步，别只剩一句报错
    if (data?.plan) error.plan = data.plan;
    throw error;
  }
  return data;
}

/* ── 输出 ─────────────────────────────────────────── */

const MAX_TEXT = 160_000;

function textResult(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length > MAX_TEXT) {
    text = `${text.slice(0, MAX_TEXT)}\n…（输出超长已截断；改用 as_markdown 或收窄参数）`;
  }
  return { content: [{ type: "text", text }] };
}

/**
 * **机器要再吃回去的产物一律不许截断。**
 *
 * textResult 那条截断是给「读给人看 / 塞进上下文」的文本用的：少几行摘要无所谓。
 * 但画板包、整板 JSON、卡片信封是要被 board_import / PUT whole / POST ingest
 * 原样吃回去的——截断出来的 JSON 解析不了，而工具却返回「成功」，
 * agent 会把一份坏文件当成备份存起来，等真要恢复的那天才发现什么都没有。
 *
 * 所以超长就**报错**，并且把「完整拿到它」的确切 HTTP 路径连同收窄办法一起给出去，
 * 让 agent 拿到结果还能接着往下走，而不是只知道「失败了」。
 */
function machineResult(value, { what, download, unwrap = null, narrow = [] }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_TEXT) return { content: [{ type: "text", text }] };
  throw new ToolError(
    [
      `${what}有 ${text.length} 字符，超过 MCP 单次输出上限 ${MAX_TEXT}。`,
      "这类产物是要被原样导回去的，截断后就不是有效 JSON 了，所以这里不给半份——完整的一份走 HTTP 直接下载：",
      "",
      `  curl -fsS ${download.includes("'") ? JSON.stringify(download) : `'${download}'`} -o blotboard-export.json`,
      "",
      unwrap
        ? `（导出是只读口，不需要 token。${unwrap}）`
        : "（导出是只读口，不需要 token。落地的文件可以原样交给 board_import 的 content，或 POST 到 /api/boards/import。）",
      ...(narrow.length ? ["", "想留在 MCP 里一次拿全，就把范围收窄：", ...narrow.map((line) => `  · ${line}`)] : []),
      "",
      "别拿 format=md / as_markdown 当备份——那是给人读的摘要，导不回来。",
    ].join("\n"),
  );
}

/** 整板 JSON 里最占地方的是 Excalidraw 画布源码——读板场景把它折叠成占位说明。 */
function compactCard(card) {
  if (card?.excalidraw?.source && card.excalidraw.source.length > 400) {
    return {
      ...card,
      excalidraw: { ...card.excalidraw, source: `（.excalidraw JSON 共 ${card.excalidraw.source.length} 字符，读板时折叠；要完整内容走 GET /api/boards/{id}）` },
    };
  }
  return card;
}

/* ── agent 友好的糖 ───────────────────────────────── */

/**
 * 缩进大纲 → 导图树：一行一个节点，每 2 个空格一层，第一行是中心主题，
 * 行首的 `-`/`*` 允许但不要求。让 agent 不用手写嵌套 JSON。
 */
function outlineToMindRoot(outline) {
  const lines = String(outline || "")
    .replace(/\t/g, "  ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim());
  if (!lines.length) return null;
  const parse = (line) => {
    const indent = /^ */.exec(line)[0].length;
    return { depth: Math.floor(indent / 2), text: line.trim().replace(/^[-*]\s+/, "") };
  };
  const root = { text: parse(lines[0]).text, children: [] };
  const stack = [{ node: root, depth: 0 }];
  for (const line of lines.slice(1)) {
    const { depth, text } = parse(line);
    const node = { text, children: [] };
    const level = Math.max(1, depth);
    while (stack.length > 1 && stack[stack.length - 1].depth >= level) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, depth: level });
  }
  return root;
}

function normalizeTodoItems(items) {
  return (Array.isArray(items) ? items : []).map((item) =>
    typeof item === "string" ? { text: item, done: false } : { text: String(item?.text || ""), done: item?.done === true, ...(item?.id ? { id: item.id } : {}) },
  );
}

/** add/update 共用的卡片请求体拼装：只带调用方真提了的字段（PATCH 语义要求）。 */
async function buildCardBody(args, { forUpdate = false } = {}) {
  const body = {};
  const type = args.type ? String(args.type) : undefined;
  if (type) body.type = type;
  for (const key of ["title", "content", "x", "y", "w", "h", "z", "color"]) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  if (args.agent_prompt !== undefined) body.agentPrompt = args.agent_prompt;
  if (!forUpdate) body.createdBy = "agent";

  if (args.goal !== undefined || args.priority !== undefined || args.task_status !== undefined) {
    body.task = {};
    if (args.goal !== undefined) body.task.goal = args.goal;
    if (args.priority !== undefined) body.task.priority = args.priority;
    if (args.task_status !== undefined) body.task.status = args.task_status;
  }
  if (args.url !== undefined || args.link_title !== undefined || args.link_desc !== undefined) {
    body.link = {};
    if (args.url !== undefined) body.link.url = args.url;
    if (args.link_title !== undefined) body.link.title = args.link_title;
    if (args.link_desc !== undefined) body.link.desc = args.link_desc;
  }
  if (args.quote_source !== undefined) body.quote = { source: args.quote_source };
  if (args.upload_id !== undefined) body.file = { uploadId: args.upload_id, ...(args.file_name ? { name: args.file_name } : {}) };
  if (args.outline !== undefined || args.mind_layout !== undefined) {
    body.mindmap = {};
    if (args.outline !== undefined) {
      const root = outlineToMindRoot(args.outline);
      if (!root) throw new ToolError("outline 是空的：一行一个节点，每 2 个空格缩进一层，第一行是中心主题");
      body.mindmap.root = root;
    }
    if (args.mind_layout !== undefined) body.mindmap.layout = args.mind_layout;
  }
  if (args.todo_items !== undefined) body.todo = { items: normalizeTodoItems(args.todo_items) };
  if (args.diagram !== undefined) {
    // 同一个参数按目标类型落到 mermaid.source 或 svg.source
    const target = type || (forUpdate ? null : "mermaid");
    if (target === "svg") body.svg = { source: args.diagram };
    else if (target === "mermaid") body.mermaid = { source: args.diagram };
    else throw new ToolError("diagram 参数需要配合 type=mermaid 或 type=svg（更新时也要显式给 type）");
  }
  if (args.html_url !== undefined || args.frame_w !== undefined || args.frame_h !== undefined || args.embed_mode !== undefined) {
    body.html = {};
    if (args.html_url !== undefined) body.html.url = args.html_url;
    if (args.frame_w !== undefined) body.html.frameW = args.frame_w;
    if (args.frame_h !== undefined) body.html.frameH = args.frame_h;
    if (args.embed_mode !== undefined) body.html.mode = args.embed_mode;
  }
  if (args.spec_id !== undefined || args.fields !== undefined || args.data_source !== undefined) {
    body.data = {};
    if (args.spec_id !== undefined) body.data.specId = args.spec_id;
    if (args.fields !== undefined) body.data.fields = args.fields;
    if (args.data_source !== undefined) body.data.source = args.data_source;
  }
  if (args.board_ref !== undefined) {
    // 子画板卡要带目标板名字（目标板被删后卡面还认得出指过谁）——替调用方查一次
    const detail = await api("GET", `/api/boards/${encodeURIComponent(args.board_ref)}`);
    body.boardRef = { boardId: args.board_ref, name: detail?.board?.name || args.board_ref };
  }
  if (args.raw && typeof args.raw === "object") Object.assign(body, args.raw);
  return body;
}

/* ── 工具定义 ─────────────────────────────────────── */

const CARD_TYPE_DOC =
  "text 想法 / task 任务 / link 链接 / quote 引用 / image 图片 / media 音视频 / pdf 文件 / ref 资料组 / " +
  "board 子画板 / mindmap 导图 / todo 待办 / svg 图形 / mermaid 图表 / excalidraw 自由画 / " +
  "data 规格卡 / book 图书 / html 网页嵌入（本部署实际可用哪些看 blotboard_capabilities）";

const TOOLS = [
  {
    name: "board_list",
    description:
      "画板列表 / 单板详情。不带参数 = 全部画板（id、名字、分组、卡片数）；带 board_id = 整板内容。" +
      "读整块板优先 as_markdown=true：卡片按类型分节、评论摊在对应卡片下面，最省 token；" +
      "JSON 形态给的是结构化数据（卡片 id / 几何 / 连线 / 评论），改板前拿它对照。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string", description: "画板 id（b_ 开头）；缺省 = 列出全部画板" },
        as_markdown: { type: "boolean", description: "true = 整板导成 Markdown（推荐的读板方式）" },
      },
    },
    async handler(args) {
      if (!args.board_id) {
        const data = await api("GET", "/api/boards");
        const boards = (data.boards || []).map((board) => ({
          id: board.id,
          name: board.name,
          group: board.group || "",
          parentId: board.parentId || null,
          counts: board.counts,
          updatedAt: board.updatedAt,
        }));
        return textResult({ total: boards.length, boards });
      }
      const id = encodeURIComponent(args.board_id);
      if (args.as_markdown) return textResult(await api("GET", `/api/boards/${id}/export?format=md`, { raw: true }));
      const data = await api("GET", `/api/boards/${id}`);
      const board = data.board || {};
      return textResult({ ...board, cards: (board.cards || []).map(compactCard) });
    },
  },
  {
    name: "board_create",
    description:
      "新建画板，或改已有画板（改名 / 改分组 / 挂到父板下）。带 board_id = 改；不带 = 新建。" +
      "group 是项目名（扁平一层）；parent_board_id 让它成为某板的子画板（左栏缩进，不能挂进自己的子树）。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "画板名" },
        board_id: { type: "string", description: "要修改的画板 id；缺省 = 新建" },
        parent_board_id: { type: "string", description: "父画板 id（b_ 开头）" },
        group: { type: "string", description: "分组 / 项目名；空串 = 未分组" },
      },
    },
    async handler(args) {
      if (args.board_id) {
        const body = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.group !== undefined) body.group = args.group;
        if (args.parent_board_id !== undefined) body.parentId = args.parent_board_id;
        const data = await api("PATCH", `/api/boards/${encodeURIComponent(args.board_id)}`, { body, write: true });
        return textResult({ board: summarizeBoard(data.board) });
      }
      const data = await api("POST", "/api/boards", {
        body: { name: args.name, parentId: args.parent_board_id, group: args.group },
        write: true,
      });
      return textResult({ board: summarizeBoard(data.board), deepLink: `${BASE}/?board=${data.board?.id}` });
    },
  },
  {
    name: "board_add_card",
    description:
      `建一张卡片。type：${CARD_TYPE_DOC}。红线：image/media/pdf 必须先上传（POST /api/uploads，二进制 body + x-file-name 头）拿 upload_id，` +
      "否则 400；link 的 url 必须 http(s)；html 卡只装地址且 host 要过白名单（GET /api/embed-allow）；" +
      "data 规格卡先用 board_card_specs 查字段表，别猜字段名。导图用 outline（一行一节点、2 空格一层、首行是中心主题），别手写嵌套 JSON。" +
      "agent_prompt 是绑在卡上的执行指令（转 Issue 时自动拼进正文），用户对这张卡的执行要求写这里、别塞 content。" +
      "ref/book/excalidraw 等其余专属字段走 raw 原样传。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        type: { type: "string", description: "卡片类型，默认 text" },
        title: { type: "string" },
        content: { type: "string", description: "正文（支持 Markdown）" },
        x: { type: "number" },
        y: { type: "number" },
        w: { type: "number" },
        h: { type: "number" },
        color: { type: "string", description: "amber / blue / green / violet / rose / slate" },
        agent_prompt: { type: "string", description: "卡片级 agent 指令" },
        goal: { type: "string", description: "task：任务目标" },
        priority: { type: "string", description: "task：urgent / high / medium / low / none" },
        task_status: { type: "string", description: "task：idea / issued / running / done" },
        url: { type: "string", description: "link：链接地址（http(s)）" },
        link_title: { type: "string" },
        link_desc: { type: "string" },
        quote_source: { type: "string", description: "quote：出处" },
        upload_id: { type: "string", description: "image/media/pdf：先 POST /api/uploads 拿到的 uploadId（media 收音视频，本地文件）" },
        file_name: { type: "string" },
        outline: { type: "string", description: "mindmap：缩进大纲（一行一节点、2 空格一层）" },
        mind_layout: { type: "string", description: "mindmap：right（向右）/ both（左右分叉）" },
        todo_items: { type: "array", items: {}, description: "todo：条目数组（字符串或 {text,done}）" },
        diagram: { type: "string", description: "mermaid/svg：图源码（按 type 落位）" },
        html_url: { type: "string", description: "html：被嵌页面地址" },
        frame_w: { type: "number", description: "html：逻辑视口宽（PPT 常见 1280；0 = 铺满）" },
        frame_h: { type: "number" },
        embed_mode: { type: "string", description: "html：auto（进视区即载）/ manual（点了才载）" },
        spec_id: { type: "string", description: "data：规格 id" },
        fields: { type: "object", additionalProperties: true, description: "data：按规格填的字段值" },
        data_source: {
          type: "object",
          additionalProperties: true,
          description: "data：外部出处 { app, url, externalId }（externalId 是判重主键，能带就带）",
        },
        board_ref: { type: "string", description: "board：目标子画板 id" },
        raw: { type: "object", additionalProperties: true, description: "其余专属字段，原样并入请求体" },
      },
      required: ["board_id"],
    },
    async handler(args) {
      const body = await buildCardBody(args);
      const data = await api("POST", `/api/boards/${encodeURIComponent(args.board_id)}/cards`, { body, write: true });
      return textResult({ card: data.card, deepLink: `${BASE}/?board=${args.board_id}&card=${data.card?.id}` });
    },
  },
  {
    name: "board_update_card",
    description:
      "改一张卡片（参数同 board_add_card，只传要改的）。合并语义：task/link/data.fields 是合并（只动提到的键）；" +
      "todo_items / outline / diagram 是**整体替换**——先 board_list 读出现有内容拼上再提交，" +
      "否则会把用户勾好的待办、画好的分支冲掉。传 type 可做类型互转（残留字段服务端会处理）。" +
      "别手改 task 的 issueId/taskId 账本字段。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        card_id: { type: "string" },
        type: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        w: { type: "number" },
        h: { type: "number" },
        color: { type: "string" },
        agent_prompt: { type: "string" },
        goal: { type: "string" },
        priority: { type: "string" },
        task_status: { type: "string" },
        url: { type: "string" },
        link_title: { type: "string" },
        link_desc: { type: "string" },
        quote_source: { type: "string" },
        upload_id: { type: "string" },
        file_name: { type: "string" },
        outline: { type: "string" },
        mind_layout: { type: "string" },
        todo_items: { type: "array", items: {} },
        diagram: { type: "string", description: "改 mermaid/svg 源码时必须同时给 type 指明落位" },
        html_url: { type: "string" },
        frame_w: { type: "number" },
        frame_h: { type: "number" },
        embed_mode: { type: "string" },
        spec_id: { type: "string" },
        fields: { type: "object", additionalProperties: true, description: "data：合并进现有字段；清掉某字段显式传 null" },
        data_source: { type: "object", additionalProperties: true },
        board_ref: { type: "string" },
        raw: { type: "object", additionalProperties: true },
      },
      required: ["board_id", "card_id"],
    },
    async handler(args) {
      const body = await buildCardBody(args, { forUpdate: true });
      const data = await api(
        "PATCH",
        `/api/boards/${encodeURIComponent(args.board_id)}/cards/${encodeURIComponent(args.card_id)}`,
        { body, write: true },
      );
      return textResult({ card: data.card, deepLink: `${BASE}/?board=${args.board_id}&card=${args.card_id}` });
    },
  },
  {
    name: "board_delete_card",
    description:
      "删卡片（可一次多张）。级联删掉挂在卡上的连线与批注，不可恢复——除非用户明说，删之前先问一句。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        card_ids: { type: "array", items: { type: "string" }, description: "要删的卡片 id 列表" },
      },
      required: ["board_id", "card_ids"],
    },
    async handler(args) {
      const data = await api("DELETE", `/api/boards/${encodeURIComponent(args.board_id)}/cards`, {
        body: { ids: args.card_ids },
        write: true,
      });
      return textResult({ removed: data.removed });
    },
  },
  {
    name: "board_link",
    description:
      "两张卡之间连一条线。kind 是关系语义（也决定默认配色/线型）：rel 关联（默认）/ blocks 阻塞 / " +
      "enables 前置 / references 引用（虚线）/ produces 产出。不能自环，同向重复连线返回 409。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        from: { type: "string", description: "起点卡片 id" },
        to: { type: "string", description: "终点卡片 id" },
        label: { type: "string", description: "线上的短标签" },
        kind: { type: "string", description: "rel / blocks / enables / references / produces" },
      },
      required: ["board_id", "from", "to"],
    },
    async handler(args) {
      const data = await api("POST", `/api/boards/${encodeURIComponent(args.board_id)}/edges`, {
        body: { from: args.from, to: args.to, label: args.label, kind: args.kind, createdBy: "agent" },
        write: true,
      });
      return textResult({ edge: data.edge });
    },
  },
  {
    name: "board_edge",
    description:
      "改一条连线（标签 / 语义 / 外观 / 关系强弱与标签）或删它。外观三件套 color（六色）/ style（solid|dashed|dotted）/ " +
      "width（1-3）可单独覆盖，传 null 恢复「跟随语义」。语义两件套 weight（1-5 关系强弱，**不是线宽**，" +
      "分层重排 / 子图分簇会拿它当 dagre 的 edge weight）/ tags（≤6 个短标签，传 [] 清空）。delete=true 删除。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        edge_id: { type: "string" },
        label: { type: "string" },
        kind: { type: "string" },
        color: { type: ["string", "null"] },
        style: { type: ["string", "null"] },
        width: { type: ["number", "null"] },
        weight: { type: ["number", "null"], description: "关系强弱 1-5（语义，与视觉的 width 分开）" },
        tags: { type: "array", items: { type: "string" }, description: "关系标签，≤6 个，每个 ≤20 字；传 [] 清空" },
        delete: { type: "boolean", description: "true = 删除这条连线" },
      },
      required: ["board_id", "edge_id"],
    },
    async handler(args) {
      const base = `/api/boards/${encodeURIComponent(args.board_id)}/edges/${encodeURIComponent(args.edge_id)}`;
      if (args.delete) {
        const data = await api("DELETE", base, { write: true });
        return textResult({ removed: data.removed });
      }
      const body = {};
      for (const key of ["label", "kind", "color", "style", "width", "weight", "tags"]) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      const data = await api("PATCH", base, { body, write: true });
      return textResult({ edge: data.edge });
    },
  },
  {
    name: "board_layout",
    description:
      "摆位。二选一：给 mode 让服务端整理（与用户点顶栏「整理」同一套算法）——tidy 保结构只去乱（默认、日常用）/ " +
      "flow 按连线拉成执行链 / LR、TB 分层重排 / group 按类型分区 / grid 网格铺开 / " +
      "timeline 按时间一天一列排开（规格卡的日期 → 任务卡同步时刻 → 建卡时间，取不到的进最右「未定时」区）/ " +
      "kanban 按状态分列（任务四态 → 规格里的状态 enum → 卡片类型，取不到的进末列「其他」）/ " +
      "matrix 四象限（整块板选一组二值维度：有任务卡就「重要 × 已开工」，否则规格里前两个 enum/number 字段，" +
      "都没有就「有无上游 × 有无下游」；归不了类的摆右侧「未归类」区）/ " +
      "swimlane 泳道（行 = 卡片类型、列 = 状态，列口径与 kanban 完全一致）/ " +
      "cluster 子图分簇（按连线的连通分量分簇，簇内 dagre 排一次，孤立卡聚成最后一簇）" +
      "（tidy 之外都会推翻用户布局，动前想清楚）；或给 cards 逐张指定坐标（只动给到的卡，几何之外一概不碰）。" +
      "全部模式的机器可读清单在 GET /api/capabilities 的 layouts 段。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        mode: {
          type: "string",
          description: "tidy / flow / LR / TB / group / grid / timeline / kanban / matrix / swimlane / cluster",
        },
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
              z: { type: "number" },
            },
            required: ["id"],
          },
          description: "逐张给坐标（与 mode 二选一）",
        },
      },
      required: ["board_id"],
    },
    async handler(args) {
      const id = encodeURIComponent(args.board_id);
      if (args.cards?.length) {
        const data = await api("PUT", `/api/boards/${id}/state`, { body: { cards: args.cards }, write: true });
        return textResult({ applied: data.applied, total: data.total });
      }
      if (!args.mode) throw new ToolError("mode 与 cards 至少给一个");
      const data = await api("POST", `/api/boards/${id}/tidy`, { body: { mode: args.mode }, write: true });
      return textResult({ mode: data.mode, moved: data.moved });
    },
  },
  {
    name: "board_comments",
    description:
      "评论（批注）工作流——用户在板上标「这儿要改」的主要交活通道。action：list 读评论（默认只回未解决的，" +
      "那就是待办清单）/ add 主动挂一条（拿不准该不该动手改时，评论比直接改稳妥）/ reply 回复（改完交代做了什么）/ " +
      "resolve 标解决。按评论干完活要 reply + resolve 双步：只改不回用户看不出动过哪条，只回不结会一直挂在待处理里；" +
      "拿不准就只 reply 不 resolve，把决定权留给用户。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        action: { type: "string", description: "list（默认）/ add / reply / resolve" },
        status: { type: "string", description: "list：open（默认）/ resolved / all" },
        target: { type: "string", description: "list 收窄或 add 指定：card / edge / board" },
        target_id: { type: "string", description: "卡片或连线 id（add 时 target=board 可不带）" },
        comment_id: { type: "string", description: "reply / resolve 的目标评论 id（cm_ 开头）" },
        text: { type: "string", description: "add / reply 的正文" },
        x: { type: "number", description: "add + target=board：钉在画布这个点" },
        y: { type: "number" },
      },
      required: ["board_id"],
    },
    async handler(args) {
      const id = encodeURIComponent(args.board_id);
      const action = args.action || "list";
      if (action === "list") {
        const query = new URLSearchParams();
        if (args.status) query.set("status", args.status);
        if (args.target) query.set("target", args.target);
        if (args.target_id) query.set("targetId", args.target_id);
        const qs = query.toString();
        const data = await api("GET", `/api/boards/${id}/comments${qs ? `?${qs}` : ""}`);
        return textResult({ total: data.total, comments: data.comments });
      }
      if (action === "add") {
        if (!args.text) throw new ToolError("add 需要 text");
        const target = args.target || (args.target_id?.startsWith("e_") ? "edge" : args.target_id ? "card" : "board");
        const data = await api("POST", `/api/boards/${id}/comments`, {
          body: { target, targetId: args.target_id ?? null, text: args.text, x: args.x, y: args.y, createdBy: "agent" },
          write: true,
        });
        return textResult({ comment: data.comment });
      }
      if (!args.comment_id) throw new ToolError(`${action} 需要 comment_id`);
      const cid = encodeURIComponent(args.comment_id);
      if (action === "reply") {
        if (!args.text) throw new ToolError("reply 需要 text");
        const data = await api("POST", `/api/boards/${id}/comments/${cid}/replies`, {
          body: { text: args.text, createdBy: "agent" },
          write: true,
        });
        return textResult({ comment: data.comment });
      }
      if (action === "resolve") {
        const data = await api("PATCH", `/api/boards/${id}/comments/${cid}`, { body: { resolved: true }, write: true });
        return textResult({ comment: data.comment });
      }
      throw new ToolError(`未知 action「${action}」：list / add / reply / resolve`);
    },
  },
  {
    name: "board_card_specs",
    description:
      "卡片规格（外部结构化卡片的说明书）。不带参数 = 规格清单（id / 名字 / 开关状态）；" +
      "带 spec_id = 该规格的字段表（哪些必填、什么类型、示例）。建 data 规格卡 / 拼信封之前先来这查，" +
      "别猜字段名——规格外的 key 会被丢掉，必填缺了信封整批拒收。",
    inputSchema: {
      type: "object",
      properties: { spec_id: { type: "string", description: "规格 id（kebab-case）" } },
    },
    async handler(args) {
      if (!args.spec_id) {
        const data = await api("GET", "/api/card-specs");
        const specs = (data.specs || []).map((spec) => ({
          id: spec.id,
          name: spec.name,
          category: spec.category,
          enabled: spec.enabled,
          description: spec.description,
        }));
        return textResult({ total: specs.length, specs });
      }
      const data = await api("GET", `/api/card-specs/${encodeURIComponent(args.spec_id)}`);
      return textResult(`${data.prompt || JSON.stringify(data.spec, null, 2)}\n\n启用状态：${data.enabled ? "启用" : "已停用（收不了新卡）"}`);
    },
  },
  {
    name: "board_ingest_cards",
    description:
      "一次送一批结构化卡片（卡片信封）落板，支持内部连线与判重。cards 每项：规格卡给 { spec, fields, source? }，" +
      "原生卡给 { type, title, content… }（信封只收 text/task/quote/link/todo/mindmap/svg/mermaid）。" +
      "拿不准就先 dry_run=true 干跑校验（不落库）。mode=strict（默认）一张坏卡整批拒；lenient 跳过坏卡。" +
      "同一条外部记录带 source.externalId 再送默认是更新而不是重复建卡——能带就带。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string", description: "落到哪块板（dry_run 时可省）" },
        cards: { type: "array", items: { type: "object", additionalProperties: true }, description: "信封里的卡片数组" },
        edges: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "内部连线：{ from, to, label?, kind? }，from/to 用 cards 里的本地 id 或板上已有的 c_ id",
        },
        mode: { type: "string", description: "strict（默认）/ lenient" },
        on_duplicate: { type: "string", description: "update（默认）/ skip / create" },
        dry_run: { type: "boolean", description: "true = 只校验不落库" },
      },
      required: ["cards"],
    },
    async handler(args) {
      const envelope = {
        format: "blotboard.cards",
        version: 1,
        generator: `blotboard-mcp/${pkg.version}`,
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.on_duplicate ? { onDuplicate: args.on_duplicate } : {}),
        cards: args.cards,
        ...(args.edges ? { edges: args.edges } : {}),
      };
      if (args.dry_run) {
        const data = await api("POST", "/api/card-specs/validate", { body: envelope });
        return textResult(data);
      }
      if (!args.board_id) throw new ToolError("落板需要 board_id（只想校验就加 dry_run=true）");
      const data = await api("POST", `/api/boards/${encodeURIComponent(args.board_id)}/ingest`, {
        body: envelope,
        write: true,
      });
      return textResult(data);
    },
  },
  {
    name: "board_checkpoints",
    description:
      "改板安全网：自动快照的清单与回滚。**大改之前不用手动打点**——服务端在每个批量写入口" +
      "（整板 whole / 信封 ingest / 粘贴 paste / 服务端 tidy / 批量改删 / 插入模板）动手前自动照一张相，" +
      "每块板留最近 N 份（默认 10，超出删最旧）。改砸了两条路：让用户在画板顶栏「历史」里点回滚，" +
      "或你自己 action=restore 指定一份快照。restore 会**覆盖当前的卡片 / 连线 / 批注**（板名与分组不动），" +
      "并且在覆盖前自动再打一份点，所以回滚本身也有回头路。" +
      "action=activity 读这块板最近的批量改动记录（谁、什么时候、用哪个入口改的、对应哪份快照）。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        action: { type: "string", description: "list（默认）/ restore / delete / activity" },
        stamp: { type: "string", description: "restore / delete 要操作的那份快照 id（list 里的 stamp）" },
      },
      required: ["board_id"],
    },
    async handler(args) {
      const id = encodeURIComponent(args.board_id);
      const action = args.action || "list";
      if (action === "activity") {
        const data = await api("GET", `/api/boards/${id}/activity`);
        return textResult({ total: data.total, activity: data.activity });
      }
      if (action === "list") {
        const data = await api("GET", `/api/boards/${id}/checkpoints`);
        return textResult({
          enabled: data.enabled,
          keep: data.keep,
          total: (data.checkpoints || []).length,
          checkpoints: data.checkpoints,
          ...(data.enabled
            ? {}
            : { note: "这台部署把自动快照关掉了（BLOTBOARD_CHECKPOINT_KEEP=0）：大改前自己先 board_export format=json 留一份" }),
        });
      }
      if (!args.stamp) throw new ToolError(`action=${action} 要给 stamp（先 action=list 看有哪些）`);
      const stamp = encodeURIComponent(args.stamp);
      if (action === "delete") {
        const data = await api("DELETE", `/api/boards/${id}/checkpoints/${stamp}`, { write: true });
        return textResult({ removed: data.removed });
      }
      if (action !== "restore") throw new ToolError(`未知 action：${action}（可选 list / restore / delete / activity）`);
      const data = await api("POST", `/api/boards/${id}/checkpoints/${stamp}/restore`, { write: true });
      return textResult({
        restored: data.restored,
        // 回滚前那一刻的板也存下来了：万一是回滚错了，用这个 stamp 再回滚一次就退回去了
        undoCheckpoint: data.checkpoint,
        board: summarizeBoard(data.board),
      });
    },
  },
  {
    name: "board_export",
    description:
      "导出整块画板。format：md 给人看 / 贴上下文（同 board_list as_markdown）；json 内部结构（含几何与 id，" +
      "改完可 PUT /api/boards/{id}/whole 回去——whole 必须先 GET 最新再改再 PUT，别拿旧快照覆盖）；" +
      "cards 卡片信封（交换格式，可原样 POST 到另一台画板的 /ingest）；" +
      "bundle 画板包（板 + 卡 + 线 + 评论 + 附件字节，board_import 收它——备份 / 迁移 / 分享走这个）。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string", description: "format=bundle 时可换成 group 或 all=true，三选一必须明确给一个" },
        format: { type: "string", description: "md / json / cards / bundle" },
        only_data: { type: "boolean", description: "format=cards 时只导规格卡" },
        group: { type: "string", description: "format=bundle：导整个分组（与 board_id / all 三选一）" },
        all: { type: "boolean", description: "format=bundle：**只有显式 true 才导整个库**；false / 不给都不算选了范围" },
        with_assets: { type: "boolean", description: "format=bundle：带上附件字节（默认带）" },
        plan: { type: "boolean", description: "format=bundle：只看分卷计划（几卷、每卷多少块），不打包" },
        volume: { type: "number", description: "format=bundle：取第 N 卷（1 起）。一份装不下时按计划逐卷取，每卷都是完整可导入的包" },
      },
    },
    async handler(args) {
      const format = args.format || "md";
      if (format === "bundle") {
        /**
         * 范围必须**明确选一个**。这里曾经是「没给 id 也没给 group 就 all=1」，
         * 于是显式写了 `all: false` 的调用照样把整个库导出来——参数说的是「别导全库」，
         * 干的是「导全库」，而返回的还是成功。少打一个 board_id 就整库出走，
         * 这种默认值不该存在。
         */
        const scopes = [
          args.board_id ? "board_id" : null,
          args.group !== undefined && args.group !== null ? "group" : null,
          args.all === true ? "all" : null,
        ].filter(Boolean);
        if (scopes.length === 0) {
          throw new ToolError(
            "format=bundle 要明确给导出范围，三选一：board_id=<b_xxx> 单块板（连同子板）/ group=<分组名> 整个分组 / all=true 整个库。" +
              (args.all === false ? "（收到的是 all=false——那不是「导全库」的意思，也不能当成没给。）" : "") +
              " 不知道有哪些板就先 board_list。",
          );
        }
        if (scopes.length > 1) {
          throw new ToolError(`导出范围只能给一个，收到 ${scopes.join(" + ")}。要么按板、要么按分组、要么整库。`);
        }
        const params = new URLSearchParams({ format: "json" });
        if (args.board_id) params.set("ids", args.board_id);
        else if (scopes[0] === "group") params.set("group", args.group);
        else params.set("all", "1");
        if (args.with_assets === false) params.set("assets", "0");
        /**
         * 分卷：服务端的挑板不再截断，一份装不下就回 413 附计划（见 app/api/boards/export/route.ts）。
         * 那份计划说的是「加 volume=N 再取一次」——所以这两个参数必须在 MCP 这层也能给，
         * 否则 agent 收到的是一句自己执行不了的指路（库一超过上限，整库导出就等于死路）。
         */
        if (args.plan === true) params.set("plan", "1");
        if (args.volume !== undefined && args.volume !== null) params.set("volume", String(args.volume));
        const path = `/api/boards/export?${params}`;
        let data;
        try {
          data = await api("GET", path);
        } catch (err) {
          // 413 = 装不下。把服务端那份计划翻译成 MCP 这边的下一步动作，别让它停在 HTTP 语义上。
          if (err instanceof ToolError && err.status === 413 && err.plan) {
            const { total, limit, volumes } = err.plan;
            throw new ToolError(
              `这次要导 ${total} 块画板，超过单份包的上限（${limit} 块），一份装不下——不给半份。\n` +
                `分 ${volumes} 卷取：把同样的参数再调一次，加上 volume=1 … volume=${volumes}，` +
                "每一卷都是完整可导入的包，逐卷交给 board_import 即可还原整套。\n" +
                "只想先看计划不打包：同样的参数加 plan=true。",
              413,
            );
          }
          throw err;
        }
        if (args.plan === true) {
          return machineResult(data.plan, {
            what: "这份分卷计划",
            download: `${BASE}${path}`,
            narrow: [],
          });
        }
        const volumeNote = data.bundle?.volume
          ? `、第 ${data.bundle.volume.index}/${data.bundle.volume.total} 卷（整套共 ${data.bundle.volume.totalBoards} 块）`
          : "";
        return machineResult(data.bundle, {
          what: `这份画板包（${(data.bundle?.boards || []).length} 块板${args.with_assets === false ? "、不含附件" : "、含附件字节"}${volumeNote}）`,
          download: `${BASE}${path}&download=1`,
          narrow: [
            ...(args.with_assets === false ? [] : ["with_assets=false —— 附件字节通常就是大头，去掉后结构还是完整的"]),
            ...(args.board_id ? [] : ["board_id=<b_xxx> 一块一块导，逐块 board_import 过去"]),
            ...(args.volume === undefined ? ["plan=true 先看分卷计划，再按 volume=N 逐卷取"] : []),
          ],
        });
      }
      if (!args.board_id) throw new ToolError("board_id 必填（只有 format=bundle 能按 group / all 导一批）");
      const id = encodeURIComponent(args.board_id);
      if (format === "md") return textResult(await api("GET", `/api/boards/${id}/export?format=md`, { raw: true }));
      if (format === "cards") {
        const path = `/api/boards/${id}/export?format=cards${args.only_data ? "&only=data" : ""}`;
        const data = await api("GET", path);
        return machineResult(data.envelope, {
          what: "这份卡片信封",
          download: `${BASE}${path}`,
          unwrap: '这个口的响应是 {"ok":true,"envelope":{…}}，取 envelope 那一段再 POST 到 /api/boards/{id}/ingest',
          narrow: ["only_data=true 只导规格卡", "或改用 format=bundle + HTTP 下载整块板"],
        });
      }
      const path = `/api/boards/${id}/export?format=json`;
      const data = await api("GET", path);
      return machineResult(data.board, {
        what: "这块板的整板 JSON",
        download: `${BASE}${path}`,
        unwrap: '这个口的响应是 {"ok":true,"board":{…}}，取 board 那一段；改完 PUT 回 /api/boards/{id}/whole',
        narrow: ["只是想看看内容就用 format=md（给人读的，导不回来）", "要备份 / 迁移用 format=bundle"],
      });
    },
  },
  {
    name: "board_import",
    description:
      "收一份导出文件，在这台画板上立成新板。content 直接放文件原文：画板包 JSON、单块板 JSON" +
      "（board_export format=json 的产物）、或**排版导出的 HTML**（末尾带着同一份数据）都认。" +
      "mode=copy（默认）一律新建、不动已有的板，任务卡不继承来源机器的 Issue；" +
      "mode=restore 保住原 id 用来恢复备份，撞上同 id 默认跳过，要覆盖传 on_conflict=replace。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "导出文件的原文（JSON 或 HTML）" },
        mode: { type: "string", description: "copy（默认）/ restore" },
        on_conflict: { type: "string", description: "restore 撞同 id：skip（默认）/ replace / copy" },
        group: { type: "string", description: "把导进来的板统一归到这个分组" },
      },
      required: ["content"],
    },
    async handler(args) {
      const params = new URLSearchParams();
      if (args.mode) params.set("mode", args.mode);
      if (args.on_conflict) params.set("onConflict", args.on_conflict);
      if (args.group !== undefined) params.set("group", args.group);
      const query = params.toString();
      const data = await api("POST", `/api/boards/import${query ? `?${query}` : ""}`, { rawBody: args.content });
      return textResult({
        imported: data.imported,
        skipped: data.skipped,
        assets: data.assets,
        notes: data.notes,
      });
    },
  },
  {
    name: "board_to_issue",
    description:
      "任务卡「转 Issue」：把卡片正文 + 画板上下文（沿连线取上下游）+ 未解决评论 + 卡片 agent_prompt 拼成一条工作项，" +
      "登记到当前任务后端（local = 画板自己的 issues.json；goal-agent / http = 外部 Runner）。幂等：已转过直接返回现状。" +
      "context_mode 单次覆盖上下文策略：neighbors（默认，一跳上下游）/ upstream / downstream / all / none。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        card_id: { type: "string", description: "必须是 task 类型的卡" },
        context_mode: { type: "string", description: "neighbors / upstream / downstream / all / none" },
        context_types: { type: "array", items: { type: "string" }, description: "只带这些类型的上下文卡片；空 = 不限" },
      },
      required: ["board_id", "card_id"],
    },
    async handler(args) {
      const body = {};
      if (args.context_mode || args.context_types) {
        body.context = { ...(args.context_mode ? { mode: args.context_mode } : {}), ...(args.context_types ? { types: args.context_types } : {}) };
      }
      const data = await api(
        "POST",
        `/api/boards/${encodeURIComponent(args.board_id)}/cards/${encodeURIComponent(args.card_id)}/issue`,
        { body, write: true },
      );
      return textResult(data);
    },
  },
  {
    name: "board_launch",
    description:
      "对已转 Issue 的任务卡发起执行。mode：implement 动手实现（默认）/ analyze 只分析不改。" +
      "local 后端两种玩法：不带 agent_id = 生成完整 prompt（含深链与回写指引）挂成待派 run，谁复制走谁执行；" +
      "带 agent_id = 真拉起 Runner 设置里注册的那个 ACP agent 子进程跑（agent 清单看 GET /api/runner-settings）。" +
      "远程后端（goal-agent / http）下 agent_id 被忽略，由对端派单。同一 Issue 同时只允许一个在跑的 run（并发 409）。",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        card_id: { type: "string" },
        mode: { type: "string", description: "implement（默认）/ analyze" },
        agent_id: { type: "string", description: "local 后端：Runner 设置里注册的 ACP agent id" },
      },
      required: ["board_id", "card_id"],
    },
    async handler(args) {
      const data = await api(
        "POST",
        `/api/boards/${encodeURIComponent(args.board_id)}/cards/${encodeURIComponent(args.card_id)}/launch`,
        { body: { mode: args.mode, ...(args.agent_id ? { agentId: args.agent_id } : {}) }, write: true },
      );
      return textResult({ ...data, tasksLink: `${BASE}/tasks?board=${args.board_id}` });
    },
  },
  {
    name: "board_tasks",
    description:
      "任务 / Issue 状态。issue_id = 单条 Issue 详情（含 runs、日志、完整 prompt；仅 local 后端）；" +
      "board_id = 该板任务卡的实时执行状态；都不带 = 任务全景（local 后端给 Issue 列表与镜头计数，" +
      "外部 Runner 后端给跨画板任务卡清单）。status 收镜头：pending / in_progress / attention（等我处理）/ done / aborted / all。",
    inputSchema: {
      type: "object",
      properties: {
        issue_id: { type: "string", description: "Issue id（i_ 开头，local 后端）" },
        board_id: { type: "string" },
        status: { type: "string", description: "Issue 列表镜头（local 后端）" },
        q: { type: "string", description: "Issue 列表关键词（local 后端）" },
      },
    },
    async handler(args) {
      if (args.issue_id) {
        const data = await api("GET", `/api/issues/${encodeURIComponent(args.issue_id)}`);
        return textResult(data);
      }
      if (args.board_id) {
        const data = await api("GET", `/api/boards/${encodeURIComponent(args.board_id)}/task-status`);
        return textResult(data);
      }
      const query = new URLSearchParams();
      if (args.status) query.set("status", args.status);
      if (args.q) query.set("q", args.q);
      try {
        const data = await api("GET", `/api/issues${query.toString() ? `?${query}` : ""}`);
        return textResult({ backend: data.backend, counts: data.counts, total: data.total, issues: data.issues });
      } catch (err) {
        // 配了外部 Runner 时 /api/issues 是 501（真源在 Runner）：退回跨画板任务卡清单
        if (!(err instanceof ToolError) || !err.message.includes("501")) throw err;
        const data = await api("GET", "/api/boards/tasks");
        const tasks = (data.tasks || []).map((item) => ({
          boardId: item.boardId,
          boardName: item.boardName,
          cardId: item.card?.id,
          title: item.card?.title,
          task: item.card?.task,
        }));
        return textResult({ backend: "remote-runner", total: data.total, tasks });
      }
    },
  },
  {
    name: "blotboard_capabilities",
    description:
      "探这台画板的能力：版本、开了哪些可选集成（features）、任务后端种类（tasks.backend 决定转 Issue 落在哪）、" +
      "全部卡片包的开关（cards）、启用的规格、信封格式、整理模式清单（layouts）与 mermaid 的服务端渲染边界。接手一台不熟的部署先调它；" +
      "更完整的实操指南在 GET {BASE}/api/skill?format=md（按本部署实际启用内容现场拼装，" +
      "只要其中一类活就加 ?focus=cards|specs|tasks|… ，合法值见 capabilities 的 skillFocus）。",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const data = await api("GET", "/api/capabilities");
      return textResult({
        ...data,
        connection: {
          base: BASE,
          write: TOKEN ? `可写（token 来源：${TOKEN_SOURCE}）` : `只读——${READONLY_HINT}`,
          skillGuide: `${BASE}/api/skill?format=md`,
          // 只要某一类活时省上下文：?focus=cards / specs / tasks …（合法值在上面的 skillFocus 段）
          skillGuideFocused: `${BASE}/api/skill?format=md&focus=cards`,
        },
      });
    },
  },
];

function summarizeBoard(board) {
  if (!board) return board;
  const { cards, edges, comments, ...rest } = board;
  return rest;
}

/* ── 工具提示（MCP annotations） ───────────────────────
   给客户端一个「这个工具大概会干什么」的展示依据：只读的可以放心自动调、
   会覆盖或删数据的该提醒用户、幂等的重试无妨、要跑到外部 Runner 上的另算一类。

   **这不是权限校验**：annotations 是提示，真正的闸门在画板那边（x-auth-key、
   停用的卡片包、并发 409、快照）。别因为标了 readOnly 就省掉服务端的检查，
   也别因为标了 destructive 就以为客户端一定会拦住。 */
const ANNOTATIONS = {
  board_list: { title: "读画板", readOnlyHint: true },
  board_create: { title: "新建画板" },
  board_add_card: { title: "加卡片" },
  // 改 / 删这类会盖掉或抹掉已有内容：destructive。同样的参数打第二次结果一样，所以是幂等的
  board_update_card: { title: "改卡片", destructiveHint: true, idempotentHint: true },
  board_delete_card: { title: "删卡片", destructiveHint: true, idempotentHint: true },
  board_link: { title: "连线" },
  board_edge: { title: "改 / 删连线", destructiveHint: true, idempotentHint: true },
  // 整理会推翻整块板的坐标（tidy 之外的模式尤其），算 destructive；每次按当前内容重算，不标幂等
  board_layout: { title: "整理布局", destructiveHint: true },
  board_comments: { title: "评论", destructiveHint: true },
  board_card_specs: { title: "看卡片规格", readOnlyHint: true },
  // 信封是纯追加：不动已有的卡
  board_ingest_cards: { title: "批量收卡（信封）" },
  board_checkpoints: { title: "快照与回滚", destructiveHint: true },
  board_export: { title: "导出画板", readOnlyHint: true },
  // restore + on_conflict=replace 会覆盖同 id 的板
  board_import: { title: "导入画板", destructiveHint: true },
  // 转 Issue 明确幂等（转过就返回现状）；落到哪儿取决于任务后端，可能是外部 Runner
  board_to_issue: { title: "任务卡转 Issue", idempotentHint: true, openWorldHint: true },
  board_launch: { title: "发起任务执行", openWorldHint: true },
  board_tasks: { title: "看任务 / Issue", readOnlyHint: true, openWorldHint: true },
  blotboard_capabilities: { title: "探这台画板的能力", readOnlyHint: true },
};

/** 补全默认值：只读的天然不 destructive；没标 openWorld 的都是「就这一台画板」这个闭域。 */
function annotationsFor(name) {
  const base = ANNOTATIONS[name] || {};
  const readOnlyHint = base.readOnlyHint === true;
  return {
    title: base.title || name,
    readOnlyHint,
    destructiveHint: readOnlyHint ? false : base.destructiveHint === true,
    idempotentHint: readOnlyHint ? true : base.idempotentHint === true,
    openWorldHint: base.openWorldHint === true,
  };
}

/* ── 服务器装配 ───────────────────────────────────── */

export async function main() {
  const server = new Server(
    { name: "blotboard", version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
      annotations: annotationsFor(name),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((entry) => entry.name === request.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `未知工具：${request.params.name}` }], isError: true };
    }
    try {
      return await tool.handler(request.params.arguments || {});
    } catch (err) {
      // 已知错误（HTTP 报错 / 参数指路）原样给 agent；未知异常也别让整个 server 挂掉
      const message = err instanceof ToolError ? err.message : "工具执行异常，请检查参数与服务状态";
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[blotboard-mcp] v${pkg.version} 已就绪 → ${BASE}（${TOKEN ? `可写，token 来源：${TOKEN_SOURCE}` : "只读模式"}）`,
  );
}
