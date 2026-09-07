"use client";

/** 任务卡的前端槽位（卡面页脚状态机 / 编辑器优先级 / 工具条入口）。 */
import { useFeatures } from "@/lib/features-client";
import { ICON_SM, STATUS_ICON, UI } from "@/lib/icons";
import { BodyText, ReaderText } from "@/components/cards/CardText";
import { ContentSection } from "@/components/cards/editor-bits";
import { useT } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import type { CardAction, CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";
import { TASK_PRIORITIES } from "@/lib/types";
import type { BoardCard, LiveTaskStatus, TaskField, TaskPriority, TaskStatus } from "@/lib/types";

type Translate = (key: DictKey, vars?: Record<string, string | number>) => string;

/** 执行态文案：认得的走字典，认不得的原样显示（口径与 lib/constants 的 RUNNER_STATUS_LABEL 一致） */
const RUNNER_STATUSES = new Set(["pending", "running", "waiting", "completed", "failed", "aborted", "unknown"]);
function runnerLabel(t: Translate, status: string): string {
  return RUNNER_STATUSES.has(status) ? t(`cards.task.run.${status}` as DictKey) : status;
}

/** 任务卡页脚：状态 · 编号 · 优先级 · 关联数 ——— 主动作 */
function TaskFoot({
  card,
  live,
  related,
  onAction,
}: {
  card: BoardCard;
  live?: LiveTaskStatus;
  related: { up: BoardCard[]; down: BoardCard[] };
  onAction: (action: CardAction) => void;
}) {
  const task: Partial<TaskField> = card.task || { status: "idea" };
  const status: TaskStatus = task.status || "idea";
  const StatusIcon = STATUS_ICON[status];
  // 任务链路永远可用；后端种类只决定「发起」的形态：
  // local 下不真派单，而是生成完整 prompt 供复制，按钮文案跟着换
  const { taskBackend, browserStorage } = useFeatures();
  const t = useT();
  const liveLabel =
    status === "running" && live && live.status !== "unknown"
      ? runnerLabel(t, live.status)
      : null;
  const statusLabel = t(`cards.task.status.${status}` as const);

  // 主动作：只放「下一步该做的那一个」，其余进 ⋯ / 右键菜单
  const primary = browserStorage
    ? { key: "detail" as const, label: t("cards.task.action.local"), icon: UI.detail }
    : status === "idea"
      ? { key: "issue" as const, label: t("cards.task.action.issue"), icon: UI.send }
      : status === "issued"
        ? { key: "launch" as const, label: t(taskBackend === "local" ? "cards.task.action.prompt" : "cards.task.action.launch"), icon: UI.run }
        : { key: "detail" as const, label: t(status === "running" ? "cards.task.action.progress" : "cards.task.action.detail"), icon: UI.detail };

  const PrimaryIcon = primary.icon;
  const relCount = related.up.length + related.down.length;

  return (
    <div className="task-foot nodrag">
      <span className={`status-chip st-${status}`} title={statusLabel}>
        <StatusIcon {...ICON_SM} />
        <span>{liveLabel || statusLabel}</span>
      </span>
      {task.issueNumber ? (
        <span className="meta-chip mono" title={`Goal Agent Issue ${task.issueNumber}`}>
          {task.issueNumber}
        </span>
      ) : null}
      {task.priority && task.priority !== "none" ? (
        <span
          className={`meta-chip prio-${task.priority}`}
          title={t("cards.task.priorityTitle", { priority: t(`cards.task.priority.${task.priority}` as const) })}
        >
          <span className={`prio ${task.priority}`} />
          {t("cards.task.priorityChip", { priority: t(`cards.task.priority.${task.priority}` as const) })}
        </span>
      ) : null}
      {relCount ? (
        // 光一个图标 + 数字看不出是什么，补上「关联」两个字
        <span
          className="meta-chip"
          title={t("cards.task.relatedTitle", {
            count: relCount,
            up: related.up.map((c) => c.title || t("cards.task.untitled")).join(t("cards.task.joiner")) || t("cards.task.none"),
            down: related.down.map((c) => c.title || t("cards.task.untitled")).join(t("cards.task.joiner")) || t("cards.task.none"),
          })}
        >
          <UI.relations {...ICON_SM} />
          {t("cards.task.relatedChip", { count: relCount })}
        </span>
      ) : null}
      <span className="foot-spacer" />
      <button className="card-action" data-act={primary.key} onClick={() => onAction(primary.key)}>
        <PrimaryIcon {...ICON_SM} />
        {primary.label}
      </button>
    </div>
  );
}

function Fields({ draft, patch, roomy }: EditorFieldsProps) {
  const t = useT();
  return (
    <>
      <ContentSection
        value={draft.content}
        onChange={(content) => patch({ content })}
        roomy={roomy}
        placeholder={t("cards.task.goalPlaceholder")}
      />
      <div className="row">
        <span className="hint">{t("cards.task.priorityLabel")}</span>
        <select
          data-field="task.priority"
          value={draft.priority}
          onChange={(event) => patch({ priority: event.target.value as TaskPriority })}
        >
          {TASK_PRIORITIES.map((key) => (
            <option key={key} value={key}>
              {t(`cards.task.priority.${key}` as const)}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card, live, related, onAction }) {
    const t = useT();
    const goal = card.content || card.task?.goal || "";
    return (
      <div className="card-stack">
        {goal ? (
          <BodyText text={goal} className="grow" />
        ) : (
          <div className="placeholder grow">{t("cards.task.empty")}</div>
        )}
        <TaskFoot card={card} live={live} related={related} onAction={onAction} />
      </div>
    );
  },
  /**
   * 摊开看：正文不截断，另把状态 / 优先级 / Issue 号摆出来。
   * 通用兜底只印 goal——「这条任务现在到哪一步了」是读它时最想知道的，
   * 卡面上有、摊开反而没有说不过去。
   */
  FullView({ card }) {
    const t = useT();
    const task = card.task;
    const goal = card.content || task?.goal || "";
    const chips: string[] = [];
    if (task?.status) chips.push(t(`cards.task.status.${task.status}` as const));
    if (task?.priority && task.priority !== "none") {
      chips.push(t("cards.task.readerPriority", { priority: t(`cards.task.priority.${task.priority}` as const) }));
    }
    if (task?.issueNumber) chips.push(`Issue #${task.issueNumber}`);
    if (task?.taskStatus) chips.push(t("cards.task.readerRun", { run: runnerLabel(t, task.taskStatus) }));
    return (
      <div className="reader-text">
        {chips.length ? (
          <div className="reader-chips">
            {chips.map((chip) => (
              <span className="reader-chip" key={chip}>
                {chip}
              </span>
            ))}
          </div>
        ) : null}
        {goal ? <ReaderText body={goal} /> : <span className="placeholder">{t("cards.task.readerEmpty")}</span>}
      </div>
    );
  },
  editor: {
    draftFrom(card) {
      return { content: card.content || card.task?.goal || "", priority: card.task?.priority || "none" };
    },
    buildPatch(_card, draft) {
      return { content: draft.content.trim(), task: { priority: draft.priority, goal: draft.content.trim() } };
    },
    Fields,
  },
  toolbar: {
    title: "任务卡片",
    group: 1,
    order: 20,
    onClick: (ctx) => ctx.add("task"),
  },
};
