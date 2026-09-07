"use client";

/**
 * 评论抽屉：这块板上所有批注的清单。
 *
 * 画布上的气泡回答「哪儿有意见」，这里回答「一共还有多少事没落实」——
 * 所以默认档是**未解决**，已解决的退到「已解决」页当档案。
 * 每条评论都能定位回它挂着的那张卡 / 那条线，读到一条就能立刻跳过去改。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { formatTime } from "@/lib/constants";
import { useT, tr } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import { ICON_MD, ICON_SM, UI, typeIcon } from "@/lib/icons";
import { useBoardStore, type CommentFilter } from "@/lib/store";
import type { BoardComment, BoardDetail } from "@/lib/types";

const FILTERS: [CommentFilter, DictKey][] = [
  ["open", "panels.comment.filter.open"],
  ["resolved", "panels.comment.filter.resolved"],
  ["all", "panels.comment.filter.all"],
];

type Translate = (key: DictKey, vars?: Record<string, string | number>) => string;

/** 这条评论挂在哪：卡片给标题，连线给「A → B」，画布评论直说是画布。 */
function describeTarget(
  t: Translate,
  board: BoardDetail | null,
  comment: BoardComment,
): { label: string; icon: typeof UI.comment } {
  if (comment.target === "card") {
    const card = (board?.cards || []).find((item) => item.id === comment.targetId);
    if (!card) return { label: t("panels.comment.target.cardGone"), icon: UI.ban };
    return { label: card.title || t("panels.comment.target.cardOfType", { type: card.type }), icon: typeIcon(card.type) };
  }
  if (comment.target === "edge") {
    const edge = (board?.edges || []).find((item) => item.id === comment.targetId);
    if (!edge) return { label: t("panels.comment.target.edgeGone"), icon: UI.ban };
    const byId = new Map((board?.cards || []).map((card) => [card.id, card]));
    const from = byId.get(edge.from)?.title || edge.from;
    const to = byId.get(edge.to)?.title || edge.to;
    return { label: `${from} → ${to}`, icon: UI.relations };
  }
  return {
    label: comment.x === null ? t("panels.comment.target.board") : t("panels.comment.target.spot"),
    icon: UI.pin,
  };
}

