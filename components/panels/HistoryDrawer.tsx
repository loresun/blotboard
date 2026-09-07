"use client";

/**
 * 历史抽屉：改板安全网的人类入口。
 *
 * 一个抽屉两块内容，而且它们天然是一对：
 *  · **改动记录**（board.activity）—— 这条改了什么、谁改的；
 *  · **历史快照**（checkpoints）—— 这条改动之前那一刻，板长什么样。
 * 记录里的每条都带着它对应的快照 id，所以从「agent 刚才把卡片从 32 张改成 8 张」
 * 一眼就能跳到「那之前的那一份」并原地回滚——不用先猜时间戳再去清单里找。
 *
 * 回滚是覆盖操作，所以走两步确认（第二下才真按），文案直说会覆盖什么。
 */
import { useEffect, useMemo, useState } from "react";
import { formatSize, formatTime } from "@/lib/constants";
import { useT, tr } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import { ICON_MD, ICON_SM, UI } from "@/lib/icons";
import { useBoardStore } from "@/lib/store";
import type { BoardCheckpoint } from "@/lib/api-client";
import type { BoardActivity } from "@/lib/types";

/** 打点原因 / 日志动作的人话（两张表同一套词，见 lib/types.ts 的 BOARD_ACTIVITY_ACTIONS）。 */
const ACTION_LABEL: Record<string, DictKey> = {
  whole: "panels.history.action.whole",
  ingest: "panels.history.action.ingest",
  paste: "panels.history.action.paste",
  tidy: "panels.history.action.tidy",
  patch: "panels.history.action.patch",
  delete: "panels.history.action.delete",
  restore: "panels.history.action.restore",
  template: "panels.history.action.template",
  import: "panels.history.action.import",
};

/** 认不出来的动作直接显示原始值：新加的动作没来得及补词条时，比显示空白好查 */
function actionLabel(t: (key: DictKey) => string, action: string): string {
  const key = ACTION_LABEL[action];
  return key ? t(key) : action;
}

