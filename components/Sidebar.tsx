"use client";

/**
 * 左栏两段：画板列表 + 当前画板的卡片列表（按类型分组）。
 * 两段都支持右键菜单——复制 id 是给 agent 用的高频动作，不该埋在别处。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { SIDEBAR_W_DEFAULT } from "@/lib/constants";
import { ICON_SM, UI, typeIcon } from "@/lib/icons";
import { useCardLabel, useT, tr } from "@/lib/i18n/client";
import { boardAgentPrompt, browserAgentPrompt, shellQuote } from "@/lib/agent-onboarding";
import { copyText } from "@/lib/copy-text";
import { boardOrigin } from "@/lib/origins";
import { exportBoardsHtml, exportBundle } from "@/lib/export";
import { cardMatches, useBoardStore } from "@/lib/store";
import { BOARD_CARD_TYPES, type BoardSearchHit, type CardType } from "@/lib/types";
import { ContextMenu, type MenuItem, type MenuState } from "./ContextMenu";
import { browserStorageActive, browserWorkspace } from "@/lib/storage-mode";

type Section = "boards" | "cards";

type BoardItem = { id: string; name: string; parentId?: string | null; group?: string; counts?: { cards: number; edges: number; tasks?: number; openComments?: number } };

function countDescendants(byParent: Map<string, BoardItem[]>, id: string): number {
  return (byParent.get(id) || []).reduce((sum, child) => sum + 1 + countDescendants(byParent, child.id), 0);
}

/** 搜索时把命中片段标出来；关键词为空时原样返回 */
function Highlight({ text, keyword }: { text: string; keyword: string }) {
  const key = keyword.trim().toLowerCase();
  if (!key) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(key);
  while (at >= 0) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + key.length)}</mark>);
    from = at + key.length;
    at = lower.indexOf(key, from);
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

// 搜索时全部强制展开：折叠状态不该把命中藏起来
const NO_FOLDS: Record<string, boolean> = {};

/** 一块板 + 它底下的子画板；缩进就是层级，有子板才给折叠钮 */
function BoardBranch({
  item,
  depth,
  byParent,
  activeId,
  activePath,
  folded,
  keyword,
  onToggle,
  onOpen,
  onMenu,
  onRemove,
}: {
  item: BoardItem;
  depth: number;
  byParent: Map<string, BoardItem[]>;
  activeId: string | null;
  /** 当前画板的祖先链：这条路上的板要看得出来「当前那块在我底下」 */
  activePath: Set<string>;
  folded: Record<string, boolean>;
  keyword: string;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  /** 收屏幕坐标而不是事件对象：⋯ 按钮要按自身位置弹菜单，没有真事件可传 */
  onMenu: (x: number, y: number, item: BoardItem) => void;
  onRemove: (id: string, name: string) => void;
}) {
  const t = useT();
  const children = byParent.get(item.id) || [];
  const isFolded = folded[item.id] === true;
  return (
    <>
      <div
        className={`board-item${item.id === activeId ? " active" : ""}${activePath.has(item.id) ? " on-path" : ""}`}
        data-board-id={item.id}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => onOpen(item.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onMenu(event.clientX, event.clientY, item);
        }}
        title={t("sidebar.board.row.title")}
      >
        {children.length ? (
          <button
            className={`bi-caret${isFolded ? " folded" : ""}`}
            title={isFolded ? t("sidebar.board.unfold") : t("sidebar.board.fold")}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(item.id);
            }}
          >
            <UI.chevron size={12} strokeWidth={2} />
          </button>
        ) : (
          <span className="bi-caret-space" />
        )}
        {/* 名字可能两行都放不下，tooltip always 给全名 */}
        <span className="bi-name" title={item.name}>
          <Highlight text={item.name} keyword={keyword} />
        </span>
        <span
          className="bi-meta"
          title={`${t("sidebar.board.counts", { cards: item.counts?.cards ?? 0, tasks: item.counts?.tasks ?? 0 })}${
            item.counts?.openComments ? ` · ${t("sidebar.board.counts.comments", { count: item.counts.openComments })}` : ""
          }`}
        >
          {/* 没有任务 / 没有待处理评论就不显示那一段，把宽度让给名字 */}
          {t("sidebar.board.meta.cards", { count: item.counts?.cards ?? 0 })}
          {item.counts?.tasks ? t("sidebar.board.meta.tasks", { count: item.counts.tasks }) : ""}
          {item.counts?.openComments ? (
            <span className="bi-comments">{t("sidebar.board.meta.comments", { count: item.counts.openComments })}</span>
          ) : null}
        </span>
        <button
          className="bi-more"
          title={t("sidebar.board.more")}
          onClick={(event) => {
            event.stopPropagation();
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            onMenu(rect.left, rect.bottom + 4, item);
          }}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
            <circle cx="3" cy="8" r="1.4" fill="currentColor" />
            <circle cx="8" cy="8" r="1.4" fill="currentColor" />
            <circle cx="13" cy="8" r="1.4" fill="currentColor" />
          </svg>
        </button>
      </div>
      {isFolded
        ? null
        : children.map((child) => (
            <BoardBranch
              key={child.id}
              item={child}
              depth={depth + 1}
              byParent={byParent}
              activeId={activeId}
              activePath={activePath}
              folded={folded}
              keyword={keyword}
              onToggle={onToggle}
              onOpen={onOpen}
              onMenu={onMenu}
              onRemove={onRemove}
            />
          ))}
    </>
  );
}

