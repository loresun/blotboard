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
 *
 * 线格式与真 agent 一致：newline-delimited JSON-RPC 2.0 over stdio。
 */
import process from "node:process";

const args = process.argv.slice(2);
const mode = (() => {
  const index = args.indexOf("--mode");
  return index >= 0 ? args[index + 1] : "auto-finish";
})();

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

async function handlePrompt(id, params) {
  const sessionId = params?.sessionId || "";
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