export function HistoryDrawer() {
  const open = useBoardStore((state) => state.drawer === "history");
  const board = useBoardStore((state) => state.board);
  const checkpoints = useBoardStore((state) => state.checkpoints);
  const loading = useBoardStore((state) => state.checkpointsLoading);
  const history = useBoardStore((state) => state.historyState);
  const historyBusy = useBoardStore((state) => state.historyBusy);
  const t = useT();
  const [tab, setTab] = useState<"steps" | "activity" | "snapshots">("steps");
  /** 正在等第二下确认的那一份快照（回滚不可逆，第一下只是把按钮换成「确认覆盖」） */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 从改动记录跳过来时高亮的那份快照 */
  const [highlight, setHighlight] = useState<string | null>(null);

  /**
   * 抽屉打开时才拉清单：快照跟画布上看得见的东西无关，没必要一直跟着轮询走。
   * 但**开着的时候**要跟 —— 依赖里带上 updatedAt：板一变（agent 刚写完、或自己刚回滚过）
   * 就重拉一次，否则抽屉会停在打开那一刻的旧清单上，新打的点看不见。
   * 板没变时轮询只回几十字节的 unchanged，updatedAt 不动，这里也就不会白拉。
   */
  useEffect(() => {
    if (!open) {
      setConfirming(null);
      return;
    }
    void useBoardStore.getState().loadCheckpoints();
    void useBoardStore.getState().loadHistory();
  }, [open, board?.id, board?.updatedAt]);

  const activity: BoardActivity[] = useMemo(() => board?.activity || [], [board?.activity]);
  const items = checkpoints?.items || [];
  const enabled = checkpoints?.enabled !== false;

  async function restore(item: BoardCheckpoint) {
    setBusy(true);
    const state = useBoardStore.getState();
    try {
      await state.restoreCheckpoint(item.stamp);
      state.showToast(tr("panels.history.restored", { time: formatTime(item.at) }));
      setConfirming(null);
    } catch (err) {
      state.showToast(tr("panels.history.restoreFailed", { message: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  async function drop(stamp: string) {
    const state = useBoardStore.getState();
    try {
      await state.removeCheckpoint(stamp);
      state.showToast(tr("panels.history.dropped"));
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  return (
    <div className={`drawer history-drawer${open ? " open" : ""}`}>
      <div className="drawer-head">
        <span className="cd-type">
          <UI.history {...ICON_SM} />
        </span>
        <h2>{t("panels.history.title")}</h2>
        <span className="count">
          {enabled
            ? checkpoints?.keep
              ? t("panels.history.countKeep", { count: items.length, keep: checkpoints.keep })
              : t("panels.history.count", { count: items.length })
            : t("panels.history.off")}
        </span>
        <button className="drawer-close" title={t("common.close")} onClick={() => useBoardStore.getState().setDrawer(null)}>
          <UI.close {...ICON_MD} />
        </button>
      </div>

      <div className="drawer-tabs">
        <button className={tab === "steps" ? "active" : ""} onClick={() => setTab("steps")}>
          {t("panels.history.tab.steps")}{history?.entries.length ? ` ${history.entries.length}` : ""}
        </button>
        <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
          {t("panels.history.tab.activity")}{activity.length ? ` ${activity.length}` : ""}
        </button>
        <button className={tab === "snapshots" ? "active" : ""} onClick={() => setTab("snapshots")}>
          {t("panels.history.tab.snapshots")}{items.length ? ` ${items.length}` : ""}
        </button>
      </div>

      <div className="drawer-body">
        {tab === "steps" ? (
          <>
            <div className="hist-actions" style={{ marginBottom: 14 }}>
              <button className="mini-btn" data-act="history-undo" disabled={historyBusy || !history?.canUndo} onClick={() => void useBoardStore.getState().undoHistory()}>
                <UI.undo size={14} /> {t("panels.history.undo")}
              </button>
              <button className="mini-btn" data-act="history-redo" disabled={historyBusy || !history?.canRedo} onClick={() => void useBoardStore.getState().redoHistory()}>
                {t("panels.history.redo")}
              </button>
            </div>
            <p className="config-hint">{t("panels.history.hint.keys")}</p>
            <p className="config-hint">{t("panels.history.hint.limits")}</p>
            {history?.warning && <p className="hist-warn" role="status">{history.warning}</p>}
            {!history ? <p className="config-hint">{t("panels.history.unavailable")}</p> : history.entries.length ? history.entries.slice().reverse().map((entry) => (
              <div className={`hist-row${entry.applied ? "" : " snap"}`} key={entry.id} data-history-state={entry.applied ? "applied" : "undone"}>
                <div className="hist-head"><span className="hist-action">{entry.label}</span><span className="hist-time">{formatTime(entry.at)}</span></div>
                <div className="hist-text">{entry.applied ? t("panels.history.applied") : t("panels.history.undone")} · {t("panels.history.changes", { count: entry.changes })}</div>
              </div>
            )) : <p className="config-hint">{t("panels.history.steps.empty")}</p>}
          </>
        ) : tab === "activity" ? (
          activity.length ? (
            activity.map((entry, index) => (
              <div key={`${entry.at}-${index}`} className="hist-row">
                <div className="hist-head">
                  <span className={`hist-actor${entry.actor === "agent" ? " agent" : ""}`}>
                    {entry.actor === "agent" ? "agent" : t("panels.actor.me")}
                  </span>
                  <span className="hist-action">{actionLabel(t, entry.action)}</span>
                  <span className="hist-time">{formatTime(entry.at)}</span>
                </div>
                <div className="hist-text">{entry.summary}</div>
                {entry.checkpoint ? (
                  <button
                    className="mini-btn hist-jump"
                    title={t("panels.history.jump.title")}
                    onClick={() => {
                      setTab("snapshots");
                      setHighlight(entry.checkpoint!);
                      setConfirming(null);
                    }}
                  >
                    <UI.undo size={12} strokeWidth={2} /> {t("panels.history.jump")}
                  </button>
                ) : (
                  <span className="hist-nocp" title={t("panels.history.nosnap.title")}>
                    {t("panels.history.nosnap")}
                  </span>
                )}
              </div>
            ))
          ) : (
            <div className="config-hint">{t("panels.history.activity.empty")}</div>
          )
        ) : !enabled ? (
          <div className="config-hint">
            {t("panels.history.disabled.pre")}<code>BLOTBOARD_CHECKPOINT_KEEP=0</code>{t("panels.history.disabled.post")}
          </div>
        ) : items.length ? (
          items.map((item) => (
            <div key={item.stamp} className={`hist-row snap${highlight === item.stamp ? " active" : ""}`}>
              <div className="hist-head">
                <span className="hist-action">{t("panels.history.before", { action: actionLabel(t, item.reason) })}</span>
                <span className="hist-time">{formatTime(item.at)}</span>
              </div>
              <div className="hist-text">
                {t("panels.history.counts", { cards: item.counts.cards, edges: item.counts.edges })}
                {item.counts.comments ? ` · ${t("panels.history.counts.comments", { comments: item.counts.comments })}` : ""} · {formatSize(item.bytes)}
              </div>
              <div className="hist-actions">
                {confirming === item.stamp ? (
                  <>
                    <span className="hist-warn">{t("panels.history.rollback.warn")}</span>
                    <button className="mini-btn" disabled={busy} onClick={() => setConfirming(null)}>
                      {t("panels.history.rollback.cancel")}
                    </button>
                    <button className="mini-btn primary" disabled={busy} onClick={() => void restore(item)}>
                      {t("panels.history.rollback.confirm")}
                    </button>
                  </>
                ) : (
                  <>
                    <button className="mini-btn" onClick={() => setConfirming(item.stamp)}>
                      <UI.undo size={12} strokeWidth={2} /> {t("panels.history.rollback")}
                    </button>
                    <button className="mini-btn danger" title={t("panels.history.drop.title")} onClick={() => void drop(item.stamp)}>
                      <UI.remove size={12} strokeWidth={2} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        ) : (
          <div className="config-hint">
            {loading ? t("panels.history.loadingSnapshots") : t("panels.history.snapshots.empty")}
          </div>
        )}
      </div>
    </div>
  );
}
