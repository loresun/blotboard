"use client";

/**
 * React Flow 自定义节点：一张画板卡片。
 *
 * 四边锚点用 Handle（拖出即连线，拖到空白由 onConnectEnd 衍生新卡）；尺寸交给 NodeResizer。
 * 卡头右侧是一组工具：放大（进阅读模式）+ ⋯（与右键同一份菜单：删除、改色、类型互转）。
 * 两个按钮平时半隐（visibility 而不是 display，位置一直占着），
 * 所以标题的可用宽度是恒定的——鼠标移上来时不会因为按钮冒出来而突然多截一截字。
 */
import { memo, useCallback } from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { CARD_SIZE_LIMITS, COLORS } from "@/lib/constants";
import { CARD_COLORS, type CardColor } from "@/lib/types";
import { ICON_SM, UI, specIcon, typeIcon } from "@/lib/icons";
import { useBoardStore } from "@/lib/store";
import { useCardLabel, useT } from "@/lib/i18n/client";

import type { BoardCard, LiveTaskStatus } from "@/lib/types";
import { CardBody, type CardAction } from "./CardBody";
import { SafeNodeToolbar } from "../SafeNodeToolbar";
import type { CardPatch } from "./CardEditor";

export interface CardNodeData extends Record<string, unknown> {
  card: BoardCard;
  live?: LiveTaskStatus;
  editing: boolean;
  flash: boolean;
  onAction: (cardId: string, action: CardAction) => void;
  onCommitEdit: (cardId: string, patch: CardPatch) => void;
  onMenu: (cardId: string, x: number, y: number) => void;
  /** 搜索筛选：没命中的卡片变淡，命中的加一圈描边 */
  dimmed?: boolean;
  hit?: boolean;
  /** 只有「单选这一张」时才给缩放手柄：多选时满屏手柄会把「拖动」误伤成「缩放」 */
  solo?: boolean;
  /**
   * 上下游关联卡片（只有任务卡页脚用得到）。
   * 由画布统一建索引后传进来——以前是每张卡在渲染里现算，
   * 那个实现要给每张卡各建一次全board的 Map，整体 O(N²)。
   */
  related: { up: BoardCard[]; down: BoardCard[] };
}

const HANDLE_SIDES: [Position, string][] = [
  [Position.Top, "top"],
  [Position.Right, "right"],
  [Position.Bottom, "bottom"],
  [Position.Left, "left"],
];

function CardNodeInner({ id, data, selected }: NodeProps & { data: CardNodeData }) {
  const { card, live, editing, flash, dimmed, hit, solo, related } = data;
  const t = useT();
  const cardLabel = useCardLabel();
  // 未知类型（本机没有对应卡片包）也要有名字：cardLabel 兜底为 type 本身
  const metaLabel = cardLabel(card.type);
  // 规格卡的卡头图标跟着规格走：一屏十几张规格卡时，图标是最快的区分手段
  const spec = useBoardStore((state) => (card.type === "data" && card.data ? state.specs[card.data.specId] : undefined));
  // typeIcon 对未知类型给兜底图标：数据里的 type 本机没有对应卡片包时，壳照常渲染
  const TypeIcon = card.type === "data" ? specIcon(spec?.icon) : typeIcon(card.type);
  const handleAction = useCallback((action: CardAction) => data.onAction(id, action), [data, id]);

  const className = [
    "card",
    `t-${card.type}`,
    card.type === "task" && card.task?.status ? `st-${card.task.status}` : "",
    editing ? "editing" : "",
    flash ? "flash" : "",
    dimmed ? "dimmed" : "",
    hit ? "hit" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const accent = COLORS[card.color] || COLORS.slate;

  return (
    <>
      {/* 官方 NodeToolbar：选中这一张时在卡片上方浮一条快捷条（默认开，工具箱里可关）。
          它**不替代**卡头的 ⋯ 与右键菜单——那两处是完整功能入口，这条只把最常用的几项提到手边。 */}
      <CardQuickBar cardId={id} card={card} visible={Boolean(selected) && solo !== false} />
      <NodeResizer
        isVisible={Boolean(selected) && solo !== false}
        minWidth={CARD_SIZE_LIMITS.minW}
        maxWidth={CARD_SIZE_LIMITS.maxW}
        minHeight={CARD_SIZE_LIMITS.minH}
        maxHeight={CARD_SIZE_LIMITS.maxH}
        lineClassName="line"
        handleClassName="handle"
      />
      {HANDLE_SIDES.map(([position, key]) => (
        <Handle key={key} id={key} type="source" position={position} isConnectableStart isConnectableEnd />
      ))}
      <div
        className={className}
        style={{ ["--card-accent" as string]: accent }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          data.onMenu(id, event.clientX, event.clientY);
        }}
      >
        <div className="card-head">
          <span className="card-type" title={spec ? t("cards.node.specTitle", { name: spec.name, id: spec.id }) : t("cards.fallbackTitle", { label: metaLabel })}>
            <TypeIcon {...ICON_SM} />
          </span>
          <span className="card-title" title={card.title || ""}>
            {card.title || t("cards.fallbackTitle", { label: metaLabel })}
          </span>
          <span className="card-tools">
            <button
              className="card-tool nodrag"
              title={t("cards.node.readTitle")}
              aria-label={t("cards.node.read")}
              onClick={(event) => {
                event.stopPropagation();
                const state = useBoardStore.getState();
                state.setSelection({ kind: "card", id });
                state.openReader(id);
              }}
            >
              <UI.fit size={13} strokeWidth={2} />
            </button>
            <button
              className="card-tool nodrag"
              title={t("cards.node.moreTitle")}
              aria-label={t("cards.node.more")}
              onClick={(event) => {
                event.stopPropagation();
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                data.onMenu(id, rect.left, rect.bottom + 4);
              }}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                <circle cx="13" cy="8" r="1.4" fill="currentColor" />
              </svg>
            </button>
          </span>
        </div>
        <div className="card-body">
          <CardBody card={card} live={live} related={related} onAction={handleAction} />
        </div>
        {editing ? <span className="card-editing-tag">{t("cards.node.editing")}</span> : null}
      </div>
    </>
  );
}

