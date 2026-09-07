"use client";

/**
 * 画布上的评论层：气泡 + 「正在写」的输入框。
 *
 * 气泡走 React Flow 的 ViewportPortal（挂进被变换的那层 div，所以跟着卡片一起平移缩放），
 * 但自身按 1/zoom 反向缩放——缩到 30% 时气泡还是原来那么大。
 * 不这么做的话，缩远了看整块板正是最需要「哪儿有意见」的时候，气泡却小成了一个像素点。
 *
 * 输入框反过来：钉在**打开它那一刻**的屏幕坐标上，不进 ViewportPortal。
 * 它是转瞬即逝的浮层，跟着视口做仿射变换只会在打字时抖。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ViewportPortal, useStore as useFlowStore } from "@xyflow/react";
import { ICON_SM, UI } from "@/lib/icons";
import type { DictKey } from "@/lib/i18n";
import { tr, useT } from "@/lib/i18n/client";
import { commentPins, useBoardStore, type CommentDraft } from "@/lib/store";

export function CommentLayer() {
  const t = useT();
  const board = useBoardStore((state) => state.board);
  const showComments = useBoardStore((state) => state.showComments);
  const draft = useBoardStore((state) => state.commentDraft);
  const activeCommentId = useBoardStore((state) => state.activeCommentId);
  // 只订阅 zoom：平移时这一层不用重算（transform 由 React Flow 那层 div 统一做了）
  const zoom = useFlowStore((state) => state.transform[2]);

  const pins = useMemo(() => commentPins(board), [board]);

  return (
    <>
      {showComments && pins.length ? (
        <ViewportPortal>
          {pins.map((pin) => {
            const first = pin.comments[0];
            const active = pin.comments.some((comment) => comment.id === activeCommentId);
            const preview = pin.comments
              .map((comment) =>
                t("canvas.comment.pin.line", {
                  who: comment.createdBy === "agent" ? "agent" : t("canvas.comment.pin.me"),
                  text: comment.text,
                }),
              )
              .join("\n");
            return (
              <button
                key={pin.key}
                type="button"
                className={`comment-pin${active ? " active" : ""}`}
                style={{
                  transform: `translate(${pin.x}px, ${pin.y}px) scale(${1 / zoom})`,
                  transformOrigin: "top left",
                }}
                title={preview}
                onClick={(event) => {
                  event.stopPropagation();
                  useBoardStore.getState().openComments(first.id);
                }}
              >
                <UI.comment size={13} strokeWidth={2.1} />
                {pin.comments.length > 1 ? <span className="cp-count">{pin.comments.length}</span> : null}
              </button>
            );
          })}
        </ViewportPortal>
      ) : null}

      {draft ? <CommentComposer draft={draft} /> : null}
    </>
  );
}

const TARGET_LABEL: Record<CommentDraft["target"], DictKey> = {
  card: "canvas.comment.target.card",
  edge: "canvas.comment.target.edge",
  board: "canvas.comment.target.board",
};

function CommentComposer({ draft }: { draft: CommentDraft }) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [position, setPosition] = useState({ left: draft.screen.x, top: draft.screen.y });

  // 跟右键菜单同一套避让：贴着窗口右/下边缘打开时整体挪回来，别把发布按钮顶出屏幕
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(draft.screen.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(draft.screen.y, window.innerHeight - rect.height - 8)),
    });
    areaRef.current?.focus();
  }, [draft]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      // 写了一半点到别处：留着草稿会更烦（它会一直浮在那儿），直接收掉
      useBoardStore.getState().cancelComment();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  async function publish() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    const state = useBoardStore.getState();
    try {
      const comment = await state.addComment({
        target: draft.target,
        targetId: draft.targetId,
        text: body,
        x: draft.x,
        y: draft.y,
      });
      state.showToast(tr("canvas.toast.commentAdded"), {
        label: tr("canvas.toast.commentAdded.view"),
        run: () => useBoardStore.getState().openComments(comment.id),
      });
    } catch (err) {
      setBusy(false);
      state.showToast((err as Error).message);
    }
  }

  return (
    <div
      ref={ref}
      className="comment-composer"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="cc-head">
        <UI.commentAdd {...ICON_SM} />
        <span>{t("canvas.comment.head", { target: t(TARGET_LABEL[draft.target]) })}</span>
      </div>
      <textarea
        ref={areaRef}
        value={text}
        placeholder={t("canvas.comment.placeholder")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            useBoardStore.getState().cancelComment();
            return;
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void publish();
          }
        }}
      />
      <div className="cc-foot">
        <span className="cc-hint">{t("canvas.comment.foot")}</span>
        <button type="button" className="mini-btn" onClick={() => useBoardStore.getState().cancelComment()}>
          {t("common.cancel")}
        </button>
        <button type="button" className="mini-btn primary" disabled={!text.trim() || busy} onClick={publish}>
          {t("canvas.comment.publish")}
        </button>
      </div>
    </div>
  );
}
