"use client";

/**
 * 卡片编辑抽屉：双击卡片就在右侧展开，正文有整屏高度可写。
 *
 * 以前是「卡面里就地编辑」——卡片只有 280px 宽，写长正文得先把卡拉大，写完还要拉回去。
 * 现在卡面只负责展示，编辑一律在这里；卡片本身仍高亮，方便对照画布上下游。
 *
 * 写盘全部串行走一条链：自动保存和显式提交可能挨得很近，而 patchCard 要带上手上那一版的
 * updatedAt 做并发校验——并发发两次，后一次拿的是落库前的旧版本号，会被判 stale 白跑一趟。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CardEditor, type CardPatch } from "../cards/CardEditor";
import { api } from "@/lib/api-client";
import { useCardLabel, useT, tr } from "@/lib/i18n/client";
import { ICON_MD, ICON_SM, UI, typeIcon } from "@/lib/icons";
import { cardDeepLink } from "@/lib/origins";
import { useBoardStore } from "@/lib/store";

type SaveState = "idle" | "saving" | "saved";

export function CardDrawer() {
  const open = useBoardStore((state) => state.drawer === "card");
  const editingCardId = useBoardStore((state) => state.editingCardId);
  const board = useBoardStore((state) => state.board);
  const boardId = useBoardStore((state) => state.boardId);
  /**
   * 只有这只抽屉真的开着才认这张卡。
   * 导图 / Excalidraw 卡的 editingCardId 也是设着的（它们走全屏弹窗，drawer 是别的值），
   * 收起状态下还挂着编辑器的话，弹窗里改的标题会被这边过时的草稿自动存回去——
   * 自动保存之前这只是个看不见的空壳，现在它会写盘，就必须真正卸掉。
   */
  const card = open && editingCardId ? board?.cards.find((item) => item.id === editingCardId) || null : null;
  const t = useT();
  const typeLabel = useCardLabel();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  // 卡片被删（或换了画板）时抽屉自己收起来，别留一个指向不存在卡片的空壳
  useEffect(() => {
    if (open && editingCardId && board && !card) useBoardStore.getState().setEditing(null);
  }, [open, editingCardId, board, card]);

  // 换一张卡就把上一张的「已保存」收掉，免得看着像是这张卡刚存过
  useEffect(() => setSaveState("idle"), [editingCardId]);

  /** 串行写一次盘。返回排到自己后面的那截链，调用方要等就 await 它。 */
  const write = useCallback((cardId: string, patch: CardPatch) => {
    setSaveState("saving");
    chain.current = chain.current
      .catch(() => undefined)
      .then(async () => {
        const state = useBoardStore.getState();
        try {
          await state.patchCard(cardId, patch as Record<string, unknown>);
          setSaveState("saved");
        } catch (err) {
          setSaveState("idle");
          state.showToast((err as Error).message);
        }
      });
    return chain.current;
  }, []);

  const autoSave = useCallback((cardId: string, patch: CardPatch) => void write(cardId, patch), [write]);

  /**
   * 转过 Issue 的卡片：提交那一下把最新正文推给 Goal Agent。
   *
   * 服务端本来就有一条防抖的自动同步兜底（自动保存、agent 改卡、加评论都算在内），
   * 这里显式推一次是为了「合上抽屉那一刻就已经推过去了」，并且当场说一声结果 ——
   * 之后再去发起任务，跑的一定是画板上的这一版，而不是转 Issue 时的那一版。
   */
  const pushIssue = useCallback(async (boardKey: string, cardId: string) => {
    const state = useBoardStore.getState();
    try {
      const result = await api.syncCardIssue(boardKey, cardId);
      state.absorbCard(result.card, result);
      // 服务端那条防抖同步可能已经先推过同一版了（那时 synced=false），不必再报一次
      if (result.synced) state.showToast(tr("panels.card.issueSynced"));
    } catch (err) {
      state.showToast(tr("panels.card.issueSyncFailed", { message: (err as Error).message }));
    }
  }, []);

  const commit = useCallback(
    async (patch: CardPatch) => {
      const cardId = useBoardStore.getState().editingCardId;
      if (!cardId) return;
      await write(cardId, patch);
      const state = useBoardStore.getState();
      const saved = state.board?.cards.find((item) => item.id === cardId);
      // 先合抽屉：同步是一次网络往返，不该让它吊着关闭动作（Runner 不通时更明显）
      state.setEditing(null);
      if (saved?.task?.issueId && state.boardId) void pushIssue(state.boardId, cardId);
    },
    [write, pushIssue],
  );

  const TypeIcon = card ? typeIcon(card.type) : null;

  return (
    <div className={`drawer card-drawer${open ? " open" : ""}`}>
      <div className="drawer-head">
        {TypeIcon ? (
          <span className="cd-type">
            <TypeIcon {...ICON_SM} />
          </span>
        ) : null}
        <h2>{card ? t("panels.card.title", { type: typeLabel(card.type) }) : t("panels.card.title.empty")}</h2>
        {card && saveState !== "idle" ? (
          <span className={`save-chip${saveState === "saved" ? " done" : ""}`} title={t("panels.card.autosave.title")}>
            {saveState === "saving" ? <UI.pending size={12} strokeWidth={2} /> : <UI.check size={12} strokeWidth={3} />}
            {saveState === "saving" ? t("panels.card.saving") : t("panels.card.saved")}
          </span>
        ) : null}
        <span className="foot-spacer" />
        {card && boardId ? (
          <button
            className="drawer-close"
            title={t("panels.card.copyLink")}
            onClick={async () => {
              await navigator.clipboard.writeText(cardDeepLink(boardId, card.id));
              useBoardStore.getState().showToast(tr("panels.card.linkCopied"));
            }}
          >
            <UI.copy {...ICON_MD} />
          </button>
        ) : null}
        <button
          className="drawer-close"
          title={t("panels.card.close")}
          onClick={() => useBoardStore.getState().setEditing(null)}
        >
          <UI.close {...ICON_MD} />
        </button>
      </div>
      <div className="drawer-body">
        {card ? (
          <CardEditor
            key={card.id}
            card={card}
            variant="drawer"
            onCommit={commit}
            onAutoSave={autoSave}
            onCancel={() => useBoardStore.getState().setEditing(null)}
          />
        ) : (
          <div className="config-hint">{t("panels.card.empty")}</div>
        )}
      </div>
    </div>
  );
}
