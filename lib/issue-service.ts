/**
 * /api/issues 三条路由共用的服务层（只在 local 任务后端下有内容可服务）。
 *
 * 职责：把存储层的裸 Issue 补上画板侧的坐标信息（板名 / 卡名 / 孤儿标记 / 镜头桶），
 * 以及「非 local 后端一律 501 指路」这道闸——真源在外部 Runner 时，
 * 这组端点不该假装自己有数据。
 */
import { ensureStartupSweep } from "./acp/manager";
import { TASK_BACKEND } from "./features";
import { ApiError } from "./http";
import { lensOf, listIssues, type IssueLens, type LocalIssue, type LocalIssueRun } from "./issue-store";
import * as store from "./storage";

/** 非 local 后端：501 + 指路（不是 404——路是有的，只是真源不在这）。 */
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
  return listIssues().map(decorateIssue);
}

/** 关键词匹配：标题 / 正文 / 编号 / 标签 / 板名（q 已 toLowerCase）。 */
export function issueMatches(issue: DecoratedIssue, q: string): boolean {
  return [issue.title, issue.description, issue.number, issue.labels.join(" "), issue.boardName || ""]
    .join("\n")
    .toLowerCase()
    .includes(q);
}
