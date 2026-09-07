/**
 * HTTP Runner 客户端（**实现层**：只被 lib/integrations/task-backend.ts 引用，
 * 业务代码一律走 taskBackend 接口）。
 *
 * 同一份实现服务两个后端（docs/RUNNER.md 的协议是同一个）：
 *  - goal-agent：GOAL_AGENT_RUNNER_URL + 画板内部 token（三级来源见 lib/config.ts）；
 *  - http（通用）：BLOTBOARD_RUNNER_URL + BLOTBOARD_RUNNER_TOKEN（不配就共用内部 token）。
 *
 * 数据归属红线：配了外部 Runner 时 Issue / 任务 / 会话的真源在对端，
 * 本服务不复制业务状态，只在卡片上保存引用 id（issueId / taskId），需要状态时现查。
 */
import { HTTP_RUNNER_TOKEN, HTTP_RUNNER_URL, RUNNER_URL, readInternalToken } from "./config";
import { ApiError } from "./http";

const TIMEOUT_MS = 15_000;

/** 一个远程 Runner 的落点：基址 + token 读取方式。 */
export interface RunnerTarget {
  baseUrl: string;
  readToken: () => string;
}

/** Goal Agent（现状默认）。 */
export const GOAL_AGENT_TARGET: RunnerTarget = {
  baseUrl: RUNNER_URL,
  readToken: readInternalToken,
};

/** 通用 http 后端：token 不配就退回内部 token（对端与画板共用一份时零配置）。 */
export const HTTP_RUNNER_TARGET: RunnerTarget = {
  baseUrl: HTTP_RUNNER_URL,
  readToken: () => HTTP_RUNNER_TOKEN || readInternalToken(),
};

export async function callRunner<T = any>(
  method: string,
  runnerPath: string,
  payload?: unknown,
  target: RunnerTarget = GOAL_AGENT_TARGET,
): Promise<T> {
  // token 读取也在错误包装之内：settings 文件缺失时抛裸 ENOENT 会变成 500，
  // 还把本机绝对路径带进 API 响应——统一包成 502 的 ApiError
  let token: string;
  try {
    token = target.readToken();
  } catch {
    throw new ApiError("Runner token 未配置（检查 BLOTBOARD_GOAL_AGENT_SETTINGS / 画板数据目录 token 文件）", 502);
  }
  let response: Response;
  try {
    response = await fetch(`${target.baseUrl}${runnerPath}`, {
      method,
      // Custom credential headers survive cross-origin redirects in fetch. Never follow them.
      redirect: "error",
      headers: { "x-auth-key": token, "content-type": "application/json" },
      body: payload == null ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: any) {
    const message = err?.name === "TimeoutError" || err?.name === "AbortError"
      ? "Runner 请求超时"
      : "无法连接任务 Runner，请检查 Runner 地址、网络与服务状态";
    throw new ApiError(message, 502);
  }
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    // Upstream diagnostics can contain credentials or filesystem paths. Keep only status.
    const message = `Runner 响应 ${response.status}，请检查 Runner 服务日志`;
    throw new ApiError(message, response.status >= 500 ? 502 : 400);
  }
  return data as T;
}

/**
 * 只读 / 派任务的 Runner 直通白名单（画板前端用）。
 * 与 goal-agent 网关的 runnerRoute 同样是「显式列举」，不做通配转发。
 * local 后端也复用这份白名单（未放行仍是 404），能就地服务的路径就地服务。
 */
export function runnerProxyPath(subPath: string, method: string): string | null {
  const clean = `/${subPath.replace(/^\/+/, "")}`;
  if (clean === "/tasks") return method === "POST" || method === "GET" ? "/api/tasks" : null;
  if (/^\/tasks\/[A-Za-z0-9._-]+$/.test(clean)) return method === "GET" ? `/api${clean}` : null;
  if (/^\/tasks\/[A-Za-z0-9._-]+\/(events|transcript)$/.test(clean)) return method === "GET" ? `/api${clean}` : null;
  // Issue 详情可读可改：画板上要能给任务卡挂标签 / 调状态，跟 Goal Agent 的 Issue 体系是同一份数据
  if (/^\/issues\/[A-Za-z0-9._-]+$/.test(clean)) {
    if (method === "GET") return `/api${clean}`;
    if (method === "PATCH") return `/api${clean}`;
    return null;
  }
  // 任务产出：列出、看元数据、取文本预览。产出是「任务做完留下的东西」，
  // 画板要把它接回卡片，所以这三条必须开
  if (clean === "/artifacts") return method === "GET" ? "/api/artifacts" : null;
  if (/^\/artifacts\/[A-Za-z0-9._-]+$/.test(clean)) return method === "GET" ? `/api${clean}` : null;
  if (/^\/artifacts\/[A-Za-z0-9._-]+\/preview$/.test(clean)) return method === "GET" ? `/api${clean}` : null;
  if (clean === "/health") return method === "GET" ? "/api/health" : null;
  return null;
}
