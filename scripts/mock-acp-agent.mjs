#!/usr/bin/env node
/**
 * mock ACP agent（纯 Node 零依赖）：smoke / 手工调试用的协议对手方。
 *
 * 实现 agent 侧最小面：initialize 应答、session/new、收 session/prompt 后
 * 流式发几条 session/update（agent 消息块 + 一条 plan），按 --mode 决定后续：
 *
 *   --mode auto-finish      直接把话说完 → end_turn（默认）
 *   --mode need-permission  发一条 session/request_permission（两个选项），
 *                           allow → 继续说完 end_turn；reject → refusal
 *   --mode hang             说一句就挂住不回 prompt 响应——专测 cancel 链路：
 *                           收到 session/cancel 才以 stopReason=cancelled 收束
 *   --mode echo-env         读画板注入的 BLOTBOARD_API_BASE / BLOTBOARD_INTERNAL_TOKEN，
 *                           真的发一次 PATCH 把 run 回写成 completed（env 注入的闭环验证）
 *   --mode auth-required    对 session/prompt 回协议错误 -32000（auth_required）
 *   --mode crash            往 stderr 打一行带本机路径的错误后 exit 1（stderr 摘要的素材）
 *
 * 线格式与真 agent 一致：newline-delimited JSON-RPC 2.0 over stdio。
 */
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const mode = (() => {
  const index = args.indexOf("--mode");
  return index >= 0 ? args[index + 1] : "auto-finish";
})();

if (mode === "crash") {
  // 故意把「本机绝对路径 + 注入的 token」一起打进 stderr：真 agent 起不来时就是这么报的
  //（CLI 报错里回显环境值是常态）。画板收尾时该给的是脱敏摘要，而不是把这些原样转述给看板的人
  const missing = path.join(process.cwd(), "不存在的模块.mjs");
  // MOCK_LONG_ENV_VALUE 来自注册表的 agent.env：检测通道（probe）不注入内部 token，
  // 靠它才能验证「注册表 env 里够长的值也一样被当密钥抹掉」
  const secret = process.env.MOCK_LONG_ENV_VALUE ? ` MOCK_LONG_ENV_VALUE=${process.env.MOCK_LONG_ENV_VALUE}` : "";
  console.error(
    `mock-acp-agent 启动失败：Cannot find module '${missing}'（BLOTBOARD_INTERNAL_TOKEN=${process.env.BLOTBOARD_INTERNAL_TOKEN || "未设置"}）${secret}`,
  );
  process.exit(1);
}

