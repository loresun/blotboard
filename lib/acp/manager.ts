/**
 * ACP（Agent Client Protocol）会话管理：local 任务后端「真拉起 agent」的那一半。
 *
 * 一次 acp run = 一个 agent 子进程 + 一条 ACP 会话 + 一个 prompt 轮次：
 *   spawn → initialize → session/new → session/prompt →（流式 session/update 落 transcript、
 *   session/request_permission 按档位处理）→ stopReason 定终态 → 收尾杀进程。
 *
 * 内存表（runId → 会话）挂在 globalThis 上——Next 生产构建里每条路由是独立 bundle，
 * 模块级单例在路由之间**不是**同一份，globalThis 才是进程级真源。
 * 服务重启后内存表自然清空：sweepLostRuns 把「状态还在跑但表里没有」的 run
 * 一律标 aborted（transcript 与日志都记「服务重启，会话丢失」），这是挂起权限
 * resolver 丢失场景的统一兜底。
 *
 * 安全边界：spawn 只发生在显式 launch（人点按钮 / 带鉴权的 API 调用），
 * 命令与参数只来自 runner-settings 注册表——**绝不执行来自卡片内容的指令**。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { ACP_WORKSPACE_DIR } from "../config";
import { badRequest, conflict, notFound } from "../http";
import * as issues from "../issue-store";
import type { AcpAgentConfig, PermissionMode } from "../runner-settings";
import { JsonRpcPeer, RpcRemoteError } from "./jsonrpc";
import { appendTranscript } from "./transcript";

interface PendingPermission {
  options: { optionId: string; name: string; kind: string }[];
  resolve: (result: unknown) => void;
}

interface AcpSession {
  runId: string;
  issueId: string;
  agent: { id: string; name: string };
  permissionMode: PermissionMode;
  cwd: string;
  child: ChildProcess;
  peer: JsonRpcPeer;
  sessionId: string | null;
  pending: PendingPermission | null;
  /** 终态已定（谁先到谁定）：后续的 exit / stopReason 只做清理不再改状态 */
  done: boolean;
  timers: NodeJS.Timeout[];
}

interface AcpGlobalState {
  sessions: Map<string, AcpSession>;
  swept: boolean;
  exitHooked: boolean;
}

/** 进程级单例（见文件头注释：模块级在 Next 的分 bundle 下靠不住） */
function globalState(): AcpGlobalState {
  const g = globalThis as any;
  if (!g.__blotboardAcpState) g.__blotboardAcpState = { sessions: new Map(), swept: false, exitHooked: false };
  return g.__blotboardAcpState as AcpGlobalState;
}

const INIT_TIMEOUT_MS = 30_000;
/** cancel 通知发出后给 agent 的体面退出窗口，之后 SIGTERM（设计决策 §3） */
const CANCEL_GRACE_MS = 5_000;
const TERM_TO_KILL_MS = 3_000;

/* ── 启动兜底：内存表空但状态还在跑的 run 一律标中止 ── */

/**
 * 服务重启后第一次有人碰 Issue 数据时跑一遍（进程内只跑一次）。
 * 不放在 server.mjs：那是 .mjs 进不来 TS 模块，而且懒扫在第一个读到脏状态的
 * 请求之前执行，效果等价。
 */
export function ensureStartupSweep(): void {
  const state = globalState();
  if (state.swept) return;
  state.swept = true;
  for (const issue of issues.listIssues()) {
    for (const run of issue.runs || []) {
      if (run.kind !== "acp") continue;
      if (run.status !== "running" && run.status !== "waiting") continue;
      if (state.sessions.has(run.id)) continue;
      appendTranscript(run.id, { type: "status", status: "aborted", detail: "服务重启，会话丢失" });
      try {
        issues.setRunPermissionRequest(issue.id, run.id, null);
        issues.patchRun(issue.id, run.id, { status: "aborted", note: "服务重启，会话丢失——请重新发起" });
      } catch (err) {
        console.error(`[acp] 重启兜底失败（${run.id}）：${String((err as Error)?.message || err)}`);
      }
    }
  }
}

/* ── 发起 ─────────────────────────────────────────── */

export interface StartAcpRunInput {
  issueId: string;
  agent: AcpAgentConfig;
  permissionMode: PermissionMode;
  mode: "implement" | "analyze";
  /** run 的完整 prompt（阶段 C 生成的那份：正文 + 深链 + HTTP 回写指引——双通道不冲突） */
  prompt: (issue: issues.LocalIssue, runId: string) => string;
}

