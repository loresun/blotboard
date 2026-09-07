/**
 * 任务后端 Provider（OPEN-SOURCE-PLAN §4 / §4.1）。
 *
 * 画板对任务后端的全部诉求只有 4 个动作：createIssue / patchIssue / launch / getTask
 * （调用面：board-service 3 处 + issue-sync 1 处），外加一条给前端的直通代理。
 * 把它们收进一个接口，后端就可换。选择次序（lib/features.ts TASK_BACKEND）：
 *
 *  - `http`：BLOTBOARD_RUNNER_URL —— 任何按 docs/RUNNER.md 协议实现的后端；
 *  - `goal-agent`：GOAL_AGENT_RUNNER_URL —— http 的特例，只是 token 来源不同
 *    （合并成同一份 callRunner 实现，见 lib/goal-agent.ts）；
 *  - `local`：都没配时的开源默认 —— Issue 落本地 issues.json，「发起任务」
 *    生成完整 prompt 供复制，agent 通过 /api/issues 回写（task-backend-local.ts）。
 *
 * 任务功能因此永远可用，不再有「未配置 → 503」的残缺形态。
 */
import { TASK_BACKEND } from "../features";
import { GOAL_AGENT_TARGET, HTTP_RUNNER_TARGET, callRunner, runnerProxyPath, type RunnerTarget } from "../goal-agent";
import { ApiError } from "../http";
import { localBackend } from "./task-backend-local";

export interface TaskBackend {
  /**
   * 建 Issue（任务卡「转 Issue」）。payload 形状随后端；远程后端收 title/description/priority/labels。
   * origin 是画板侧的来源坐标（深链 / 孤儿判定用）：只有 local 后端消费它，
   * **不会**发给远程 Runner——goal-agent 收到的请求体与从前逐字节一致。
   */
  createIssue(payload: Record<string, unknown>, origin?: { boardId: string; cardId: string }): Promise<any>;
  /** 回推 Issue 正文（画板 → 后端单向同步，见 lib/issue-sync.ts）。 */
  patchIssue(issueId: string, payload: Record<string, unknown>): Promise<any>;
  /**
   * 对已有 Issue 发起执行任务（local = 生成 prompt 挂成一个 run；带 agentId 时
   * local 会真 spawn 该 ACP agent 子进程跑这一个 run）。
   * options 是画板侧的扩展口：**只有 local 后端消费**，绝不进远程请求体——
   * goal-agent 收到的 launch 请求体与从前逐字节一致（行为零变化是硬性验收项）。
   */
  launch(issueId: string, payload: Record<string, unknown>, options?: { agentId?: string | null }): Promise<any>;
  /** 查执行任务的最新状态（不落库，真源在后端）。 */
  getTask(taskId: string): Promise<any>;
  /**
   * 前端 /api/runner/* 直通。白名单在 lib/goal-agent.ts runnerProxyPath（显式列举，
   * 不做通配转发）：未放行的路径抛 404。local 后端就地服务白名单里能服务的路径。
   */
  proxy<T = any>(method: string, subPath: string, query: string, body?: unknown): Promise<T>;
}

const encode = encodeURIComponent;

/**
 * 远程 http 后端的通用实现（docs/RUNNER.md 的 4 动作 + 直通代理）。
 * goal-agent 与通用 http 后端只差一个落点（基址 + token 来源）。
 */
function makeRemoteBackend(target: RunnerTarget): TaskBackend {
  return {
    // origin 刻意丢弃：远程后端的请求体保持原形状（goal-agent 链路零变化）
    createIssue: (payload) => callRunner("POST", "/api/issues", payload, target),
    patchIssue: (issueId, payload) => callRunner("PATCH", `/api/issues/${encode(issueId)}`, payload, target),
    launch: (issueId, payload) => callRunner("POST", `/api/issues/${encode(issueId)}/launch`, payload, target),
    getTask: (taskId) => callRunner("GET", `/api/tasks/${encode(taskId)}`, undefined, target),
    proxy: (method, subPath, query, body) => {
      const proxied = runnerProxyPath(subPath, method);
      if (!proxied) throw new ApiError("该 Runner 路径未开放", 404);
      return callRunner(method, `${proxied}${query}`, body, target);
    },
  };
}

export const taskBackend: TaskBackend =
  TASK_BACKEND === "http"
    ? makeRemoteBackend(HTTP_RUNNER_TARGET)
    : TASK_BACKEND === "goal-agent"
      ? makeRemoteBackend(GOAL_AGENT_TARGET)
      : localBackend;
