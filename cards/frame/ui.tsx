"use client";

/**
 * 分组框的卡面。
 *
 * 它跟别的卡面正好相反：**这张卡的正文是空的**——框里那些卡是画布上另外的节点，
 * 由 React Flow 用 `parentId` 摆在框上面（见 components/BoardCanvas.tsx 的节点构建）。
 * 所以这里只负责三件事：报一下框里有几张卡，给一颗折叠按钮，
 * 以及在「看着圈住了、归属上没有」时把差额说出来并给一颗收纳按钮。
 *
 * 折叠时子节点整批 `hidden`，框上只剩计数——「先把这一摊收起来」是大板上最常做的动作。
 *
 * 为什么要有那颗收纳按钮：归属的真源只有子卡的 `frameId`，而拖动、批量导入、
 * 整板改写都可能让「视觉上在框里」和「frameId」对不上。系统**不会**因为两个矩形重叠
 * 就替你改归属（那是悄悄改数据），但它应该把差额摆到明面上，并让你一键补齐。
 */
import { useMemo } from "react";
import { useBoardStore } from "@/lib/store";
import { boardEditSignature } from "@/lib/history-content";
import { UI } from "@/lib/icons";
import { frameCandidateIds } from "@/lib/frames";
import { cardSnippet } from "@/lib/search-text";
import { useCardLabel, useT, tr } from "@/lib/i18n/client";
import type { CardPackUi } from "@/lib/card-pack-client";

/**
 * 收一次「框里但没归属」的自由卡。批量口 = 服务端先打快照 + 记一条工作日志，
 * 所以提示里给得起一颗「撤销」（跟顶栏整理完那颗是同一条路）。
 */
async function captureInto(frameId: string) {
  const state = useBoardStore.getState();
  const boardId = state.boardId;
  if (!boardId) return;
  try {
    const captured = await state.captureFrameCards(frameId);
    if (!captured) {
      state.showToast(tr("cards.frame.captureNone"));
      return;
    }
    // 撤销的「过期判定」认的是**写完之后**那一版：中间又有人改过板子，这颗撤销就不该再动手
    //（跟顶栏「整理」完那颗撤销同一套，见 components/TopBar.tsx 的 tidy）
    const savedRevision = useBoardStore.getState().board?.updatedAt || 0;
    const savedContent = boardEditSignature(useBoardStore.getState().board);
    useBoardStore
      .getState()
      .showToast(tr("cards.frame.captureDone", { count: captured }), {
        label: tr("cards.frame.captureUndo"),
        run: () => void useBoardStore.getState().undoHistoryIfCurrent(boardId, savedRevision, savedContent),
      });
  } catch (err) {
    useBoardStore.getState().showToast((err as Error).message);
  }
}

/** 现有成员数与「圈住了但没归属」的候选数——两个数都现算，框里不存成员名单 */
function useFrameTally(frameId: string) {
  const cards = useBoardStore((state) => state.board?.cards);
  return useMemo(
    () => ({
      members: (cards || []).filter((item) => item.frameId === frameId).length,
      loose: frameCandidateIds(cards, frameId).length,
    }),
    [cards, frameId],
  );
}

function FrameFace({ card, onAction }: { card: { id: string; frame?: { collapsed: boolean } }; onAction: (action: "toggle-frame") => void }) {
  const t = useT();
  // 成员数现算：真源永远是子卡身上的 frameId，框里不存一份成员名单
  //（存了就会跟「卡被删了 / 被拖出去了」不同步，那是又一处要维护的一致性）
  const { members, loose } = useFrameTally(card.id);
  const collapsed = card.frame?.collapsed === true;
  return (
    <div className="frame-face nodrag">
      <button
        className="frame-toggle"
        title={collapsed ? t("cards.frame.expandTitle") : t("cards.frame.collapseTitle")}
        onClick={(event) => {
          event.stopPropagation();
          onAction("toggle-frame");
        }}
      >
        {collapsed ? <UI.chevron size={13} strokeWidth={2} /> : <UI.chevron size={13} strokeWidth={2} className="turned" />}
        {collapsed ? t("cards.frame.expand") : t("cards.frame.collapse")}
      </button>
      <span className="frame-count">{members ? t("cards.frame.count", { count: members }) : t("cards.frame.dropHint")}</span>
      {/* 差额只在真有差额时出现：平时这颗按钮一点存在感都不该有 */}
      {loose ? (
        <button
          className="frame-capture"
          data-act="capture-frame"
          title={t("cards.frame.capture.title", { count: loose })}
          onClick={(event) => {
            event.stopPropagation();
            void captureInto(card.id);
          }}
        >
          <UI.add size={12} strokeWidth={2.2} />
          {t("cards.frame.capture", { count: loose })}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 摊开看：框自己没有正文，所以这里回答的是「这个框里都圈了什么」——
 * 通用兜底只会说「这张卡还没有正文」，对一个容器来说等于什么都没说。
 *
 * 阅读模式翻到一个**空框**是最容易让人以为「板子坏了」的一幕，
 * 所以空框这里不只说「空的」，还要说清楚「是真空着，还是圈住了却没归属」。
 */
function FrameFullView({ card }: { card: { id: string; title?: string } }) {
  const t = useT();
  const cardLabel = useCardLabel();
  // Zustand 的 selector 必须返回稳定快照。直接在 selector 里 filter 会每次
  // 生成新数组，React 19 会把它当成快照持续变化，打开以分组框开头的阅读
  // 模式时触发 React #185（Maximum update depth exceeded）。
  const cards = useBoardStore((state) => state.board?.cards);
  const members = useMemo(
    () => (cards || []).filter((item) => item.frameId === card.id),
    [cards, card.id],
  );
  const loose = useMemo(() => frameCandidateIds(cards, card.id).length, [cards, card.id]);
  return (
    <div className="reader-text">
      <p className="hint">
        {t(card.title ? "cards.frame.summaryNamed" : "cards.frame.summary", { name: card.title || "", count: members.length })}
      </p>
      {members.length ? (
        <ul className="frame-members">
          {members.map((item) => (
            <li key={item.id}>
              <span className="frame-member-type">{cardLabel(item.type)}</span>
              {cardSnippet(item, "", 40) || t("cards.frame.untitled")}
            </li>
          ))}
        </ul>
      ) : (
        <span className="placeholder">{t("cards.frame.emptyHint")}</span>
      )}
      {loose ? (
        <p className="frame-loose">
          <span>{t("cards.frame.looseHint", { count: loose })}</span>
          <button className="mini-btn" data-act="capture-frame" onClick={() => void captureInto(card.id)}>
            {t("cards.frame.capture", { count: loose })}
          </button>
        </p>
      ) : null}
    </div>
  );
}

export const ui: CardPackUi = {
  CardFace: ({ card, onAction }) => <FrameFace card={card} onAction={onAction as (action: "toggle-frame") => void} />,
  FullView: ({ card }) => <FrameFullView card={card} />,
  toolbar: {
    title: "分组框：把几张卡圈进一个框，整体拖动、可折叠（跟子画板卡不同——框是就地圈一块地，不下钻）",
    group: 3,
    order: 30,
    onClick: (ctx) => ctx.add("frame"),
  },
};
