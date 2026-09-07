"use client";

/**
 * 大纲视图：同一块板的**一维读法**。
 *
 * 画布擅长「东西之间是什么关系」，不擅长「从头到尾通读一遍」和「一口气改十个标题」——
 * 后两件事在画布上都得一张张点开、一张张关掉。大纲把整块板摊成一列文本：
 * 阅读顺序排版（跟阅读模式同一条顺序）、按连线的上下游缩进（见 lib/outline.ts）、
 * 关键词过滤，行内直接改标题与正文。
 *
 * 三条实现上的取舍：
 * 1. **不新开路由**，是盖在画布上的一层——画布不卸载，所以点某一行就能顺手
 *    `requestFocus` 把视口挪过去，切回画布时视野正停在你刚看的那张卡上；
 * 2. **不另建保存通道**：行内编辑走的就是 `patchCard`，节奏也照抄卡片编辑器的
 *    「停手 800ms 存一次」（见 components/cards/CardEditor.tsx）；
 * 3. 键盘是主路径：↑/↓ 走行、Enter 进编辑、Esc 退出编辑（再按一次退出大纲）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ICON_SM, UI, typeIcon } from "@/lib/icons";
import { useCardLabel, useT } from "@/lib/i18n/client";
import { cardSearchParts } from "@/lib/search-text";
import { outlineRows } from "@/lib/outline";
import { cardMatches, useBoardStore } from "@/lib/store";
import type { BoardCard } from "@/lib/types";

/**
 * 行尾那段摘要：**只取标题以外的内容**。
 *
 * 直接用 cardSnippet 会把标题原样再抄一遍（它的第一个检索片段就是标题），
 * 一行里出现两遍同样的字纯属占地方。带关键词时在命中处开窗，看得见为什么命中。
 */