export function CommentDrawer() {
  const open = useBoardStore((state) => state.drawer === "comments");
  const board = useBoardStore((state) => state.board);
  const filter = useBoardStore((state) => state.commentFilter);
  const activeCommentId = useBoardStore((state) => state.activeCommentId);
  const showComments = useBoardStore((state) => state.showComments);
  const flow = useReactFlow();
  const t = useT();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const comments = useMemo(() => {
    const all = [...(board?.comments || [])];
    const picked = all.filter((comment) =>
      filter === "all" ? true : filter === "open" ? !comment.resolved : comment.resolved,
    );
    // 最新的在上：评论是「刚想到要改的东西」，不是编年史
    return picked.sort((a, b) => b.createdAt - a.createdAt);
  }, [board?.comments, filter]);

  const openCount = (board?.comments || []).filter((comment) => !comment.resolved).length;

  // 从画布气泡点进来的那条要能直接看到：滚到它，亮一下，再自己退回去——
  // 高亮是「你点的是这条」的回执，不该一直挂着抢注意力
  useEffect(() => {
    if (!open || !activeCommentId) return;
    const container = listRef.current;
    const node = container?.querySelector<HTMLElement>(`[data-comment="${activeCommentId}"]`);
    if (container && node) {
      /**
       * 只滚这一只列表，不用 scrollIntoView——后者会把**每一个**可滚动祖先都滚一遍，
       * 而这个页面的祖先是能横向滚的（收起的抽屉把 .main 的 scrollWidth 撑到了 1640），
       * 一旦真滚起来，左栏就被推出屏幕。滚一只列表就够了，别把整页也带上。
       */
      const offset =
        node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({
        top: Math.max(0, offset - container.clientHeight / 2 + node.offsetHeight / 2),
        behavior: "smooth",
      });
    }
    const timer = setTimeout(() => useBoardStore.getState().setActiveComment(null), 2200);
    return () => clearTimeout(timer);
  }, [open, activeCommentId, comments.length]);

  useEffect(() => {
    if (!open) setComposing(false);
  }, [open]);

  /** 定位：卡片走画布现成的「定位 + 闪一下」，连线 / 画布钉点直接把视口挪过去。 */
  function locate(comment: BoardComment) {
    const state = useBoardStore.getState();
    if (comment.target === "card" && comment.targetId) {
      state.requestFocus(comment.targetId);
      state.setSelection({ kind: "card", id: comment.targetId });
      return;
    }
    if (comment.target === "edge" && comment.targetId) {
      const edge = (state.board?.edges || []).find((item) => item.id === comment.targetId);
      const byId = new Map((state.board?.cards || []).map((card) => [card.id, card]));
      const from = edge ? byId.get(edge.from) : null;
      const to = edge ? byId.get(edge.to) : null;
      if (from && to) {
        flow.setCenter((from.x + from.w / 2 + to.x + to.w / 2) / 2, (from.y + from.h / 2 + to.y + to.h / 2) / 2, {
          zoom: flow.getZoom(),
          duration: 320,
        });
      }
      return;
    }
    if (comment.x !== null && comment.y !== null) {
      flow.setCenter(comment.x, comment.y, { zoom: flow.getZoom(), duration: 320 });
    }
  }

  async function publishBoardComment() {
    const text = draft.trim();
    if (!text) return;
    const state = useBoardStore.getState();
    try {
      // 抽屉里建的是整板留言：不钉在画布任何一点上（钉哪儿都是瞎猜）
      await state.addComment({ target: "board", targetId: null, text, x: null, y: null });
      setDraft("");
      setComposing(false);
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  return (
    <div className={`drawer comment-drawer${open ? " open" : ""}`}>
      <div className="drawer-head">
        <span className="cd-type">
          <UI.comment {...ICON_SM} />
        </span>
        <h2>{t("panels.comment.title")}</h2>
        <span className="count">
          {openCount ? t("panels.comment.pending", { count: openCount }) : t("panels.comment.allDone")}
        </span>
        <span className="foot-spacer" />
        <button
          className="drawer-close"
          title={showComments ? t("panels.comment.pins.hide") : t("panels.comment.pins.show")}
          onClick={() => useBoardStore.getState().toggleCommentPins()}
        >
          {showComments ? <UI.eye {...ICON_MD} /> : <UI.eyeOff {...ICON_MD} />}
        </button>
        <button className="drawer-close" title={t("common.close")} onClick={() => useBoardStore.getState().setDrawer(null)}>
          <UI.close {...ICON_MD} />
        </button>
      </div>

      <div className="drawer-tabs">
        {FILTERS.map(([key, labelKey]) => (
          <button
            key={key}
            className={filter === key ? "active" : ""}
            onClick={() => useBoardStore.getState().setCommentFilter(key)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      <div className="drawer-body" ref={listRef}>
        {composing ? (
          <div className="comment-thread composing">
            <textarea
              autoFocus
              value={draft}
              placeholder={t("panels.comment.compose.placeholder")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void publishBoardComment();
                }
              }}
            />
            <div className="ct-actions">
              <span className="ct-hint">{t("panels.comment.compose.hint")}</span>
              <button className="mini-btn" onClick={() => setComposing(false)}>
                {t("common.cancel")}
              </button>
              <button className="mini-btn primary" disabled={!draft.trim()} onClick={publishBoardComment}>
                {t("panels.comment.publish")}
              </button>
            </div>
          </div>
        ) : (
          <button className="mini-btn comment-new" onClick={() => setComposing(true)}>
            <UI.add size={13} strokeWidth={2} /> {t("panels.comment.new")}
          </button>
        )}

        {comments.length ? (
          comments.map((comment) => (
            <CommentThread
              key={comment.id}
              comment={comment}
              board={board}
              active={comment.id === activeCommentId}
              onLocate={() => locate(comment)}
            />
          ))
        ) : (
          <div className="config-hint" style={{ marginTop: 14 }}>
            {filter === "open" ? t("panels.comment.empty.open") : t("panels.comment.empty.other")}
          </div>
        )}
      </div>
    </div>
  );
}

function CommentThread({
  comment,
  board,
  active,
  onLocate,
}: {
  comment: BoardComment;
  board: BoardDetail | null;
  active: boolean;
  onLocate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.text);
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const t = useT();
  const target = describeTarget(t, board, comment);
  const TargetIcon = target.icon;

  // 别的窗口 / agent 改了这条正文时跟上（没在改它的时候才跟，不然会把手里的草稿冲掉）
  useEffect(() => {
    if (!editing) setText(comment.text);
  }, [comment.text, editing]);

  const run = (fn: () => Promise<unknown>) => {
    fn().catch((err: Error) => useBoardStore.getState().showToast(err.message));
  };

  return (
    <div
      className={`comment-thread${active ? " active" : ""}${comment.resolved ? " resolved" : ""}`}
      data-comment={comment.id}
    >
      <div className="ct-head">
        <button className="ct-target" title={t("panels.comment.locate")} onClick={onLocate}>
          <TargetIcon size={12} strokeWidth={2} />
          <span>{target.label}</span>
        </button>
        <span className="ct-meta">
          {comment.createdBy === "agent" ? "agent" : t("panels.actor.me")} · {formatTime(comment.createdAt)}
        </span>
      </div>

      {editing ? (
        <textarea
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              run(async () => {
                await useBoardStore.getState().editComment(comment.id, text.trim());
                setEditing(false);
              });
            }
            if (event.key === "Escape") {
              setText(comment.text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <div className="ct-text">{comment.text}</div>
      )}

      {(comment.replies || []).length ? (
        <div className="ct-replies">
          {comment.replies.map((item) => (
            <div key={item.id} className="ct-reply">
              <UI.reply size={12} strokeWidth={2} />
              <div>
                <span className="ct-meta">
                  {item.createdBy === "agent" ? "agent" : t("panels.actor.me")} · {formatTime(item.createdAt)}
                </span>
                <div className="ct-text">{item.text}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {replying ? (
        <div className="ct-reply-box">
          <textarea
            autoFocus
            value={reply}
            placeholder={t("panels.comment.reply.placeholder")}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                if (!reply.trim()) return;
                run(async () => {
                  await useBoardStore.getState().replyComment(comment.id, reply.trim());
                  setReply("");
                  setReplying(false);
                });
              }
              if (event.key === "Escape") setReplying(false);
            }}
          />
        </div>
      ) : null}

      <div className="ct-actions">
        {editing ? (
          <>
            <button className="mini-btn" onClick={() => (setText(comment.text), setEditing(false))}>
              {t("common.cancel")}
            </button>
            <button
              className="mini-btn primary"
              disabled={!text.trim()}
              onClick={() =>
                run(async () => {
                  await useBoardStore.getState().editComment(comment.id, text.trim());
                  setEditing(false);
                })
              }
            >
              {t("common.save")}
            </button>
          </>
        ) : (
          <>
            <button
              className={`mini-btn${comment.resolved ? "" : " primary"}`}
              title={comment.resolved ? t("panels.comment.reopen.title") : t("panels.comment.resolve.title")}
              onClick={() => run(() => useBoardStore.getState().resolveComment(comment.id, !comment.resolved))}
            >
              {comment.resolved ? (
                <>
                  <UI.undo size={13} strokeWidth={2} /> {t("panels.comment.reopen")}
                </>
              ) : (
                <>
                  <UI.check size={13} strokeWidth={2.4} /> {t("panels.comment.resolve")}
                </>
              )}
            </button>
            <button className="mini-btn" onClick={() => setReplying((value) => !value)}>
              <UI.reply size={13} strokeWidth={2} /> {t("panels.comment.reply")}
            </button>
            <button className="mini-btn" title={t("panels.comment.edit")} onClick={() => setEditing(true)}>
              <UI.edit size={13} strokeWidth={2} />
            </button>
            <button
              className="mini-btn danger"
              title={t("panels.comment.remove")}
              onClick={() => {
                if (!window.confirm(tr("panels.comment.remove.confirm"))) return;
                run(() => useBoardStore.getState().removeComment(comment.id));
              }}
            >
              <UI.remove size={13} strokeWidth={2} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
