/**
 * 本机 ACP 执行通道 —— **与 tasks.backend 正交**的第二条执行路。
 *
 * 背景：ACP 派单原来只长在 local 后端上（`task-backend-local.launch` 里认 agentId），
 * goal-agent / http 后端下 agentId 被直接丢弃。结果是「已经接了外部 Runner 的部署
 * 反而用不上『一键派给本机 Claude Code』」——最需要这个能力的人用不了。
 *
 * 这里把「本机 spawn 一个 ACP agent 跑一轮」抽成独立通道，两种后端共用：
 *
 *  - **Issue 真源不动**：远程后端下 Issue 仍归对端，本模块只在本地开一条带
 *    `external` 标记的**执行台账**（issue-store ExternalIssueRef）来挂 run / transcript /
 *    权限请求。台账不进任务台的 Issue 列表（listOwnIssues 已筛掉），不造第二本账；
 *  - **同一条远程 Issue 的多次本机执行记在同一条台账上**，历史连得起来；
 *  - **run id 前缀即路由**：本机 run 一律 `r_` 开头且本地查得到，`getTask` / proxy
 *    据此决定就地服务还是打对端——外部 Runner 的执行与本机执行各自记账，互不干扰。
 */
import { startAcpRun } from "../acp/manager";
import { badRequest } from "../http";
import * as issues from "../issue-store";
import { getAgent, loadRunnerSettings } from "../runner-settings";
import { buildRunPrompt, runAsTask } from "./task-backend-local";

export interface LocalAcpLaunchInput {
  /** 注册表里的 agent id（lib/runner-settings.ts） */
  agentId: string;
  mode: "implement" | "analyze";
  /** 对端 Issue 的坐标 */
  external: issues.ExternalIssueRef;
  /** 对端 Issue 的当前标题 / 正文（每次派单前现取，别拿旧快照跑） */
  title: string;
  description: string;
  /** 画板侧来源坐标，用来给 prompt 里的深链 */
  origin?: { boardId?: string | null; cardId?: string | null } | null;
}

/**
 * 在远程后端下派一轮本机 ACP。返回形状与 `task-backend-local.launch` 一致
 * （`sessionId` = run id），所以调用方与任务卡轮询一行都不用改。
 */
export function launchLocalAcp(input: LocalAcpLaunchInput) {
  const agent = getAgent(input.agentId);
  if (!agent) throw badRequest(`agent 不存在：「${input.agentId}」——先在任务台「Runner 设置」里注册`);

  const ledger = issues.ensureExternalIssue({
    external: input.external,
    title: input.title,
    description: input.description,
    boardId: input.origin?.boardId || null,
    cardId: input.origin?.cardId || null,
  });

  const settings = loadRunnerSettings();
  const run = startAcpRun({
    issueId: ledger.id,
    agent,
    permissionMode: settings.permissionMode,
    mode: input.mode,
    prompt: (issue, runId) => buildRunPrompt(issue, input.mode, runId),
  });
  return {
    sessionId: run.id,
    mode: input.mode,
    issue: { id: input.external.issueId },
    agent: { id: agent.id, name: agent.name },
    /** 调用方据此知道这一轮跑在本机而不是对端 */
    local: true as const,
  };
}

/**
 * 这个 taskId 是不是本机的 ACP run。**先看前缀再查库**：对端的 task id 形态各异，
 * 拿它去遍历本地 issues.json 属于白费——前缀不对就直接放行给对端。
 */
export function localRunOf(taskId: string): { issue: issues.LocalIssue; run: issues.LocalIssueRun } | null {
  if (!taskId.startsWith("r_")) return null;
  return issues.findRun(taskId);
}

/** 本机 run 的轮询形状（与 local 后端 getTask 同一份），不是本机 run 就回 null */
export function localRunTask(taskId: string): any | null {
  const found = localRunOf(taskId);
  return found ? runAsTask(found) : null;
}
