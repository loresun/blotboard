/** 任务卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import { TASK_PRIORITIES, TASK_STATUSES, type TaskField } from "@/lib/types";
import { MAX_CONTENT, assertEnumValue, cleanText } from "@/lib/normalize-base";
import type { CardPackSchema, SchemaCtx } from "@/lib/card-pack-types";

/**
 * 「建卡严」：单卡建 / 改时，status、priority 写错了要当场说，别静默变成 idea / none——
 * 调用方（尤其是 agent）会以为设置成功了。收卡宽的路（whole / 粘贴 / 信封）不传 strict。
 */
function assertTaskEnums(task: unknown, ctx: SchemaCtx): void {
  if (!ctx.strict || !task || typeof task !== "object") return;
  const raw = task as Record<string, unknown>;
  assertEnumValue(raw.status, TASK_STATUSES, "task.status");
  assertEnumValue(raw.priority, TASK_PRIORITIES, "task.priority");
}

export function normalizeTaskField(task: Partial<TaskField> = {}): TaskField {
  const status = TASK_STATUSES.includes(task.status as never) ? (task.status as TaskField["status"]) : "idea";
  return {
    status,
    goal: cleanText(task.goal, MAX_CONTENT, { fallback: "" }),
    priority: TASK_PRIORITIES.includes(task.priority as never) ? (task.priority as TaskField["priority"]) : "none",
    issueId: task.issueId ? String(task.issueId).slice(0, 100) : null,
    issueNumber: task.issueNumber != null ? String(task.issueNumber).slice(0, 20) : null,
    taskId: task.taskId ? String(task.taskId).slice(0, 100) : null,
    taskStatus: task.taskStatus ? String(task.taskStatus).slice(0, 40) : null,
    // 同步账本：由 lib/issue-sync.ts 回写，外部传进来的值只做形状收敛
    issueSyncedAt: Number.isFinite(Number(task.issueSyncedAt)) && Number(task.issueSyncedAt) > 0 ? Number(task.issueSyncedAt) : null,
    issueSyncHash: task.issueSyncHash ? String(task.issueSyncHash).slice(0, 64) : null,
    issueSyncError: task.issueSyncError ? String(task.issueSyncError).slice(0, 300) : null,
  };
}

export const schema: CardPackSchema = {
  onCreate(card, input, ctx) {
    assertTaskEnums(input.task, ctx);
    card.task = normalizeTaskField(input.task);
  },
  onConvert(card) {
    // 想法文本卡 → 任务卡：正文顺势变成任务目标
    card.task = normalizeTaskField({ ...(card.task || {}), goal: card.task?.goal || card.content || card.title || "" });
  },
  onPatch(card, patch, ctx) {
    if (patch.task === undefined) return;
    assertTaskEnums(patch.task, ctx);
    card.task = normalizeTaskField({ ...(card.task || { status: "idea" }), ...patch.task });
  },
  markdownBeforeCommon: true,
  markdownLines(card) {
    if (!card.task) return [];
    const lines = [`- 状态：${card.task.status}${card.task.issueNumber ? ` · ${card.task.issueNumber}` : ""}`];
    if (card.task.priority && card.task.priority !== "none") lines.push(`- 优先级：${card.task.priority}`);
    if (card.task.taskId) lines.push(`- 任务：\`${card.task.taskId}\``);
    return lines;
  },
};