function bodySnippet(card: BoardCard, keyword: string): string {
  const parts = cardSearchParts(card).filter((part) => part && part !== card.title);
  const key = keyword.trim().toLowerCase();
  for (const part of key ? parts : []) {
    const at = part.toLowerCase().indexOf(key);
    if (at < 0) continue;
    const from = Math.max(0, at - 40);
    const to = Math.min(part.length, at + key.length + 60);
    const clipped = part.slice(from, to).replace(/\s+/g, " ").trim();
    return `${from > 0 ? "…" : ""}${clipped}${to < part.length ? "…" : ""}`;
  }
  const first = (parts[0] || "").replace(/\s+/g, " ").trim();
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

/** 一层缩进多少像素：小到不浪费横向空间，大到一眼看得出层级 */
const INDENT = 18;
/** 与卡片编辑器同一个节奏：停手 800ms 存一次 */
const AUTOSAVE_MS = 800;

export function OutlineView() {
  const t = useT();
  const viewMode = useBoardStore((state) => state.viewMode);
  const cards = useBoardStore((state) => state.board?.cards);
  const edges = useBoardStore((state) => state.board?.edges);
  const selection = useBoardStore((state) => state.selection);

  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => outlineRows(cards || [], edges || []), [cards, edges]);
  const keyword = query.trim().toLowerCase();
  /**
   * 过滤只筛行、**不重算层级**：命中的行保留它原来的缩进，
   * 这样「这条命中的在整块板的哪个位置」一眼还看得出来。
   */
  const visible = useMemo(
    // 命中口径直接复用画布搜索那一套（cardMatches）：同一个词在大纲里和在画布上命中同一批卡
    () => (keyword ? rows.filter((row) => cardMatches(row.card, query, [])) : rows),
    [rows, keyword, query],
  );

  const currentId = selection?.kind === "card" ? selection.id : null;
  const index = currentId ? visible.findIndex((row) => row.card.id === currentId) : -1;

  /** 选中某一行：画布上同步选中并把视口挪过去（画布没卸载，切回去就正停在这张） */
  const pick = useCallback((cardId: string) => {
    const state = useBoardStore.getState();
    state.setSelection({ kind: "card", id: cardId });
    state.requestFocus(cardId);
  }, []);

  /** 上下走行；越界不绕回（到头停住比跳到另一端更容易知道自己在哪） */
  const step = useCallback(
    (delta: number) => {
      if (!visible.length) return;
      const at = index < 0 ? (delta > 0 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, index + delta));
      pick(visible[at].card.id);
    },
    [index, visible, pick],
  );

  /* 选中行滚进视野：键盘走到看不见的地方要自己露出来 */
  useEffect(() => {
    if (viewMode === "outline") activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [viewMode, currentId]);

  /* 退出大纲时把没提交的编辑态收掉，免得下次进来还挂着一个上次的输入框 */
  useEffect(() => {
    if (viewMode !== "outline") setEditingId(null);
  }, [viewMode]);

  if (viewMode !== "outline") return null;

  const total = rows.length;

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const inField = (event.target as HTMLElement)?.closest?.("input, textarea");
    if (event.key === "Escape") {
      event.preventDefault();
      // 先退编辑，再退大纲：正在打字时按 Esc 想的是「别改了」，不是「关掉整个视图」
      if (editingId) setEditingId(null);
      else useBoardStore.getState().setViewMode("canvas");
      // 焦点交回列表，接着还能用 ↑/↓
      listRef.current?.focus();
      return;
    }
    // 正文框里的 ↑/↓ 是在文本里挪光标，不该抢来走行
    if (inField) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
      return;
    }
    if (event.key === "Enter" && currentId) {
      event.preventDefault();
      setEditingId(currentId);
    }
  }

  return (
    <div className="outline-view" data-view="outline">
      <div className="ov-head">
        <UI.outlineView size={15} strokeWidth={1.8} />
        <b>{t("pages.outline.title")}</b>
        <input
          className="ov-filter"
          data-field="outline.filter"
          type="search"
          value={query}
          placeholder={t("pages.outline.filter")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Escape") {
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
        <span className="ov-count" data-role="outline-count">
          {keyword ? (
            <>
              <b>{visible.length}</b> / {total}
            </>
          ) : (
            <>
              <b>{total}</b>{t("pages.outline.countSuffix")}
            </>
          )}
        </span>
        <span className="ov-hint">{t("pages.outline.hint")}</span>
        <button
          className="ov-back"
          data-act="outline-exit"
          title={t("pages.outline.back.title")}
          onClick={() => useBoardStore.getState().setViewMode("canvas")}
        >
          <UI.back {...ICON_SM} /> {t("pages.outline.back")}
        </button>
      </div>

      {/* tabIndex 让整列可聚焦：键盘是这个视图的主路径，进来就得能按 ↑/↓ */}
      <div className="ov-list" ref={listRef} tabIndex={0} onKeyDown={onKeyDown}>
        {visible.map((row) => (
          <OutlineRowView
            key={row.card.id}
            card={row.card}
            depth={row.depth}
            childCount={row.childCount}
            keyword={keyword}
            current={row.card.id === currentId}
            editing={row.card.id === editingId}
            activeRef={row.card.id === currentId ? activeRef : undefined}
            onPick={() => pick(row.card.id)}
            onEdit={() => {
              pick(row.card.id);
              setEditingId(row.card.id);
            }}
            onDone={() => {
              setEditingId(null);
              listRef.current?.focus();
            }}
          />
        ))}
        {!visible.length ? (
          <p className="ov-empty">{total ? t("pages.outline.noMatch", { keyword: query.trim() }) : t("pages.outline.empty")}</p>
        ) : null}
      </div>
    </div>
  );
}