/**
 * 发起一次 acp run：并发闸 → 落 run → spawn → 异步驱动协议流程。
 * 返回时子进程已拉起（或已把 run 标成 failed）；协议往返在后台继续。
 */
export function startAcpRun(input: StartAcpRunInput): issues.LocalIssueRun {
  ensureStartupSweep();
  const state = globalState();
  const issue = issues.requireIssue(input.issueId);
  const active = issues.activeRunOf(issue);
  if (active) {
    throw conflict(`该 Issue 已有一个在跑的 run（${active.id}，${active.status}）——同一 Issue 同时只允许一个，先等它结束或中止它`);
  }

  const run = issues.addRun(input.issueId, {
    mode: input.mode,
    prompt: input.prompt,
    kind: "acp",
    agentId: input.agent.id,
    agentName: input.agent.name,
  });

  const cwd = input.agent.cwd || ACP_WORKSPACE_DIR;
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {
    /* 已存在或建不出来：spawn 会用自己的报错说清楚 */
  }

  let child: ChildProcess;
  try {
    child = spawn(input.agent.command, input.agent.args, {
      cwd,
      // agent 的 env 叠在画板进程 env 之上：PATH 等基础环境保留，密钥类由注册表补
      env: { ...process.env, ...input.agent.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    finishWithoutSession(input.issueId, run.id, "failed", "agent 进程拉起失败，请检查 Runner 设置中的命令、参数与工作目录");
    return issues.findRun(run.id)!.run;
  }

  const session: AcpSession = {
    runId: run.id,
    issueId: input.issueId,
    agent: { id: input.agent.id, name: input.agent.name },
    permissionMode: input.permissionMode,
    cwd,
    child,
    peer: new JsonRpcPeer(child),
    sessionId: null,
    pending: null,
    done: false,
    timers: [],
  };
  state.sessions.set(run.id, session);
  ensureExitHook();

  // Drain stderr so the child cannot block on a full pipe. Never publish raw diagnostics:
  // CLI errors routinely echo environment values, command arguments and local paths.
  child.stderr?.resume();

  // spawn 层错误（命令不存在等）不会走 exit：单独接住
  child.on("error", () => {
    if (session.done) return;
    finishRun(session, "failed", "agent 进程拉起失败，请检查 Runner 设置中的命令、参数与工作目录");
  });

  child.on("exit", (code, signal) => {
    session.peer.close("agent 进程已退出");
    for (const timer of session.timers) clearTimeout(timer);
    if (!session.done) {
      finishRun(session, "failed", `agent 进程意外退出（${signal || `code ${code}`}），请检查 agent 的本机运行配置`);
    }
    state.sessions.delete(session.runId);
  });

  session.peer.onNotification("session/update", (params) => {
    if (!params || (session.sessionId && params.sessionId !== session.sessionId)) return;
    appendTranscript(session.runId, { type: "update", update: params.update ?? null });
  });

  session.peer.onRequest("session/request_permission", (params) => handlePermissionRequest(session, params));

  appendTranscript(run.id, {
    type: "status",
    status: "spawned",
    detail: `agent ${input.agent.id}`,
  });
  // 子进程已拉起就算开工：Issue 立刻进「进行中」，initialize 失败再改判 failed
  safePatchRun(session, { status: "running" });

  void driveSession(session, run.prompt);
  return issues.findRun(run.id)!.run;
}

/** 协议主流程（异步跑在后台，launch 请求不等它） */
async function driveSession(session: AcpSession, promptText: string): Promise<void> {
  try {
    const init = await session.peer.request(
      "initialize",
      {
        protocolVersion: 1,
        // 能力最小化（设计决策 §6）：不支持 fs / terminal，agent 硬发会收到 -32601
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      INIT_TIMEOUT_MS,
    );
    appendTranscript(session.runId, { type: "status", status: "initialized", detail: `protocolVersion ${init?.protocolVersion ?? "?"}` });

    const created = await session.peer.request("session/new", { cwd: session.cwd, mcpServers: [] }, INIT_TIMEOUT_MS);
    session.sessionId = String(created?.sessionId || "");
    if (!session.sessionId) throw new Error("agent 的 session/new 没有返回 sessionId");
    appendTranscript(session.runId, { type: "status", status: "session", detail: session.sessionId });

    // prompt 不限时：coding agent 一跑几十分钟很正常，生命周期由 cancel / 进程退出兜底
    const result = await session.peer.request(
      "session/prompt",
      { sessionId: session.sessionId, prompt: [{ type: "text", text: promptText }] },
      0,
    );
    handleStopReason(session, String(result?.stopReason || "end_turn"));
  } catch (err) {
    if (!session.done) {
      const detail = err instanceof RpcRemoteError && Number.isFinite(err.code) ? `（协议错误码 ${err.code}）` : "";
      finishRun(session, "failed", `agent 会话失败${detail}，请检查 agent 的 ACP 支持与本机运行配置`);
    }
    cleanupChild(session);
  }
}

function handleStopReason(session: AcpSession, stopReason: string): void {
  appendTranscript(session.runId, { type: "status", status: "stop", detail: stopReason });
  if (!session.done) {
    // 用户先手动中止的话 run 已是 aborted：这里读现状，别把人家的中止改写成完成
    const current = issues.findRun(session.runId)?.run.status;
    if (current === "aborted") {
      session.done = true;
    } else if (stopReason === "refusal") {
      finishRun(session, "failed", "agent 拒绝了这次请求（refusal）");
    } else if (stopReason === "cancelled") {
      finishRun(session, "aborted", "执行被取消（cancelled）");
    } else {
      // end_turn / max_tokens / max_turn_requests 都算跑完了一轮；非正常收束在备注里说明
      finishRun(session, "completed", stopReason === "end_turn" ? "agent 执行完成" : `agent 停止（${stopReason}）`);
    }
  }
  cleanupChild(session);
}

/* ── 权限请求 ─────────────────────────────────────── */

async function handlePermissionRequest(session: AcpSession, params: any): Promise<unknown> {
  const options: { optionId: string; name: string; kind: string }[] = Array.isArray(params?.options)
    ? params.options.map((option: any) => ({
        optionId: String(option?.optionId ?? ""),
        name: String(option?.name ?? option?.optionId ?? ""),
        kind: String(option?.kind ?? ""),
      }))
    : [];
  const title = String(params?.toolCall?.title || params?.toolCall?.rawInput?.command || "agent 请求执行一个需要授权的操作");
  appendTranscript(session.runId, { type: "permission_request", title, options });

  if (session.permissionMode === "auto") {
    // 自动档：选 allow 类里最保守的一次性放行；没有 allow 类选项就只能取消
    const pick =
      options.find((option) => option.kind === "allow_once") ||
      options.find((option) => option.kind.startsWith("allow")) ||
      null;
    if (!pick) {
      appendTranscript(session.runId, { type: "permission_decision", optionId: null, auto: true, detail: "没有 allow 类选项，按取消处理" });
      return { outcome: { outcome: "cancelled" } };
    }
    appendTranscript(session.runId, { type: "permission_decision", optionId: pick.optionId, auto: true });
    return { outcome: { outcome: "selected", optionId: pick.optionId } };
  }

  // ask 档：run 停到 waiting（Issue 进「等我处理」镜头），把选项持久化给任务台渲染，
  // resolver 挂在内存里等 POST /permission 来兑现
  safePatchRun(session, { status: "waiting", note: `等待授权：${title}` });
  issues.setRunPermissionRequest(session.issueId, session.runId, { at: Date.now(), title, options });
  return new Promise((resolve) => {
    session.pending = { options, resolve };
  });
}

/** POST /api/issues/:id/runs/:runId/permission 的落点 */
export function resolvePermission(issueId: string, runId: string, rawOptionId: unknown): issues.LocalIssueRun {
  ensureStartupSweep();
  const state = globalState();
  const found = issues.findRun(runId);
  if (!found || found.issue.id !== issueId) throw notFound("run 不存在");
  const session = state.sessions.get(runId);
  if (!session || !session.pending) {
    // 服务重启过（sweep 已把 run 标中止）或请求已被处理：给人话，别装作还能批
    throw conflict("这个 run 没有等待中的权限请求（可能已被处理，或服务重启导致会话丢失）");
  }
  const optionId = String(rawOptionId ?? "");
  if (!session.pending.options.some((option) => option.optionId === optionId)) {
    throw badRequest(`选项不存在：「${optionId}」（可选：${session.pending.options.map((option) => option.optionId).join(" / ")}）`);
  }
  appendTranscript(runId, { type: "permission_decision", optionId, auto: false });
  session.pending.resolve({ outcome: { outcome: "selected", optionId } });
  session.pending = null;
  issues.setRunPermissionRequest(issueId, runId, null);
  safePatchRun(session, { status: "running", note: null });
  return issues.findRun(runId)!.run;
}

/* ── 中止与收尾 ───────────────────────────────────── */

/**
 * run 状态被外部改写（PATCH /runs/:runId）后的钩子：
 *  - aborted → 走 ACP 的 cancel 链路（session/cancel → 5s → SIGTERM）；
 *  - 其他终态（completed / failed，来自 HTTP 回写通道）→ 会话已无意义，直接收尾。
 */
export function handleExternalRunStatus(runId: string, status: issues.LocalRunStatus): void {
  const session = globalState().sessions.get(runId);
  if (!session) return;
  if (status === "aborted") {
    cancelSession(session);
    return;
  }
  if (status === "completed" || status === "failed") {
    session.done = true;
    resolvePendingAsCancelled(session);
    appendTranscript(session.runId, { type: "status", status: "external", detail: `run 被外部回写为 ${status}，会话收尾` });
    cleanupChild(session);
  }
}

function cancelSession(session: AcpSession): void {
  if (session.done) {
    cleanupChild(session);
    return;
  }
  session.done = true;
  appendTranscript(session.runId, { type: "status", status: "cancel", detail: "已发 session/cancel，等 agent 体面退出" });
  resolvePendingAsCancelled(session);
  if (session.sessionId) session.peer.notify("session/cancel", { sessionId: session.sessionId });
  // 协议约定 agent 收到 cancel 会尽快用 stopReason=cancelled 结束 prompt；
  // 不守约的给 5s，然后 SIGTERM、再不走 SIGKILL
  const term = setTimeout(() => {
    if (session.child.exitCode === null) session.child.kill("SIGTERM");
    const kill = setTimeout(() => {
      if (session.child.exitCode === null) session.child.kill("SIGKILL");
    }, TERM_TO_KILL_MS);
    kill.unref?.();
    session.timers.push(kill);
  }, CANCEL_GRACE_MS);
  term.unref?.();
  session.timers.push(term);
}

/** 挂着的权限请求按协议回 cancelled——中止时不能让 agent 卡在等答复上 */
function resolvePendingAsCancelled(session: AcpSession): void {
  if (!session.pending) return;
  session.pending.resolve({ outcome: { outcome: "cancelled" } });
  session.pending = null;
  issues.setRunPermissionRequest(session.issueId, session.runId, null);
}

/** 定终态 + 记账（transcript / run note / Issue 状态随 patchRun 联动） */
function finishRun(session: AcpSession, status: "completed" | "failed" | "aborted", note: string): void {
  session.done = true;
  resolvePendingAsCancelled(session);
  appendTranscript(session.runId, { type: "status", status, detail: note });
  safePatchRun(session, { status, note });
}

function finishWithoutSession(issueId: string, runId: string, status: "failed", note: string): void {
  appendTranscript(runId, { type: "status", status, detail: note });
  try {
    issues.patchRun(issueId, runId, { status, note });
  } catch (err) {
    console.error(`[acp] run 状态落盘失败（${runId}）：${String((err as Error)?.message || err)}`);
  }
}

function safePatchRun(session: AcpSession, patch: { status?: issues.LocalRunStatus; note?: string | null }): void {
  try {
    issues.patchRun(session.issueId, session.runId, patch);
  } catch (err) {
    // Issue 可能被人删了：执行照常收尾，只是没账可记
    console.error(`[acp] run 状态落盘失败（${session.runId}）：${String((err as Error)?.message || err)}`);
  }
}

/** 温和收尾：先关 stdin（多数 agent 视 EOF 为退出信号），不走再升级到信号 */
function cleanupChild(session: AcpSession): void {
  if (session.child.exitCode !== null) return;
  try {
    session.child.stdin?.end();
  } catch {
    /* 管道可能已断 */
  }
  const term = setTimeout(() => {
    if (session.child.exitCode === null) session.child.kill("SIGTERM");
    const kill = setTimeout(() => {
      if (session.child.exitCode === null) session.child.kill("SIGKILL");
    }, TERM_TO_KILL_MS);
    kill.unref?.();
    session.timers.push(kill);
  }, 1500);
  term.unref?.();
  session.timers.push(term);
}

/** 进程退出时同步杀光子进程：pm2 restart 不能把 agent 孤儿留在系统里 */
function ensureExitHook(): void {
  const state = globalState();
  if (state.exitHooked) return;
  state.exitHooked = true;
  process.on("exit", () => {
    for (const [, session] of state.sessions) {
      try {
        session.child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  });
}

/** 任务台 / 冒烟观察用：这个 run 的会话还在内存表里吗 */
export function hasLiveSession(runId: string): boolean {
  return globalState().sessions.has(runId);
}
