/**
 * ACP 连通性检测（任务台「Runner 设置」的「检测」按钮 / 预设的「一键添加」）。
 *
 * 干的事就一句：**用画板真正派单时的同一套握手去试一次**——spawn → initialize
 * （protocolVersion 1 + 与 manager.ts 逐字一致的最小 clientCapabilities）→
 * session/new → 立刻收尾杀进程。**不发 session/prompt**，所以不花 token、不动任何文件。
 *
 * 为什么必须真握手而不是 `which` 一下：五个候选里，装了 CLI ≠ 说 ACP
 * （claude / codex / pi 都得跑适配器），说 ACP ≠ 能开会话（没登录会在 session/new
 * 或 initialize 报 -32000）。只有跑完这两步才敢跟用户说「这个能用」。
 *
 * 安全边界与 manager.ts 同级：只在带鉴权的写口触发，命令来自注册表或本次请求体，
 * **绝不来自卡片内容**；失败原因经 redactDiagnostic 脱敏后才回给浏览器。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { ACP_WORKSPACE_DIR } from "../config";
import { JsonRpcPeer, RpcRemoteError } from "./jsonrpc";
import type { AcpPreset } from "./presets";
import { collectSecrets, redactDiagnostic } from "./redact";

/** 一次探测的上限。比 manager 的 INIT_TIMEOUT_MS 再宽一点：npx 首次下载适配器要十几秒 */
const PROBE_TIMEOUT_MS = 90_000;
const STDERR_TAIL_CHARS = 600;

export interface ProbeCandidate {
  command: string;
  args: string[];
  cwd?: string | null;
  env?: Record<string, string>;
}

export type ProbeStage = "spawn" | "initialize" | "session" | "done";

export interface ProbeResult {
  ok: boolean;
  /** 走到哪一步（失败时就是卡住的那一步） */
  stage: ProbeStage;
  command: string;
  args: string[];
  ms: number;
  protocolVersion: number | null;
  /** agent 自报的认证方式；非空 = 它认为你可能需要登录 */
  authMethods: string[];
  /** 明确的「要认证」信号（-32000，各家约定俗成的 auth_required） */
  needsAuth: boolean;
  /** 失败原因（已脱敏），ok 时为 null */
  error: string | null;
  /** agent 的 stderr 尾巴（已脱敏），给排障看 */
  stderrTail: string | null;
}

/**
 * 探一条候选命令。永不抛：任何失败都表达成 `ok:false` + 卡住的 stage
 * （这是个诊断接口，它自己挂掉毫无意义）。
 */
export function probeAgentCommand(candidate: ProbeCandidate): Promise<ProbeResult> {
  const started = Date.now();
  const cwd = candidate.cwd || ACP_WORKSPACE_DIR;
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(candidate.env || {}) };
  const secrets = collectSecrets(childEnv);
  const redact = (text: string) => redactDiagnostic(text, { cwd, secrets });

  const result: ProbeResult = {
    ok: false,
    stage: "spawn",
    command: candidate.command,
    args: candidate.args,
    ms: 0,
    protocolVersion: null,
    authMethods: [],
    needsAuth: false,
    error: null,
    stderrTail: null,
  };

  return new Promise<ProbeResult>((resolve) => {
    let child: ChildProcess | null = null;
    let peer: JsonRpcPeer | null = null;
    let stderr = "";
    let settled = false;

    const finish = (stage: ProbeStage, ok: boolean, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.stage = stage;
      result.ok = ok;
      result.error = error ? redact(error) : null;
      result.ms = Date.now() - started;
      result.stderrTail = stderr ? redact(stderr.slice(-STDERR_TAIL_CHARS)).trim() || null : null;
      try {
        peer?.close("probe done");
      } catch {
        /* 收尾尽力而为 */
      }
      try {
        child?.kill("SIGKILL");
      } catch {
        /* 同上：进程可能已经自己退了 */
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish(result.stage, false, `超时（${PROBE_TIMEOUT_MS / 1000}s 内没走完握手，卡在 ${result.stage}）`),
      PROBE_TIMEOUT_MS,
    );

    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch {
      /* 已存在或建不出来：spawn 会用自己的报错说清楚 */
    }

    try {
      child = spawn(candidate.command, candidate.args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return finish("spawn", false, `拉不起来：${(err as Error).message}`);
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (err) => finish("spawn", false, `拉不起来：${err.message}（命令不在 PATH 里？）`));
    child.on("exit", (code, signal) => {
      if (signal === "SIGKILL") return; // 我们自己收的尾
      finish(result.stage, false, `进程退出（code ${code ?? "?"}${signal ? ` / ${signal}` : ""}），没完成握手`);
    });

    peer = new JsonRpcPeer(child);
    // agent 反向要 fs / terminal 时按画板口径拒掉：探测阶段的能力面必须与真派单一致
    void (async () => {
      try {
        result.stage = "initialize";
        const init = await peer!.request<any>(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          },
          PROBE_TIMEOUT_MS,
        );
        result.protocolVersion = typeof init?.protocolVersion === "number" ? init.protocolVersion : null;
        result.authMethods = Array.isArray(init?.authMethods)
          ? init.authMethods.map((m: any) => String(m?.id || m?.name || "")).filter(Boolean).slice(0, 8)
          : [];

        result.stage = "session";
        const created = await peer!.request<any>("session/new", { cwd, mcpServers: [] }, PROBE_TIMEOUT_MS);
        if (!created?.sessionId) return finish("session", false, "session/new 没返回 sessionId");
        finish("done", true, null);
      } catch (err) {
        if (err instanceof RpcRemoteError && err.code === -32000) {
          result.needsAuth = true;
          return finish(result.stage, false, "该 agent 要求先认证：在本机完成它的登录，或在下面的 env 里配好 API key");
        }
        finish(result.stage, false, (err as Error).message);
      }
    })();
  });
}

export interface PresetProbeResult extends ProbeResult {
  presetKey: string;
  name: string;
  /** 探通的是首选命令还是 npx 兜底 */
  via: "primary" | "fallback" | null;
  auth: string;
  note: string | null;
}

/**
 * 探一个预设：先试首选命令，不通再试 npx 兜底——「一键添加」落盘的就是探通的那条，
 * 所以用户拿到的注册表**一定是这台机器上真能跑的形态**，而不是文档里的理想形态。
 */
export async function probePreset(preset: AcpPreset, cwd?: string | null): Promise<PresetProbeResult> {
  const decorate = (r: ProbeResult, via: "primary" | "fallback" | null): PresetProbeResult => ({
    ...r,
    presetKey: preset.key,
    name: preset.name,
    via,
    auth: preset.auth,
    note: preset.note || null,
  });

  const primary = await probeAgentCommand({ command: preset.command, args: preset.args, cwd });
  if (primary.ok || !preset.fallback) return decorate(primary, primary.ok ? "primary" : null);

  // 首选没通且有兜底：再试一次。要认证不是「命令不对」，别白跑第二遍
  if (primary.needsAuth) return decorate(primary, "primary");
  const fallback = await probeAgentCommand({ command: preset.fallback.command, args: preset.fallback.args, cwd });
  return decorate(fallback, fallback.ok ? "fallback" : null);
}
