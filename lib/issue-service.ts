/**
 * /api/issues 三条路由共用的服务层（只在 local 任务后端下有内容可服务）。
 *
 * 职责：把存储层的裸 Issue 补上画板侧的坐标信息（板名 / 卡名 / 孤儿标记 / 镜头桶），
 * 以及三道后端闸——真源在外部 Runner 时这组端点不该假装自己有数据，
 * 但**本机 ACP run** 在任何后端下都可能有，两件事得分开：
 *   assertLocalIssues —— Issue 真源类（列表 / 建）：非 local 一律 501；
 *   assertLocalIssue  —— 单条 Issue：非 local 只放行本机执行台账（external 标记）；
 *   assertLocalRun    —— run 级（回写 / transcript / 权限）：本机查得到就放行。
 */
import { ensureStartupSweep } from "./acp/manager";
import { TASK_BACKEND } from "./features";
import { ApiError } from "./http";
import { findRun, getIssue, lensOf, listOwnIssues, type IssueLens, type LocalIssue, type LocalIssueRun } from "./issue-store";
import * as store from "./storage";

/**
 * 「Issue 真源类」操作的闸：列表 / 建 Issue 这种只有 local 后端才谈得上。
 * 非 local 后端：501 + 指路（不是 404——路是有的，只是真源不在这）。
 *
 * ⚠️ 别拿它去挡 **run 级**操作（回写状态 / transcript / 权限确认）：
 * 那些在任何后端下都可能有本机 ACP run 要服务，用下面的 assertLocalRun / assertLocalIssue。
 */
export function assertLocalIssues(): void {
  if (TASK_BACKEND === "local") {
    // ACP 的重启兜底挂在「第一次有人碰 Issue 数据」上（进程内只跑一次）：
    // 重启后任务台第一眼看到的就是已被标中止的 run，而不是僵死的 running
    ensureStartupSweep();
    return;
  }
  throw new ApiError(
    `Issue 的真源在外部 Runner（当前任务后端：${TASK_BACKEND}）——请直接调用 Runner 的 /api/issues 接口，画板前端走 /api/runner/issues/:id 代理`,
    501,
  );
}

/**
 * run 级操作的闸：**本机查得到这个 run 就放行**，与任务后端无关。
 *
 * 本机 ACP 派单在 goal-agent / http 后端下也成立（docs/RUNNER.md §4.3），
 * 那些 run 的回写口、transcript、权限确认都长在 `/api/issues/:id/runs/:runId` 下面——
 * 用整体闸挡掉的话，agent 一开工就 501，等于本机派单根本跑不完一轮。
 */
export function assertLocalRun(runId: string): void {
  ensureStartupSweep();
  if (TASK_BACKEND === "local" || findRun(runId)) return;
  throw new ApiError(
    `run 不在本机（当前任务后端：${TASK_BACKEND}）——外部 Runner 的执行状态请走 /api/runner/tasks/:taskId 代理`,
    501,
  );
}

/**
 * 单条 Issue 的读写闸：local 后端全放行；非 local 后端只放行**本机执行台账**
 * （external 标记的那些，见 issue-store ExternalIssueRef）——ACP agent 拿到的 prompt
 * 里写的就是这条地址，它得读得到、也得能补备注。真正的远程 Issue 仍然 501 指路。
 */
export function assertLocalIssue(issueId: string): void {
  ensureStartupSweep();
  if (TASK_BACKEND === "local") return;
  const issue = getIssue(issueId);
  if (issue?.external) return;
  throw new ApiError(
    `Issue 的真源在外部 Runner（当前任务后端：${TASK_BACKEND}）——请直接调用 Runner 的 /api/issues 接口，画板前端走 /api/runner/issues/:id 代理`,
    501,
  );
}

/** 任务台列表 / 详情共用的装饰形状（存储字段 + 画板坐标 + 镜头桶）。 */
export interface DecoratedIssue extends LocalIssue {
  lens: Exclude<IssueLens, "all">;
  boardName: string | null;
  cardTitle: string | null;
  /** 来源画板或卡片已删：只有任务台列表能看到它（本板视角永远看不到） */
  orphan: boolean;
  runCount: number;
  lastRun: Pick<LocalIssueRun, "id" | "status" | "mode" | "updatedAt" | "kind" | "agentName"> | null;
}

export function decorateIssue(issue: LocalIssue): DecoratedIssue {
  let boardName: string | null = null;
  let cardTitle: string | null = null;
  let orphan = false;
  if (issue.boardId) {
    const board = store.get(issue.boardId);
    if (!board) orphan = true;
    else {
      boardName = board.name;
      if (issue.cardId) {
        const card = (board.cards || []).find((item) => item.id === issue.cardId);
        if (!card) orphan = true;
        else cardTitle = card.title || null;
      }
    }
  }
  const last = issue.runs[issue.runs.length - 1] || null;
  return {
    ...issue,
    lens: lensOf(issue),
    boardName,
    cardTitle,
    orphan,
    runCount: issue.runs.length,
    lastRun: last
      ? { id: last.id, status: last.status, mode: last.mode, updatedAt: last.updatedAt, kind: last.kind || "prompt", agentName: last.agentName || null }
      : null,
  };
}

export function listDecoratedIssues(): DecoratedIssue[] {
  // listOwnIssues 而不是 listIssues：「本机执行远程 Issue」的台账不该混进 Issue 列表
  return listOwnIssues().map(decorateIssue);
}

/** 关键词匹配：标题 / 正文 / 编号 / 标签 / 板名（q 已 toLowerCase）。 */
export function issueMatches(issue: DecoratedIssue, q: string): boolean {
  return [issue.title, issue.description, issue.number, issue.labels.join(" "), issue.boardName || ""]
    .join("\n")
    .toLowerCase()
    .includes(q);
}