let buffer = "";
let sessionCounter = 0;
/** hang 模式挂着的 prompt 请求 id（等 session/cancel 来收） */
let hangingPromptId = null;
let cancelled = false;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nextOutId = 1000;
const pendingOut = new Map();
/** agent → 客户端的请求（request_permission 用） */
function request(method, params) {
  const id = nextOutId++;
  return new Promise((resolve) => {
    pendingOut.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function chunk(sessionId, text) {
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

/** prompt 正文（文本块拼起来）：echo-env 要从画板生成的回写指令里解析出 run 端点 */
function promptText(params) {
  return (Array.isArray(params?.prompt) ? params.prompt : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block?.text || ""))
    .join("\n");
}

/**
 * 只信 env 里注入的 BLOTBOARD_API_BASE / BLOTBOARD_INTERNAL_TOKEN（这正是画板该给的），
 * 拿它们真发一次 PATCH。哪一环断了就把断点说进对话——smoke 断言的是 run 的 note，
 * 所以画板侧注入一断，用例立刻红，而不是静默绿着过去。
 *
 * **对话块必须发在 PATCH 之前**：回写成 completed 会让画板当场收尾并杀掉本进程
 * （run 转终态 = 会话结束，设计决策 §3），之后再发的 session/update 是否还来得及被读到
 * 纯看调度——先说话再回写，断言才有确定性。PATCH 之后那句是锦上添花，丢了也不影响用例。
 */
async function echoEnv(sessionId, text) {
  const base = String(process.env.BLOTBOARD_API_BASE || "").replace(/\/+$/, "");
  const token = process.env.BLOTBOARD_INTERNAL_TOKEN || "";
  const match = /\/api\/issues\/([A-Za-z0-9_-]+)\/runs\/([A-Za-z0-9_-]+)/.exec(text);
  chunk(
    sessionId,
    `echo-env：BLOTBOARD_API_BASE=${base ? "有" : "无"} BLOTBOARD_INTERNAL_TOKEN=${token ? "有" : "无"} 回写端点=${match ? "有" : "无"}`,
  );
  if (!base || !token || !match) return;
  const response = await fetch(`${base}/api/issues/${match[1]}/runs/${match[2]}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-auth-key": token },
    body: JSON.stringify({
      status: "completed",
      note: "echo-env 闭环：env 注入的 BLOTBOARD_API_BASE + BLOTBOARD_INTERNAL_TOKEN 都可用，已用它们回写",
    }),
  });
  if (!response.ok) chunk(sessionId, `echo-env 回写被拒（HTTP ${response.status}）：env 注入没打通。`);
}

async function handlePrompt(id, params) {
  const sessionId = params?.sessionId || "";

  if (mode === "echo-env") {
    await echoEnv(sessionId, promptText(params));
    reply(id, { stopReason: "end_turn" });
    return;
  }

  if (mode === "auth-required") {
    // 模拟「agent 缺 API key」：各家约定俗成回 -32000（auth_required）
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required: missing API key" } });
    return;
  }

  chunk(sessionId, "收到任务，先看一眼需求。");
  await sleep(20);
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "plan",
      entries: [
        { content: "读需求", priority: "high", status: "completed" },
        { content: "动手干活", priority: "high", status: "in_progress" },
      ],
    },
  });
  await sleep(20);

  if (mode === "hang") {
    chunk(sessionId, "开始一个很长的操作……");
    hangingPromptId = id; // 挂住：等 session/cancel
    return;
  }

  if (mode === "need-permission") {
    const response = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "tc_1", title: "在工作目录里写一个文件", kind: "edit", status: "pending" },
      options: [
        { optionId: "allow", name: "允许这一次", kind: "allow_once" },
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
      ],
    });
    const outcome = response?.outcome;
    if (cancelled || outcome?.outcome === "cancelled") {
      reply(id, { stopReason: "cancelled" });
      return;
    }
    if (outcome?.outcome === "selected" && outcome.optionId === "allow") {
      await sleep(20);
      chunk(sessionId, "获准继续，写完了。");
      reply(id, { stopReason: "end_turn" });
    } else {
      chunk(sessionId, "被拒绝了，收工。");
      reply(id, { stopReason: "refusal" });
    }
    return;
  }

  // auto-finish
  await sleep(20);
  chunk(sessionId, "干完了：一切顺利。");
  reply(id, { stopReason: "end_turn" });
}

function dispatch(message) {
  // 客户端对我们 request_permission 的响应
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingOut.get(message.id);
    if (resolve) {
      pendingOut.delete(message.id);
      resolve(message.result);
    }
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      reply(id, { protocolVersion: params?.protocolVersion ?? 1, agentCapabilities: { loadSession: false } });
      return;
    case "session/new":
      sessionCounter += 1;
      reply(id, { sessionId: `mock_sess_${sessionCounter}` });
      return;
    case "session/prompt":
      void handlePrompt(id, params);
      return;
    case "session/cancel":
      cancelled = true;
      if (hangingPromptId !== null) {
        reply(hangingPromptId, { stopReason: "cancelled" });
        hangingPromptId = null;
      }
      return;
    default:
      if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buffer += data;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      dispatch(JSON.parse(line));
    } catch {
      /* 非 JSON 行：忽略 */
    }
  }
});
// stdin 关了就退出（客户端收尾时先关 stdin 再升级信号——这是体面退出那条路）
process.stdin.on("end", () => process.exit(0));