function OutlineRowView({
  card,
  depth,
  childCount,
  keyword,
  current,
  editing,
  activeRef,
  onPick,
  onEdit,
  onDone,
}: {
  card: BoardCard;
  depth: number;
  childCount: number;
  keyword: string;
  current: boolean;
  editing: boolean;
  activeRef?: React.RefObject<HTMLDivElement | null>;
  onPick: () => void;
  onEdit: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const cardLabel = useCardLabel();
  const Icon = typeIcon(card.type);
  const [title, setTitle] = useState(card.title || "");
  const [content, setContent] = useState(card.content || "");
  const titleRef = useRef<HTMLInputElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 最后一次提交出去的那一版：拿它判「真的改过吗」，没改就一次请求都不发 */
  const saved = useRef({ title: card.title || "", content: card.content || "" });

  /* 服务端 / agent 改了这张卡：没在编辑就跟着更新，正在编辑就别抢用户的输入 */
  useEffect(() => {
    if (editing) return;
    setTitle(card.title || "");
    setContent(card.content || "");
    saved.current = { title: card.title || "", content: card.content || "" };
  }, [card.title, card.content, editing]);

  useEffect(() => {
    if (editing) titleRef.current?.focus();
  }, [editing]);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = { title: title.trim() === "" ? "" : title, content };
    if (next.title === saved.current.title && next.content === saved.current.content) return;
    saved.current = next;
    void useBoardStore
      .getState()
      .patchCard(card.id, next)
      .catch((err: Error) => useBoardStore.getState().showToast(err.message));
  }, [card.id, title, content]);

  /**
   * 停手 800ms 存一次（与卡片编辑器同一节奏）。
   * 卸载时补一次「还没到点的那次」，靠一个 ref 拿到**最新**的 flush——
   * 直接把 flush 写进空依赖的 cleanup 会闭包住第一版，捞回来的是空内容。
   */
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    if (!editing) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [editing, flush]);
  /**
   * 收起编辑框 / 组件卸载时补一次。
   * 「点了另一行」也走这条路——不然停手不到 800ms 就换行，刚打的字会被 cleanup
   * 连同定时器一起清掉。flush 自己会比对「真的改过吗」，白叫一次不发请求。
   */
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) flushRef.current();
    wasEditing.current = editing;
  }, [editing]);
  useEffect(() => () => flushRef.current(), []);

  const snippet = bodySnippet(card, keyword);

  return (
    <div
      ref={activeRef}
      className={`ov-row${current ? " on" : ""}${editing ? " editing" : ""}`}
      data-card-id={card.id}
      data-depth={depth}
      style={{ paddingLeft: 10 + depth * INDENT }}
      onClick={() => !editing && onPick()}
      onDoubleClick={() => !editing && onEdit()}
    >
      <Icon size={13} strokeWidth={1.8} className="ov-icon" />
      {editing ? (
        <div className="ov-edit">
          <input
            ref={titleRef}
            className="ov-title-input"
            data-field="outline.title"
            value={title}
            placeholder={t("pages.outline.cardFallbackTitle", { label: cardLabel(card.type) })}
            maxLength={300}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Enter") {
                event.preventDefault();
                flush();
                onDone();
              }
            }}
          />
          <textarea
            className="ov-content-input"
            data-field="outline.content"
            value={content}
            placeholder={t("pages.outline.content")}
            rows={3}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              // ⌘/Ctrl+Enter 提交并收起；单独的 Enter 在正文里就是换行
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                flush();
                onDone();
              }
            }}
          />
          <div className="ov-edit-foot">{t("pages.outline.editFoot")}</div>
        </div>
      ) : (
        <>
          <span className="ov-title">{card.title || <i>{t("pages.outline.cardFallbackTitle", { label: cardLabel(card.type) })}</i>}</span>
          {snippet ? <span className="ov-snippet">{snippet}</span> : null}
          <span className="ov-spacer" />
          {childCount ? <span className="ov-kids" title={t("pages.outline.children", { count: childCount })}>+{childCount}</span> : null}
          <span className="ov-type">{cardLabel(card.type)}</span>
          <button
            className="ov-edit-btn"
            data-act="outline-edit"
            title={t("pages.outline.edit.title")}
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
          >
            <UI.edit size={12} strokeWidth={1.9} />
          </button>
        </>
      )}
    </div>
  );
}