/**
 * 单张卡的悬浮工具条。
 *
 * 取项口径：**右键菜单里最常按的那几个**——改色（一整排色点，一步到位不用二级菜单）、
 * 阅读、加评论、复制、删除。再多就成了第二份右键菜单，而它的价值恰恰在于「短」。
 *
 * 两条不干扰的措施：
 *  · `offset={16}`——四条边都有连线锚点，工具条必须离得够远才不会截胡拖锚点的手势；
 *    offset 是**屏幕像素**（React Flow 在缩放之后才减它），所以任何缩放级别下这段距离恒定。
 *  · 整条 `nodrag nopan`：在工具条上按下去既不该拖走卡片，也不该平移画布。
 */
function CardQuickBar({ cardId, card, visible }: { cardId: string; card: BoardCard; visible: boolean }) {
  const t = useT();
  const enabled = useBoardStore((state) => state.nodeToolbar);
  const run = (fn: () => Promise<unknown> | void) => {
    Promise.resolve(fn()).catch((err: Error) => useBoardStore.getState().showToast(err.message));
  };
  return (
    <SafeNodeToolbar nodeId={cardId} isVisible={enabled && visible} offset={16} className="node-bar nodrag nopan">
      {CARD_COLORS.map((color) => (
        <button
          key={color}
          className={`nb-dot${card.color === color ? " on" : ""}`}
          style={{ background: COLORS[color] }}
          title={t("cards.node.recolorTitle")}
          aria-label={t("cards.node.recolor", { color })}
          data-color={color}
          onClick={() => run(() => useBoardStore.getState().patchCard(cardId, { color: color as CardColor }))}
        />
      ))}
      <span className="nb-sep" />
      <button
        className="nb-btn"
        title={t("cards.node.barReadTitle")}
        aria-label={t("cards.node.read")}
        data-act="bar-read"
        onClick={() => useBoardStore.getState().openReader(cardId)}
      >
        <UI.fit size={14} strokeWidth={2} />
      </button>
      <button
        className="nb-btn"
        title={t("cards.node.barCommentTitle")}
        aria-label={t("cards.node.comment")}
        data-act="bar-comment"
        onClick={(event) => {
          // 输入框开在按下的那颗按钮旁边——它就在卡片上沿，跟评论气泡将来落的位置同一带
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          useBoardStore.getState().startComment({
            target: "card",
            targetId: cardId,
            x: null,
            y: null,
            screen: { x: rect.left, y: rect.bottom + 6 },
          });
        }}
      >
        <UI.commentAdd size={14} strokeWidth={2} />
      </button>
      <button
        className="nb-btn"
        title={t("cards.node.barCopyTitle")}
        aria-label={t("cards.node.copy")}
        data-act="bar-copy"
        onClick={() => void useBoardStore.getState().copyCards([cardId])}
      >
        <UI.copy size={14} strokeWidth={2} />
      </button>
      <button
        className="nb-btn danger"
        title={t("cards.node.barDeleteTitle")}
        aria-label={t("cards.node.delete")}
        data-act="bar-delete"
        onClick={() => void useBoardStore.getState().deleteCardsWithUndo([cardId])}
      >
        <UI.remove size={14} strokeWidth={2} />
      </button>
    </SafeNodeToolbar>
  );
}

export const CardNode = memo(CardNodeInner);