export function Sidebar({ onNewBoard }: { onNewBoard: () => void }) {
  const boards = useBoardStore((state) => state.boards);
  const boardId = useBoardStore((state) => state.boardId);
  const board = useBoardStore((state) => state.board);
  const collapsed = useBoardStore((state) => state.sidebarCollapsed);
  const sidebarWidth = useBoardStore((state) => state.sidebarWidth);
  const toggleSidebar = useBoardStore((state) => state.toggleSidebar);
  const search = useBoardStore((state) => state.search);
  const typeFilter = useBoardStore((state) => state.typeFilter);
  /** 画布上选中的那张卡：卡片段里要跟着高亮并滚到可见处 */
  const selectedCardId = useBoardStore((state) => (state.selection?.kind === "card" ? state.selection.id : null));
  const t = useT();
  const cardLabel = useCardLabel();
  const [section, setSection] = useState<Section>("boards");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [foldedGroups, setFoldedGroups] = useState<Record<string, boolean>>({});
  const [resizing, setResizing] = useState(false);
  /** 深链（导航页 / 分享链接）带来的那张卡，还没在列表里定位到之前一直挂着 */
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const cardListRef = useRef<HTMLDivElement | null>(null);
  const boardListRef = useRef<HTMLDivElement | null>(null);
  /** 「导入画板…」的文件框：菜单项点不出系统文件选择框，得借一个真的 input */
  const importInput = useRef<HTMLInputElement | null>(null);
  /** 待定位的画板：切板后要把它从折叠里挖出来滚到眼前，滚到了就清空 */
  const [boardReveal, setBoardReveal] = useState<{ id: string; smooth: boolean } | null>(null);
  /** 当前画板那一行是不是看不见了（滚出可视区 / 被搜索过滤掉）——是就浮一条「回到当前画板」 */
  const [activeOffscreen, setActiveOffscreen] = useState(false);
  /** 已经给哪块板定过位：板列表每刷新一次就重定位一次的话，会一直跟用户自己的折叠和滚动打架 */
  const revealedFor = useRef<string | null>(null);
  const firstOpen = useRef(true);
  /** 画板搜索：树过滤即时做，卡片内容命中防抖后问服务端 */
  const [boardQuery, setBoardQuery] = useState("");
  const [deepHits, setDeepHits] = useState<BoardSearchHit[]>([]);
  const [deepLoading, setDeepLoading] = useState(false);
  const boardKeyword = boardQuery.trim();
  const latestKeyword = useRef(boardKeyword);
  latestKeyword.current = boardKeyword;

  useEffect(() => {
    if (!boardKeyword) {
      setDeepHits([]);
      setDeepLoading(false);
      return;
    }
    setDeepLoading(true);
    const timer = setTimeout(() => {
      api
        .searchBoards(boardKeyword)
        .then((result) => {
          // 响应可能乱序回来，只认最后一次输入的结果
          if (latestKeyword.current !== boardKeyword) return;
          setDeepHits(result.boards);
          setDeepLoading(false);
        })
        .catch(() => {
          if (latestKeyword.current !== boardKeyword) return;
          setDeepHits([]);
          setDeepLoading(false);
        });
    }, 280);
    return () => clearTimeout(timer);
  }, [boardKeyword]);

  /**
   * `?card=` 进来的（画板导航页点一张卡、别人发来的分享链接）：
   * 左栏直接切到卡片段并把那一张定位出来——画布已经跳过去了，
   * 左栏还停在画板列表的话，「这张卡在这块板的哪儿」还得自己再找一遍。
   */
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("card");
    if (!want) return;
    setSection("cards");
    setPendingReveal(want);
  }, []);

  /**
   * 把当前这张卡滚到可见处：优先深链带来的那张，其次画布上选中的那张。
   * 所在类型组折起来的话先展开——定位到一个看不见的地方等于没定位。
   */
  useEffect(() => {
    const target = pendingReveal || selectedCardId;
    if (!target || section !== "cards") return;
    const card = (board?.cards || []).find((item) => item.id === target);
    if (!card) {
      // 板都拉下来了还找不到 = 链接里那张卡已经不在了。挂着不清的话，
      // 它会一直压过「跟随选中」，之后点哪张卡左栏都不动了
      if (pendingReveal && board) setPendingReveal(null);
      return;
    }
    if (foldedGroups[card.type]) {
      setFoldedGroups((prev) => ({ ...prev, [card.type]: false }));
      return;
    }
    const node = cardListRef.current?.querySelector(`[data-card-id="${CSS.escape(target)}"]`);
    if (!node) return;
    node.scrollIntoView({ block: "nearest" });
    if (pendingReveal) setPendingReveal(null);
  }, [pendingReveal, selectedCardId, section, board?.cards, foldedGroups]);

  /**
   * 拖右边缘调宽：指针事件挂 window（拖出把手外也要跟手），
   * 拖动过程不落 localStorage，松手才写一次。
   */
  function startResize(event: React.PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = useBoardStore.getState().sidebarWidth;
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => {
      useBoardStore.getState().setSidebarWidth(startWidth + (moveEvent.clientX - startX), false);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizing(false);
      useBoardStore.getState().setSidebarWidth(useBoardStore.getState().sidebarWidth);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  async function open(id: string) {
    const state = useBoardStore.getState();
    if (id === state.boardId) return;
    try {
      await state.openBoard(id);
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  /** 深度搜索命中：跳到那块板并定位到那张卡（已在板上就只定位） */
  async function openCard(targetBoardId: string, cardId: string) {
    const state = useBoardStore.getState();
    try {
      if (state.boardId === targetBoardId) state.requestFocus(cardId);
      else await state.openBoard(targetBoardId, { focusCardId: cardId });
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(tr("sidebar.board.delete.confirm", { name }))) return;
    const state = useBoardStore.getState();
    try {
      await state.removeBoard(id);
      state.showToast(tr("sidebar.board.deleted"));
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  function copy(text: string, label: string) {
    void copyText(text).then((ok) =>
      useBoardStore.getState().showToast(ok ? tr("sidebar.copy.done", { label }) : tr("sidebar.copy.failed")),
    );
  }

  /** 导出一批板：画板包（结构 + 附件，能导回来）或排版 HTML（给人看，也能导回来） */
  function exportBoards(selection: { ids?: string[]; group?: string }, label: string, kind: "bundle" | "html") {
    const state = useBoardStore.getState();
    const done = kind === "bundle" ? exportBundle(selection) : Promise.resolve(exportBoardsHtml(selection));
    void done
      .then(() => state.showToast(tr("sidebar.export.toast", { label, kind: tr(kind === "bundle" ? "sidebar.export.kind.bundle" : "sidebar.export.kind.html") })))
      .catch((err: Error) => state.showToast(tr("sidebar.export.failed", { message: err.message })));
  }

  /** 导出菜单：一块板与一个分组共用，只有「导哪些」不同 */
  function exportMenuItems(selection: { ids?: string[]; group?: string }, label: string): MenuItem[] {
    return [
      {
        key: "export-bundle",
        label: tr("sidebar.export.bundle"),
        icon: UI.download,
        hint: tr("sidebar.export.bundle.hint"),
        onSelect: () => exportBoards(selection, label, "bundle"),
      },
      ...(browserStorageActive()
        ? []
        : [{
            key: "export-html",
            label: tr("sidebar.export.html"),
            icon: UI.markdown,
            hint: tr("sidebar.export.html.hint"),
            onSelect: () => exportBoards(selection, label, "html"),
          } as MenuItem]),
    ];
  }

  async function importFile(file: File) {
    const state = useBoardStore.getState();
    try {
      const result = await state.importBoardsFile(file, "copy");
      state.showToast(
        tr("sidebar.import.done", { imported: result.imported }) +
          (result.skipped ? tr("sidebar.import.skipped", { skipped: result.skipped }) : "") +
          (result.notes.length ? `；${result.notes[0]}` : ""),
      );
    } catch (err) {
      state.showToast(tr("sidebar.import.failed", { message: (err as Error).message }));
    }
  }

  /**
   * 「移动到」这一行：一级只占一行，右侧展开才列具体分组。
   * 分组多的时候平铺会把菜单撑到满屏，二级菜单自己滚，一级维持原来的长度。
   */
  function moveMenuItem(item: BoardItem): MenuItem {
    const others = allGroups.filter((group) => group !== (item.group || ""));
    const submenu: MenuItem[] = [
      ...others.map((group) => ({
        key: `group-${group}`,
        label: group,
        icon: UI.blocks,
        onSelect: () => void moveToGroup(item.id, group),
      })),
      ...(others.length ? [{ key: "sep-move", label: "", separator: true } as MenuItem] : []),
      {
        key: "group-new",
        label: tr("sidebar.move.newGroup"),
        icon: UI.add,
        onSelect: () => {
          const group = window.prompt(tr("sidebar.group.prompt"), item.group || "");
          if (group === null) return;
          void moveToGroup(item.id, group.trim());
        },
      },
      ...(item.group
        ? [{ key: "group-clear", label: tr("sidebar.move.clear"), icon: UI.undo, onSelect: () => void moveToGroup(item.id, "") } as MenuItem]
        : []),
      ...(item.parentId
        ? [{
            key: "unnest",
            label: tr("sidebar.move.unnest"),
            icon: UI.open,
            onSelect: () => void useBoardStore.getState().setBoardParent(item.id, null).catch(() => undefined),
          } as MenuItem]
        : []),
    ];
    return {
      key: "move",
      label: tr("sidebar.move"),
      icon: UI.move,
      // 一眼看见现在在哪个分组，省得点开才知道
      hint: item.group || tr("sidebar.group.none"),
      submenu,
    };
  }

  /** 画板菜单（右键行或点 ⋯）：以「复制 id / API 地址」为主，直接贴给 agent 用 */
  function boardMenu(x: number, y: number, item: BoardItem) {
    const base = boardOrigin();
    const browser = browserStorageActive();
    const items: MenuItem[] = [
      { key: "open", label: tr("sidebar.board.open"), icon: UI.open, disabled: item.id === boardId, onSelect: () => void open(item.id) },
      { key: "sep1", label: "", separator: true },
      { key: "copy-agent", label: tr(browser ? "sidebar.board.copyAgentCdp" : "sidebar.board.copyAgent"), icon: UI.agent, onSelect: () => copy(browser ? browserAgentPrompt(base, browserWorkspace(), item.id) : boardAgentPrompt(base, item.id), tr(browser ? "sidebar.copy.label.cdpPrompt" : "sidebar.copy.label.boardPrompt")) },
      { key: "copy-id", label: tr("sidebar.board.copyId"), icon: UI.copy, hint: `${item.id.slice(0, 10)}…`, onSelect: () => copy(item.id, tr("sidebar.copy.label.boardId")) },
      { key: "copy-name", label: tr("sidebar.board.copyName"), icon: UI.copy, onSelect: () => copy(item.name, tr("sidebar.copy.label.boardName")) },
      ...(!browser ? [{
        key: "copy-api",
        label: tr("sidebar.board.copyApi"),
        icon: UI.code,
        onSelect: () => copy(`${base}/api/boards/${item.id}`, tr("sidebar.copy.label.api")),
      },
      {
        key: "copy-curl",
        label: tr("sidebar.board.copyCurl"),
        icon: UI.code,
        onSelect: () => copy(`curl --fail --silent --show-error ${shellQuote(`${base}/api/boards/${encodeURIComponent(item.id)}`)}`, tr("sidebar.copy.label.curl")),
      }] as MenuItem[] : []),
      { key: "sep-export", label: "", separator: true },
      {
        key: "export",
        label: tr("sidebar.export.board"),
        icon: UI.download,
        // 子画板与被 board 卡指到的板会跟着一起走，不然对端点开那张卡是死链
        hint: tr("sidebar.export.board.hint"),
        submenu: exportMenuItems({ ids: [item.id] }, tr("sidebar.export.board.label", { name: item.name })),
      },
      { key: "sep-group", label: "", separator: true },
      // 分组可以攒到几十个，全平铺出来菜单能盖半屏：收进「移动到」这一行，展开才列具体分组
      moveMenuItem(item),
      { key: "sep2", label: "", separator: true },
      { key: "delete", label: tr("sidebar.board.delete"), icon: UI.remove, danger: true, onSelect: () => void remove(item.id, item.name) },
    ];
    setMenu({ x, y, items });
  }

  /** 卡片右键：定位 + 复制 id / API 地址 */
  function cardMenu(event: React.MouseEvent, cardId: string, title: string) {
    event.preventDefault();
    event.stopPropagation();
    const state = useBoardStore.getState();
    const base = boardOrigin();
    const items: MenuItem[] = [
      { key: "focus", label: tr("sidebar.card.focus"), icon: UI.open, onSelect: () => state.requestFocus(cardId) },
      {
        key: "edit",
        label: tr("sidebar.card.edit"),
        icon: UI.edit,
        onSelect: () => {
          state.requestFocus(cardId);
          state.setEditing(cardId);
        },
      },
      { key: "sep1", label: "", separator: true },
      { key: "copy-id", label: tr("sidebar.card.copyId"), icon: UI.copy, hint: `${cardId.slice(0, 10)}…`, onSelect: () => copy(cardId, tr("sidebar.copy.label.cardId")) },
      { key: "copy-title", label: tr("sidebar.card.copyTitle"), icon: UI.copy, onSelect: () => copy(title, tr("sidebar.copy.label.title")) },
      ...(!browserStorageActive() ? [{
        key: "copy-ref",
        label: tr("sidebar.card.copyApi"),
        icon: UI.code,
        onSelect: () => copy(`${base}/api/boards/${state.boardId}/cards/${cardId}`, tr("sidebar.copy.label.cardApi")),
      }] as MenuItem[] : []),
      { key: "sep2", label: "", separator: true },
      {
        key: "delete",
        label: tr("sidebar.card.delete"),
        icon: UI.remove,
        danger: true,
        // 删完提示里带「撤销」，不再事前弹一个系统确认
        onSelect: () => void state.deleteCardsWithUndo([cardId]),
      },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  /**
   * 搜索时的树过滤：板名/分组命中的板 + 它们的全部祖先（保住层级可读）。
   * 板 id 只在关键词够长时参与匹配，避免「b」这种单字母全命中。
   */
  const shownBoards = useMemo(() => {
    const key = boardKeyword.toLowerCase();
    if (!key) return boards;
    const byId = new Map(boards.map((item) => [item.id, item]));
    const visible = new Set<string>();
    for (const item of boards) {
      const idHit = key.length >= 4 && item.id.toLowerCase().includes(key);
      if (!idHit && !`${item.name} ${item.group || ""}`.toLowerCase().includes(key)) continue;
      let cursor: BoardItem | undefined = item;
      while (cursor && !visible.has(cursor.id)) {
        visible.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
    }
    return boards.filter((item) => visible.has(item.id));
  }, [boards, boardKeyword]);

  /**
   * 画板按「分组（项目）→ 层级树」组织。
   * 分组是扁的一层（项目），层级是子画板缩进——两者独立：
   * 子画板默认继承父板的分组，所以一个项目下的板会自然聚在一起。
   */
  const boardTree = useMemo(() => {
    const byParent = new Map<string, typeof boards>();
    const known = new Set(shownBoards.map((item) => item.id));
    for (const item of shownBoards) {
      // 父板被删了的孤儿按顶层处理，别让它整块消失
      const parent = item.parentId && known.has(item.parentId) ? item.parentId : "";
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent)!.push(item);
    }
    const groups = new Map<string, typeof boards>();
    for (const item of byParent.get("") || []) {
      const group = item.group || "";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(item);
    }
    const names = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "zh")));
    return { byParent, groups, names };
  }, [shownBoards]);

  const allGroups = useMemo(
    () => [...new Set(boards.map((item) => item.group || "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh")),
    [boards],
  );

  /**
   * 当前画板在树里的位置：从它一路往上的祖先链 + 顶层祖先所在的分组。
   * 「我在哪块板、它属于哪个分组」全靠这条链——高亮、展开、定位都读它。
   */
  const activeTrail = useMemo(() => {
    const byId = new Map(boards.map((item) => [item.id, item]));
    const self = boardId ? byId.get(boardId) : undefined;
    const path = new Set<string>();
    let cursor = self;
    // parentId 万一成环（历史数据 / 手改过 JSON），path 兜住，别把左栏转死
    while (cursor?.parentId && !path.has(cursor.parentId)) {
      const parent = byId.get(cursor.parentId);
      if (!parent) break;
      path.add(parent.id);
      cursor = parent;
    }
    return { found: Boolean(self), path, group: cursor?.group || "", name: self?.name || "" };
  }, [boards, boardId]);

  /** 展开当前画板所在的分组与祖先链——定位到一个折起来的地方等于没定位 */
  function unfoldToActive() {
    setFoldedGroups((prev) => {
      const next = { ...prev, [`g:${activeTrail.group}`]: false };
      for (const id of activeTrail.path) next[id] = false;
      return next;
    });
  }

  /**
   * 换板之后左栏的焦点跟过去：切回画板段、展开它所在的分组和祖先链、滚到列表中间。
   * 两百多块板的列表里，「现在这块在哪个分组、旁边还有哪几块可以点」不该自己再找一遍。
   */
  useEffect(() => {
    if (!boardId || revealedFor.current === boardId) return;
    // 板列表还没到（或刚建出来的板还没进列表）：等它到了这个 effect 会再跑一次
    if (!activeTrail.found) return;
    revealedFor.current = boardId;
    const deepCard = firstOpen.current && new URLSearchParams(window.location.search).get("card");
    // 首屏那次不做动画：从列表顶端一路滚下来的过场没人要看
    const smooth = !firstOpen.current;
    firstOpen.current = false;
    // ?card= 进来的那一次焦点归那张卡（左栏已经切到卡片段了），别抢回来
    if (deepCard) return;
    setSection("boards");
    unfoldToActive();
    setBoardReveal({ id: boardId, smooth });
  }, [boardId, activeTrail]);

  /** 把待定位的那块板滚到可见处；这一轮还没渲染出来就等下一轮（展开是下一次渲染的事） */
  useEffect(() => {
    if (!boardReveal || section !== "boards") return;
    const root = boardListRef.current;
    const node = root?.querySelector<HTMLElement>(`[data-board-id="${CSS.escape(boardReveal.id)}"]`);
    if (!root || !node) {
      // 搜索把它过滤掉了：等下去也不会出现，先放手，不然它会一直压着后面的定位
      if (boardKeyword) setBoardReveal(null);
      return;
    }
    // 自己算滚动量而不是 scrollIntoView：后者会连祖先容器一起滚，这里只想动左栏这一条列表
    const box = node.getBoundingClientRect();
    const top = root.scrollTop + box.top - root.getBoundingClientRect().top - (root.clientHeight - box.height) / 2;
    root.scrollTo({ top: Math.max(0, top), behavior: boardReveal.smooth ? "smooth" : "auto" });
    setBoardReveal(null);
  }, [boardReveal, section, boardKeyword, shownBoards, foldedGroups]);

  /** 当前画板看不见了就浮一条回去的入口：列表越长越需要——滚两屏之后谁还记得自己在哪儿 */
  useEffect(() => {
    if (section !== "boards" || collapsed || !boardId || !activeTrail.found) {
      setActiveOffscreen(false);
      return;
    }
    const root = boardListRef.current;
    const node = root?.querySelector(`[data-board-id="${CSS.escape(boardId)}"]`);
    // 行压根不在列表里（搜索过滤掉 / 祖先被折起来了），那也算「看不见当前画板」
    if (!root || !node) {
      setActiveOffscreen(true);
      return;
    }
    // 看的是露出比例不是 isIntersecting：后者露一个像素就算「在屏内」，
    // 而卡在边缘只露半行的当前画板，跟看不见没区别
    const observer = new IntersectionObserver(([entry]) => setActiveOffscreen(entry.intersectionRatio < 0.5), {
      root,
      threshold: [0, 0.5, 1],
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [section, collapsed, boardId, activeTrail, shownBoards, foldedGroups]);

  /**
   * 搜索清掉的那一下：树跳回完整列表，之前那点滚动位置就废了（同一行换了个位置）。
   * 把当前画板重新拽回眼前，而不是把人扔在列表中间某处。
   */
  const prevKeyword = useRef(boardKeyword);
  useEffect(() => {
    const had = prevKeyword.current;
    prevKeyword.current = boardKeyword;
    if (boardKeyword || !had || !boardId) return;
    unfoldToActive();
    setBoardReveal({ id: boardId, smooth: false });
  }, [boardKeyword, boardId]);

  /** 「回到当前画板」：挡路的搜索先清掉，展开祖先链，再滚过去 */
  function locateActive() {
    if (!boardId) return;
    if (boardKeyword && !shownBoards.some((item) => item.id === boardId)) setBoardQuery("");
    setSection("boards");
    unfoldToActive();
    setBoardReveal({ id: boardId, smooth: true });
  }

  /** 分组不是独立实体，就是画板上的一个字段——所以重命名/解散都是批量改这一组板 */
  function groupMenu(x: number, y: number, group: string, roots: BoardItem[]) {
    const state = useBoardStore.getState();
    const members = boards.filter((item) => (item.group || "") === group);
    setMenu({
      x,
      y,
      items: [
        {
          key: "rename",
          label: tr("sidebar.group.rename"),
          icon: UI.edit,
          hint: tr("sidebar.group.rename.hint", { count: members.length }),
          onSelect: () => {
            const next = window.prompt(tr("sidebar.group.prompt"), group);
            if (next === null || !next.trim() || next.trim() === group) return;
            void Promise.all(members.map((item) => state.setBoardGroup(item.id, next.trim())))
              .then(() => state.showToast(tr("sidebar.group.renamed", { name: next.trim() })))
              .catch((err: Error) => state.showToast(err.message));
          },
        },
        {
          key: "new-in-group",
          label: tr("sidebar.group.newBoard"),
          icon: UI.add,
          onSelect: () => void newBoardIn(group),
        },
        {
          key: "export-group",
          label: tr("sidebar.export.group"),
          icon: UI.download,
          hint: tr("sidebar.export.group.hint", { count: members.length }),
          submenu: exportMenuItems({ group }, tr("sidebar.export.group.label", { group: group || tr("sidebar.group.none") })),
        },
        { key: "sep", label: "", separator: true },
        {
          key: "dissolve",
          label: tr("sidebar.group.dissolve"),
          icon: UI.undo,
          hint: tr("sidebar.group.dissolve.hint"),
          danger: true,
          onSelect: () => {
            if (!window.confirm(tr("sidebar.group.dissolve.confirm", { group, count: members.length }))) return;
            void Promise.all(members.map((item) => state.setBoardGroup(item.id, "")))
              .then(() => state.showToast(tr("sidebar.group.dissolved")))
              .catch((err: Error) => state.showToast(err.message));
          },
        },
      ],
    });
  }

  async function newBoardIn(group: string) {
    const state = useBoardStore.getState();
    try {
      const board = await state.createBoard(tr("common.untitledBoard"), group ? { group } : {});
      await state.openBoard(board.id);
      const input = document.querySelector<HTMLInputElement>(".board-name");
      input?.focus();
      input?.select();
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  /** 「新建」是个小菜单：新建画板 / 新建分组——分组入口只藏在右键里，用户找不到 */
  function newMenu(event: React.MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: Math.max(8, rect.right - 200),
      y: rect.bottom + 4,
      items: [
        { key: "new-board", label: tr("sidebar.new.board"), icon: UI.add, onSelect: onNewBoard },
        // 分组收进二级菜单：真实库里分组能有二三十个，平铺出来菜单比屏幕还高，
        // 排在它后面的「导入画板」「新建分组」直接掉到窗口外面点不着（二级菜单自己会滚）
        ...(allGroups.length
          ? [{
              key: "new-in-group",
              label: tr("sidebar.new.inGroups"),
              icon: UI.blocks,
              hint: tr("sidebar.new.inGroups.hint", { count: allGroups.length }),
              submenu: allGroups.map((group) => ({
                key: `new-in-${group}`,
                label: tr("sidebar.new.inGroup", { group }),
                icon: UI.blocks,
                onSelect: () => void newBoardIn(group),
              })),
            } as MenuItem]
          : []),
        { key: "sep", label: "", separator: true },
        {
          key: "import",
          label: tr("sidebar.import"),
          icon: UI.upload,
          hint: tr("sidebar.import.hint"),
          onSelect: () => importInput.current?.click(),
        },
        {
          key: "new-group",
          label: tr("sidebar.new.group"),
          icon: UI.blocks,
          hint: tr("sidebar.new.group.hint"),
          onSelect: () => {
            const group = window.prompt(tr("sidebar.new.group.prompt"));
            if (group === null || !group.trim()) return;
            void newBoardIn(group.trim());
          },
        },
      ],
    });
  }

  async function moveToGroup(id: string, group: string) {
    const state = useBoardStore.getState();
    try {
      await state.setBoardGroup(id, group);
      state.showToast(group ? tr("sidebar.moveTo", { group }) : tr("sidebar.move.cleared"));
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  const grouped = useMemo(() => {
    const filtering = Boolean(search.trim() || typeFilter.length);
    const groups = new Map<CardType, { id: string; title: string }[]>();
    for (const type of BOARD_CARD_TYPES) groups.set(type, []);
    for (const card of board?.cards || []) {
      if (filtering && !cardMatches(card, search, typeFilter)) continue;
      // 未知类型（本机没有对应卡片包）也要进列表：兜底建组、名字用 type 本身
      if (!groups.has(card.type)) groups.set(card.type, []);
      groups.get(card.type)!.push({ id: card.id, title: card.title || t("sidebar.card.untitled", { label: cardLabel(card.type) }) });
    }
    return [...groups.entries()].filter(([, list]) => list.length);
  }, [board?.cards, search, typeFilter, t, cardLabel]);

  const cardTotal = grouped.reduce((sum, [, list]) => sum + list.length, 0);

  return (
    <>
      <aside
        className={`sidebar${collapsed ? " collapsed" : ""}`}
        style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}
      >
        <div className="aside-tabs">
          <button className={section === "boards" ? "active" : ""} onClick={() => setSection("boards")}>
            {t("sidebar.tab.boards")} <span className="aside-count">{boards.length}</span>
          </button>
          <button className={section === "cards" ? "active" : ""} onClick={() => setSection("cards")}>
            {t("sidebar.tab.cards")} <span className="aside-count">{cardTotal}</span>
          </button>
          {/* 分体按钮：主体一键新建（最高频），箭头才展开分组相关的动作 */}
          <span className="new-board-split">
            <button className="new-board-btn" title={t("sidebar.new.board")} onClick={onNewBoard}>
              <UI.add size={14} strokeWidth={2.4} /> {t("common.new")}
            </button>
            <button className="new-board-caret" title={t("sidebar.new.caret.title")} onClick={newMenu}>
              <UI.chevron size={12} strokeWidth={2.2} />
            </button>
          </span>
        </div>

        {section === "boards" ? (
          <div className={`aside-search${boardKeyword ? " active" : ""}`}>
            <UI.search size={13} strokeWidth={1.9} />
            <input
              value={boardQuery}
              placeholder={t("sidebar.search.placeholder")}
              onChange={(event) => setBoardQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setBoardQuery("");
                  (event.target as HTMLInputElement).blur();
                }
              }}
            />
            {boardKeyword ? (
              <button className="aside-search-clear" title={t("sidebar.search.clear")} onClick={() => setBoardQuery("")}>
                <UI.close size={12} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        ) : null}

        {section === "boards" ? (
          <div className="board-list" ref={boardListRef}>
            {boardKeyword && !shownBoards.length ? (
              <div className="aside-empty">{t("sidebar.search.empty")}</div>
            ) : null}
            {boardTree.names.map((group) => {
              const roots = boardTree.groups.get(group) || [];
              const key = `g:${group}`;
              // 搜索时全部强制展开：折叠状态不该把命中藏起来
              const folded = boardKeyword ? false : foldedGroups[key] === true;
              const total = roots.reduce((sum, item) => sum + 1 + countDescendants(boardTree.byParent, item.id), 0);
              // 当前画板落在哪个分组里：标出来，省得「这块板到底属于哪个项目」还要往上翻
              const currentGroup = activeTrail.found && group === activeTrail.group;
              return (
                <div className="board-group" key={key}>
                  {/* 未分组的板不给标题，省得空分组名占一行 */}
                  {group || boardTree.names.length > 1 ? (
                    <div className="group-head-row">
                      <button
                        className={`card-group-head${currentGroup ? " current" : ""}`}
                        title={currentGroup ? t("sidebar.group.current.title") : undefined}
                        onClick={() => setFoldedGroups((prev) => ({ ...prev, [key]: !folded }))}
                      >
                        <UI.blocks size={13} strokeWidth={1.9} />
                        <Highlight text={group || t("sidebar.group.none")} keyword={group ? boardKeyword : ""} />
                        {currentGroup ? <span className="group-now">{t("sidebar.group.current")}</span> : null}
                        <span className="aside-count">{total}</span>
                        <span className={`card-group-caret${folded ? " folded" : ""}`}>
                          <UI.chevron size={13} strokeWidth={1.9} />
                        </span>
                      </button>
                      {group ? (
                        <button
                          className="bi-more"
                          title={t("sidebar.group.more")}
                          onClick={(event) => {
                            event.stopPropagation();
                            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                            groupMenu(rect.left, rect.bottom + 4, group, roots);
                          }}
                        >
                          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                            <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                            <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                            <circle cx="13" cy="8" r="1.4" fill="currentColor" />
                          </svg>
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {folded
                    ? null
                    : roots.map((item) => (
                        <BoardBranch
                          key={item.id}
                          item={item}
                          depth={0}
                          byParent={boardTree.byParent}
                          activeId={boardId}
                          activePath={activeTrail.path}
                          folded={boardKeyword ? NO_FOLDS : foldedGroups}
                          keyword={boardKeyword}
                          onToggle={(id) => setFoldedGroups((prev) => ({ ...prev, [id]: !prev[id] }))}
                          onOpen={open}
                          onMenu={boardMenu}
                          onRemove={remove}
                        />
                      ))}
                </div>
              );
            })}
            {boardKeyword ? (
              <div className="deep-results">
                <div className="deep-head">
                  {t("sidebar.deep.head")}
                  {deepLoading ? (
                    <span className="deep-loading">{t("sidebar.deep.loading")}</span>
                  ) : (
                    <span className="aside-count">{deepHits.reduce((sum, hit) => sum + hit.cardTotal, 0)}</span>
                  )}
                </div>
                {!deepLoading && !deepHits.some((hit) => hit.cards.length) ? (
                  <div className="aside-empty">{t("sidebar.deep.empty", { keyword: boardKeyword })}</div>
                ) : null}
                {deepHits
                  .filter((hit) => hit.cards.length)
                  .map((hit) => (
                    <div className="deep-board" key={hit.id}>
                      <button
                        className="deep-board-name"
                        title={hit.group ? `${hit.group} · ${t("sidebar.board.open")}` : t("sidebar.board.open")}
                        onClick={() => void open(hit.id)}
                      >
                        <UI.blocks size={12} strokeWidth={1.9} />
                        <span className="deep-board-label">
                          <Highlight text={hit.name} keyword={boardKeyword} />
                        </span>
                        <span className="aside-count">{hit.cardTotal}</span>
                      </button>
                      {hit.cards.map((card) => {
                        const Icon = typeIcon(card.type);
                        return (
                          <div
                            className="deep-card"
                            key={card.id}
                            title={t("sidebar.deep.card.title")}
                            onClick={() => void openCard(hit.id, card.id)}
                          >
                            <Icon size={12} strokeWidth={1.9} />
                            <span className="deep-card-text">
                              <span className="deep-card-title">
                                <Highlight text={card.title} keyword={boardKeyword} />
                              </span>
                              {card.snippet && card.snippet !== card.title ? (
                                <span className="deep-card-snippet">
                                  <Highlight text={card.snippet} keyword={boardKeyword} />
                                </span>
                              ) : null}
                            </span>
                          </div>
                        );
                      })}
                      {hit.cardTotal > hit.cards.length ? (
                        <div className="deep-more">{t("sidebar.deep.more", { count: hit.cardTotal - hit.cards.length })}</div>
                      ) : null}
                    </div>
                  ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="board-list" ref={cardListRef}>
            {!grouped.length ? (
              <div className="aside-empty">{board?.cards.length ? t("sidebar.cards.emptyFiltered") : t("sidebar.cards.empty")}</div>
            ) : (
              grouped.map(([type, list]) => {
                const Icon = typeIcon(type);
                const folded = foldedGroups[type] === true;
                return (
                  <div className="card-group" key={type}>
                    <button
                      className="card-group-head"
                      onClick={() => setFoldedGroups((prev) => ({ ...prev, [type]: !folded }))}
                    >
                      <Icon size={13} strokeWidth={1.9} />
                      {cardLabel(type)}
                      <span className="aside-count">{list.length}</span>
                      <span className={`card-group-caret${folded ? " folded" : ""}`}>
                        <UI.chevron size={13} strokeWidth={1.9} />
                      </span>
                    </button>
                    {folded
                      ? null
                      : list.map((entry) => (
                          <div
                            key={entry.id}
                            className={`card-item${entry.id === selectedCardId ? " active" : ""}`}
                            data-card-id={entry.id}
                            title={t("sidebar.card.item.title")}
                            onClick={() => useBoardStore.getState().requestFocus(entry.id)}
                            onContextMenu={(event) => cardMenu(event, entry.id, entry.title)}
                          >
                            {entry.title}
                          </div>
                        ))}
                  </div>
                );
              })
            )}
          </div>
        )}

        {section === "boards" && activeTrail.found && activeOffscreen ? (
          <button className="board-locator" title={t("sidebar.locate")} onClick={locateActive}>
            <UI.target size={12} strokeWidth={2} />
            <span className="bl-name">{activeTrail.name}</span>
            {activeTrail.group ? <span className="bl-group">{activeTrail.group}</span> : null}
          </button>
        ) : null}

        <div className="aside-foot">
          <kbd>V</kbd> {t("sidebar.foot.select")} <kbd>H</kbd> {t("sidebar.foot.pan")}<kbd>{t("sidebar.foot.space")}</kbd>{t("sidebar.foot.panTemp")}
          <br />
          {t("sidebar.foot.marquee")}<kbd>⌘</kbd>{t("sidebar.foot.selectAll")}<kbd>Del</kbd> {t("sidebar.foot.delete")}
          <br />
          {t("sidebar.foot.wheel")}<kbd>⌘</kbd>{t("sidebar.foot.zoom")}<kbd>⌘</kbd>{t("sidebar.foot.search")}
          <br />
          {t("sidebar.foot.mouse")}
        </div>
        {collapsed ? null : (
          <div
            className={`sidebar-resizer${resizing ? " dragging" : ""}`}
            title={t("sidebar.resizer.title")}
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startResize}
            onDoubleClick={() => useBoardStore.getState().setSidebarWidth(SIDEBAR_W_DEFAULT)}
          />
        )}
      </aside>
      <button
        className="sidebar-toggle"
        title={collapsed ? t("top.sidebar.expand") : t("top.sidebar.collapse")}
        aria-label={collapsed ? t("top.sidebar.expand") : t("top.sidebar.collapse")}
        onClick={toggleSidebar}
      >
        {collapsed ? <UI.sidebarOpen size={13} strokeWidth={1.9} /> : <UI.sidebarClose size={13} strokeWidth={1.9} />}
      </button>
      <input
        ref={importInput}
        className="board-import-input"
        type="file"
        accept=".json,.html,application/json,text/html"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) await importFile(file);
        }}
      />
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </>
  );
}
