"use client";

import { boardEditSignature } from "@/lib/history-content";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReactFlow, useStore as useFlowStore } from "@xyflow/react";
import { SiteNav } from "./SiteNav";
import { canvasFitPadding } from "./canvas-fit";
import { ICON_MD, ICON_SM, UI } from "@/lib/icons";
import type { TidyMode } from "@/lib/layout";
import { useT, tr } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import {
  exportBundle,
  exportJson,
  exportMarkdown,
  exportPng,
  exportServerHtml,
  serverExportUrl,
  type ServerExportOptions,
} from "@/lib/export";
import { exportBoardPdf } from "@/lib/export-pdf";
import { loadPdfSettings } from "@/lib/pdf-settings";
import { useFeatures } from "@/lib/features-client";
import { cardMatches, readingSequence, useBoardStore } from "@/lib/store";
import { browserWorkspace } from "@/lib/storage-mode";

/** 整理完那句提示的文案键：`tidy.done.<mode>`，十一种摆法各一条。 */
const tidyDoneKey = (mode: TidyMode): DictKey => `tidy.done.${mode}` as DictKey;

/** 等 React 提交 + 浏览器至少画两帧，确保新挂上去的节点真的进了 DOM。 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
  });
}

/**
 * 窄屏收纳的档位表：档位越高，从顶栏挪进「更多」的命令越多。
 *
 * 为什么不用 CSS 断点：顶栏的宽度不只跟视口有关——板名多长、有没有面包屑、
 * 是不是浏览器存储形态、界面是中文还是英文，每一样都会改变它需要的宽度。
 * 断点是**猜**一个宽度，量出来的档位才是真的（见 useCompactLevel）。
 */
const COMPACT = {
  /** ① 先收字：站点导航与右侧三组只剩图标（含义靠 tooltip / aria-label） */
  labels: 1,
  /** ② 往板上放什么：模板 / 卡片 */
  content: 2,
  /** ③ 协作组里的次要两颗：历史 / 设置 */
  extras: 3,
  /** ④ 整理 / 导出（「阅读」留着——通读整块板是顶栏上最常用的一件事） */
  tidyExport: 4,
  /** ⑤ 评论 / Agent（评论的角标跟着挪到「更多」上，欠着几条不能丢） */
  collab: 5,
  /** ⑥ 最后一档：品牌字 / 存储胶囊 / 手势开关让位，站点导航收成一颗，阅读也进菜单 */
  chrome: 6,
} as const;
const COMPACT_MAX = COMPACT.chrome;

/**
 * 量出「顶栏得收到第几档才装得下」。
 *
 * 算法只有两步，重点在**每次都从 0 档重算**：
 * ① 宽度或内容一变，先回到 0 档（全展开）；
 * ② 渲染完发现还溢出就升一档，直到装得下或到顶。
 *
 * 从 0 重算是为了避开迟滞——如果只在溢出时升档、在有余量时降档，
 * 「降一档」之后往往又立刻溢出，两档之间会来回抖。回到 0 再往下走，
 * 每个宽度只有一个稳定解。升档不改变顶栏自身的宽度，所以 ResizeObserver 不会自激。
 *
 * `tick` 是必须的：`setLevel(0)` 在本来就是 0 档时会被 React 直接跳过，
 * 连一次渲染都不发生，量尺（下面那个 layout effect）也就永远不会再跑一遍——
 * 从宽屏一路拖窄时会卡在 0 档不动。带一个每次都变的计数就没有这个空转。
 */
function useCompactLevel(ref: React.RefObject<HTMLElement | null>, signature: string) {
  const [{ level }, setState] = useState({ level: 0, tick: 0 });
  const restart = useCallback(() => setState((prev) => ({ level: 0, tick: prev.tick + 1 })), []);

  // 视口变化：回到 0 档重算。一次拖动会连发很多次，用 rAF 合并成每帧一次
  useEffect(() => {
    const bar = ref.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        restart();
      });
    });
    observer.observe(bar);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref, restart]);

  // 内容变化（板名 / 面包屑 / 角标 / 语言 / 形态）同样回到 0 档：它们也吃宽度
  useEffect(() => restart(), [signature, restart]);

  // 每次渲染后量一次；还溢出就再升一档（下一轮再量，最多 COMPACT_MAX 轮收敛）
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    if (level < COMPACT_MAX && bar.scrollWidth > bar.clientWidth + 1) {
      setState((prev) => ({ level: prev.level + 1, tick: prev.tick }));
    }
  });

  return level;
}

export function TopBar() {
  const board = useBoardStore((state) => state.board);
  const boardId = useBoardStore((state) => state.boardId);
  const trail = useBoardStore((state) => state.trail);
  const saveHint = useBoardStore((state) => state.saveHint);
  const setDrawer = useBoardStore((state) => state.setDrawer);
  const drawer = useBoardStore((state) => state.drawer);
  const collapsed = useBoardStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useBoardStore((state) => state.toggleSidebar);
  const tool = useBoardStore((state) => state.tool);
  const setTool = useBoardStore((state) => state.setTool);
  const selectedCount = useBoardStore((state) => state.selectedCardIds.length);
  // 画布上开着筛选时，导出菜单要能只导命中的那批（口径与画布一致，判定在服务端做）
  const search = useBoardStore((state) => state.search);
  const typeFilter = useBoardStore((state) => state.typeFilter);
  const filtering = Boolean(search.trim() || typeFilter.length);
  const hitCount = useBoardStore((state) =>
    filtering ? (state.board?.cards || []).filter((card) => cardMatches(card, state.search, state.typeFilter)).length : 0,
  );
  // 待处理评论数摆在顶栏角标上：板子上还欠着几件事，不点开也看得见
  const openComments = useBoardStore(
    (state) => (state.board?.comments || []).filter((comment) => !comment.resolved).length,
  );
  // 任务功能永远开着（后端不济也有 local 兜底）；但「Agent 派单」要有真的执行方，
  // local 后端下不渲染这个入口
  const features = useFeatures();
  const browserStorage = features.browserStorage;
  const t = useT();
  const flow = useReactFlow();

  const [nameDraft, setNameDraft] = useState("");
  const [editingName, setEditingName] = useState(false);

  const [layoutMenu, setLayoutMenu] = useState<{ left: number; top: number } | null>(null);
  const [exportMenu, setExportMenu] = useState<{ left: number; top: number } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ left: number; top: number } | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const exportRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLElement | null>(null);

  /**
   * 顶栏还得放下什么，决定了要收到第几档。板名 / 面包屑 / 角标 / 语言 / 形态
   * 都会改变需要的宽度，所以它们一起进签名——变了就从 0 档重新量。
   */
  const compact = useCompactLevel(
    barRef,
    [
      board?.name || "",
      trail.length,
      openComments,
      selectedCount,
      features.browserStorage ? "b" : "s",
      features.taskBackend,
      t("top.read"),
    ].join("|"),
  );
  /** 这一档下，某个区块还留在顶栏上吗（收进「更多」的就返回 false） */
  const onBar = useCallback((need: number) => compact < need, [compact]);
  const closeMenus = useCallback(() => {
    setMoreMenu(null);
    setLayoutMenu(null);
    setExportMenu(null);
  }, []);

  useEffect(() => {
    if (!editingName) setNameDraft(board?.name || "");
  }, [board?.name, editingName]);

  // 缩放读数直接订阅 React Flow 自己的 store：事件驱动，读数照样跟手，
  // 而且画布闲着时一次多余的计时器都不跑（以前是 250ms 一直轮询）
  const zoomLabel = `${Math.round(useFlowStore((state) => state.transform[2]) * 100)}%`;

  useEffect(() => {
    if (!exportMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!exportRef.current?.contains(event.target as Node)) setExportMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [exportMenu]);

  useEffect(() => {
    if (!moreMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      // 「更多」那颗按钮自己不算「点在外面」：这个监听在捕获阶段先跑，
      // 把菜单关掉之后按钮的 onClick 才触发，那时它看到的已经是「关着」，于是又开一遍——
      // 结果就是这颗按钮只能开不能关。
      if (target?.closest?.('[data-act="more"]')) return;
      if (!moreRef.current?.contains(event.target as Node)) setMoreMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [moreMenu]);

  // 收纳档位一变，先前挂在某颗按钮下面的菜单就没有落点了，一并收掉
  useEffect(() => closeMenus(), [compact, closeMenus]);

  async function runExport(kind: "json" | "md" | "png") {
    setExportMenu(null);
    const state = useBoardStore.getState();
    if (!state.boardId || !state.board) return;
    try {
      if (kind === "json") await exportJson(state.boardId, state.board.name);
      if (kind === "md") await exportMarkdown(state.boardId, state.board.name);
      if (kind === "png") {
        // 画布平时只渲染可视区内的节点；截图截的是 DOM，先把屏幕外的也画出来再截
        state.setRenderAllNodes(true);
        try {
          await nextPaint();
          await exportPng(flow.getNodes(), state.board.name);
        } finally {
          state.setRenderAllNodes(false);
        }
      }
      state.showToast(tr("export.toast.done", { kind: kind.toUpperCase() }));
    } catch (err) {
      useBoardStore.getState().setRenderAllNodes(false);
      state.showToast(tr("export.toast.failed", { message: (err as Error).message }));
    }
  }

  /**
   * 画板包：这块板的全部（含评论与附件）+ 跟着它走的子画板。
   * 与「导出 JSON」的分工——那份是给人改完 PUT 回 whole 的**这一块板的结构**，
   * 这份是**能在另一台机器上原样立起来**的搬运件（POST 回 /api/boards/import）。
   */
  function runBundle() {
    setExportMenu(null);
    const state = useBoardStore.getState();
    if (!state.boardId) return;
    void exportBundle({ ids: [state.boardId] })
      .then(() => state.showToast(tr("export.toast.bundling")))
      .catch((err: Error) => state.showToast(tr("export.toast.failed", { message: err.message })));
  }

  /** 服务端排版导出：版式在那边算好，前端只是把文件取回来 */
  function runServerHtml(options: ServerExportOptions = {}) {
    setExportMenu(null);
    const state = useBoardStore.getState();
    if (!state.boardId) return;
    exportServerHtml(state.boardId, options);
    state.showToast(tr("export.toast.generating"));
  }

  /** 先看一眼：同一份产物，只是不触发下载 */
  function previewServerHtml() {
    setExportMenu(null);
    const state = useBoardStore.getState();
    if (!state.boardId) return;
    window.open(serverExportUrl(state.boardId, { inline: true }), "_blank", "noopener");
  }

  useEffect(() => {
    if (!layoutMenu) return;
    const close = () => setLayoutMenu(null);
    // 只在点到菜单外时关：靠 stopPropagation 的写法会依赖 React 合成事件与原生监听的先后，
    // 一旦顺序变了就会「pointerdown 先关掉菜单，click 落空」。
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setLayoutMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", close);
    };
  }, [layoutMenu]);

  async function commitName() {
    setEditingName(false);
    const state = useBoardStore.getState();
    const name = nameDraft.trim();
    if (!state.boardId || !name || name === state.board?.name) {
      setNameDraft(state.board?.name || "");
      return;
    }
    try {
      await state.renameBoard(name);
      state.showToast(tr("top.toast.renamed"));
    } catch (err) {
      state.showToast((err as Error).message);
      setNameDraft(state.board?.name || "");
    }
  }

  /** 整理布局：先记下原坐标，整理完给一个撤销入口（这操作不可逆才最烦人）。 */
  async function tidy(mode: TidyMode) {
    setLayoutMenu(null);
    const state = useBoardStore.getState();
    if (!state.board?.cards.length) {
      state.showToast(tr("top.toast.empty"));
      return;
    }
    const targetBoardId = state.boardId!;
    try {
      const count = await state.tidyLayout(mode);
      setTimeout(() => flow.fitView({ padding: canvasFitPadding(0.14), duration: 320, maxZoom: 1.2 }), 60);
      const savedRevision = useBoardStore.getState().board?.updatedAt || 0;
      const savedContent = boardEditSignature(useBoardStore.getState().board);
      state.showToast(tr("top.tidy.toast", { label: tr(tidyDoneKey(mode)), count }), count && !features.browserStorage ? {
        label: tr("top.undo"),
        run: () => void state.undoHistoryIfCurrent(targetBoardId, savedRevision, savedContent),
      } : undefined);
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  /** 打开 PDF 排版面板（设置 + 真实分页预览） */
  function openPdfPanel() {
    setExportMenu(null);
    setDrawer(drawer === "pdf" ? null : "pdf");
  }

  /**
   * 一键 PDF：用上次存下的设置直接排版 + 打印，不再问一句。
   *
   * 排版在浏览器这边做（lib/export-pdf.ts），大板子会有几秒——所以先给一条
   * 「正在排版」的提示，排完再报页数；要改纸张字号走上面那个面板。
   */
  async function runPdf() {
    setExportMenu(null);
    const state = useBoardStore.getState();
    if (!state.boardId) return;
    const settings = loadPdfSettings();
    state.showToast(tr("export.toast.pdfLaying"));
    try {
      const built = await exportBoardPdf(settings, {
        boardId: state.boardId,
        q: state.search,
        types: state.typeFilter,
        selectedIds: state.selectedCardIds,
      });
      state.showToast(tr("export.toast.pdfDone", { pages: built.pageCount }), {
        label: tr("export.pdf.tune"),
        run: async () => useBoardStore.getState().setDrawer("pdf"),
      });
    } catch (err) {
      state.showToast(tr("export.toast.pdfFailed", { message: (err as Error).message }));
    }
  }

  /**
   * 通读整块板。口径跟 R 完全一样：选中了就从那张接着往下读，没选中就从
   * 阅读顺序的第一张开始；画布上开着筛选就只读命中的那批。
   *
   * 顶栏要有这个入口，是因为在此之前进阅读模式的三个口子都得先有「一张卡」——
   * 右键菜单、卡头的放大按钮、以及 R（选中态）。想通读整块板的人，第一反应
   * 不是「先随便选一张卡」，而是在顶栏找一个「读」。
   */
  function startReading() {
    const state = useBoardStore.getState();
    const selected = state.selection?.kind === "card" ? state.selection.id : null;
    const target = selected || readingSequence(state.board?.cards, state.search, state.typeFilter)[0]?.id;
    if (!target) {
      state.showToast(tr("top.toast.empty"));
      return;
    }
    state.openReader(target);
  }

  return (
    <header ref={barRef} className="topbar" data-compact={compact}>
      {/* ── 左：去哪儿（站点导航 + 这块板是谁） ───────────────── */}
      <button
        className="sidebar-btn"
        title={collapsed ? t("top.sidebar.expand") : t("top.sidebar.collapse")}
        aria-label={collapsed ? t("top.sidebar.expand") : t("top.sidebar.collapse")}
        onClick={toggleSidebar}
      >
        {collapsed ? <UI.sidebarOpen {...ICON_MD} /> : <UI.sidebarClose {...ICON_MD} />}
      </button>
      {/* 品牌字与存储胶囊是「知道就好」的信息，最窄那一档先让位给命令 */}
      {onBar(COMPACT.chrome) ? <div className="brand">{t("top.brand")}</div> : null}
      {onBar(COMPACT.chrome) ? (
        <button
          className={`storage-mode-chip ${browserStorage ? "browser" : "server"}`}
          title={t("top.storage.title")}
          onClick={() => setDrawer(drawer === "storage" ? null : "storage")}
        >
          <span className="storage-mode-dot" />
          {browserStorage ? t("top.storage.browser", { workspace: browserWorkspace() }) : t("top.storage.server")}
        </button>
      ) : null}
      {/* 五个页面收在左上角一处：右侧只留「对当前这块板动手」的按钮（见 components/SiteNav.tsx 抬头） */}
      <SiteNav current="board" boardId={boardId} compact={!onBar(COMPACT.chrome)} />
      {trail.length ? (
        <nav className="crumbs" aria-label={t("top.crumbs.aria")}>
          {trail.map((crumb, index) => (
            <button
              key={crumb.id}
              className="crumb"
              title={t("top.crumbs.back", { name: crumb.name })}
              onClick={() => void useBoardStore.getState().popTrail(index).catch(() => undefined)}
            >
              {crumb.name || crumb.id}
            </button>
          ))}
          <span className="crumb-sep">/</span>
        </nav>
      ) : null}
      <input
        ref={nameRef}
        className="board-name"
        title={t("top.boardName.title")}
        value={nameDraft}
        readOnly={!editingName}
        disabled={!boardId}
        onFocus={() => setEditingName(true)}
        onChange={(event) => setNameDraft(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") {
            setNameDraft(board?.name || "");
            setEditingName(false);
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="save-hint">{saveHint}</span>

      <div className="spacer" />

      {/* ── 中：怎么看这块画布（手势 + 视野），两侧留白把它顶到中间 ── */}
      <div className="top-center">
        {/* 手势开关最窄那档收起来：V / H 两个快捷键还在，视野胶囊（缩放）必须留着 */}
        {onBar(COMPACT.chrome) ? (
          <div className="tool-switch" role="group" aria-label={t("top.tools.aria")}>
            <button
              className={tool === "select" ? "on" : ""}
              title={t("top.tool.select.title")}
              aria-label={t("top.tool.select")}
              onClick={() => setTool("select")}
            >
              <UI.select {...ICON_MD} />
            </button>
            <button
              className={tool === "pan" ? "on" : ""}
              title={t("top.tool.pan.title")}
              aria-label={t("top.tool.pan")}
              onClick={() => setTool("pan")}
            >
              <UI.pan {...ICON_MD} />
            </button>
          </div>
        ) : null}
        <div className="zoom-box" role="group" aria-label={t("top.zoom.aria")}>
          <button className="icon-only" title={t("top.zoom.out")} aria-label={t("top.zoom.out")} onClick={() => flow.zoomOut()}>
            <UI.zoomOut {...ICON_MD} />
          </button>
          <span className="zoom-label">{zoomLabel}</span>
          <button className="icon-only" title={t("top.zoom.in")} aria-label={t("top.zoom.in")} onClick={() => flow.zoomIn()}>
            <UI.zoomIn {...ICON_MD} />
          </button>
          <span className="tb-sep" />
          <button
            className="top-btn icon-only"
            title={t("top.zoom.fit")}
            aria-label={t("top.zoom.fit")}
            onClick={() => flow.fitView({ padding: canvasFitPadding(), maxZoom: 1.4, duration: 260 })}
          >
            <UI.fit {...ICON_MD} />
          </button>
          <button
            className="top-btn icon-only"
            title={t("top.zoom.reset")}
            aria-label={t("top.zoom.reset")}
            onClick={() => {
              flow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 200 });
              useBoardStore.getState().setViewport({ x: 0, y: 0, zoom: 1 });
            }}
          >
            <UI.reset {...ICON_MD} />
          </button>
          <button
            className="top-btn icon-only"
            title={t("top.zoom.refresh.title")}
            aria-label={t("top.zoom.refresh")}
            onClick={async () => {
              const state = useBoardStore.getState();
              try {
                await state.refreshBoard();
                state.showToast(tr("top.toast.refreshed"));
              } catch (err) {
                state.showToast((err as Error).message);
              }
            }}
          >
            <UI.refresh {...ICON_MD} />
          </button>
        </div>
      </div>

      <div className="spacer" />

      {/* ── 右：对这块板做什么，三组 ─────────────────────────── */}
      {selectedCount > 1 ? <span className="selected-hint">{t("top.selected", { count: selectedCount })}</span> : null}

      {/* ① 往板上放什么 */}
      {!features.browserStorage && onBar(COMPACT.content) ? <div className="top-group" role="group" aria-label={t("top.group.content")}>
        <button
          className={`top-btn${drawer === "templates" ? " on" : ""}`}
          title={t("top.templates.title")}
          onClick={() => setDrawer(drawer === "templates" ? null : "templates")}
        >
          <UI.template {...ICON_SM} />
          <span className="top-btn-label">{t("top.templates")}</span>
        </button>
        <button
          className={`top-btn${drawer === "specs" ? " on" : ""}`}
          title={t("top.cards.title")}
          onClick={() => setDrawer(drawer === "specs" ? null : "specs")}
        >
          <UI.code {...ICON_SM} />
          <span className="top-btn-label">{t("top.cards")}</span>
        </button>
      </div> : null}

      {/* ② 把整块板摆顺 / 读完 / 带走——三件事都是「对整块板做一次」，摆一块。
          收纳时「阅读」留到最后一档：通读整块板是这颗顶栏上最常用的动作 */}
      {onBar(COMPACT.chrome) ? (
        <div className="top-group" role="group" aria-label={t("top.group.tidyExport")}>
          {onBar(COMPACT.tidyExport) ? (
            <button
              className={`top-btn${layoutMenu ? " on" : ""}`}
              title={t("top.tidy.title")}
              onClick={(event) => {
                event.stopPropagation();
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                setLayoutMenu(layoutMenu ? null : { left: rect.left, top: rect.bottom + 6 });
              }}
            >
              <UI.tidy {...ICON_SM} />
              <span className="top-btn-label">{t("top.tidy")}</span>
            </button>
          ) : null}
          <button
            className="top-btn reader-btn"
            title={t("top.read.title")}
            onClick={startReading}
          >
            <UI.read {...ICON_SM} />
            <span className="top-btn-label">{t("top.read")}</span>
          </button>
          {onBar(COMPACT.tidyExport) ? (
            <button
              className={`top-btn${exportMenu ? " on" : ""}`}
              title={t("top.export.title")}
              aria-label={t("top.export")}
              onClick={(event) => {
                event.stopPropagation();
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                setExportMenu(exportMenu ? null : { left: rect.left - 120, top: rect.bottom + 6 });
              }}
            >
              <UI.download {...ICON_SM} />
              <span className="top-btn-label">{t("top.export")}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ③ 跟 agent 打交道：交活（评论）· 收拾残局（历史快照）· 派单（Agent） */}
      {onBar(COMPACT.collab) ? (
        <div className="top-group" role="group" aria-label={t("top.group.collab")}>
          <button
            className={`top-btn comment-btn${drawer === "comments" ? " on" : ""}${openComments ? " has-badge" : ""}`}
            title={t("top.comments.title")}
            onClick={() => setDrawer(drawer === "comments" ? null : "comments")}
          >
            <UI.comment {...ICON_SM} />
            <span className="top-btn-label">{t("top.comments")}</span>
            {openComments ? <span className="top-badge">{openComments}</span> : null}
          </button>
          {!features.browserStorage && onBar(COMPACT.extras) ? <button
            className={`top-btn${drawer === "history" ? " on" : ""}`}
            title={t("top.history.title")}
            onClick={() => setDrawer(drawer === "history" ? null : "history")}
          >
            <UI.history {...ICON_SM} />
            <span className="top-btn-label">{t("top.history")}</span>
          </button> : null}
          {onBar(COMPACT.extras) ? (
            <button
              className={`top-btn${drawer === "settings" ? " on" : ""}`}
              title={t("top.settings.title")}
              aria-label={t("top.settings")}
              onClick={() => setDrawer(drawer === "settings" ? null : "settings")}
            >
              <UI.settings {...ICON_SM} />
              <span className="top-btn-label">{t("top.settings")}</span>
            </button>
          ) : null}
          {/* Agent 自由派单要有真的执行方：local 后端给不了，入口不渲染 */}
          {features.taskBackend !== "local" ? (
            <button
              className="top-btn accent"
              title={t("top.agent.title")}
              onClick={() => setDrawer(drawer === "agent" ? null : "agent")}
            >
              <UI.agent {...ICON_SM} />
              <span className="top-btn-label">{t("top.agent")}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 「更多」：这一档收起来的命令全在这颗按钮里。**只在真的收了东西时才出现**——
          第 1 档收的是「字」，一颗命令都没走，这时候多一颗通向空菜单的按钮既没用又占宽度 */}
      {compact >= COMPACT.content ? (
        <button
          className={`top-btn more-btn${moreMenu ? " on" : ""}${!onBar(COMPACT.collab) && openComments ? " has-badge" : ""}`}
          title={t("top.more.title")}
          aria-label={t("top.more.aria")}
          aria-haspopup="menu"
          aria-expanded={Boolean(moreMenu)}
          data-act="more"
          onClick={(event) => {
            event.stopPropagation();
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            setLayoutMenu(null);
            setExportMenu(null);
            setMoreMenu(moreMenu ? null : { left: Math.max(8, rect.right - 232), top: rect.bottom + 6 });
          }}
        >
          <UI.more {...ICON_SM} />
          <span className="top-btn-label">{t("top.more")}</span>
          {!onBar(COMPACT.collab) && openComments ? <span className="top-badge">{openComments}</span> : null}
        </button>
      ) : null}
      {/* 「更多」菜单：装的就是这一档从顶栏收走的那些命令，一颗不多一颗不少。
          顺序跟它们在顶栏上的顺序一致——收起来之后还找得到同一个位置感 */}
      {moreMenu ? (
        <div ref={moreRef} className="layout-menu more-menu" role="menu" style={{ left: moreMenu.left, top: moreMenu.top }}>
          {!onBar(COMPACT.content) && !features.browserStorage ? (
            <>
              <button className="cm-item" onClick={() => { setMoreMenu(null); setDrawer(drawer === "templates" ? null : "templates"); }}>
                <UI.template size={14} strokeWidth={1.9} />
                <span className="cm-label">{t("top.templates")}</span>
              </button>
              <button className="cm-item" onClick={() => { setMoreMenu(null); setDrawer(drawer === "specs" ? null : "specs"); }}>
                <UI.code size={14} strokeWidth={1.9} />
                <span className="cm-label">{t("top.cards")}</span>
              </button>
              <div className="cm-sep" />
            </>
          ) : null}
          {!onBar(COMPACT.tidyExport) ? (
            <button
              className="cm-item"
              onClick={(event) => {
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                setMoreMenu(null);
                setLayoutMenu({ left: Math.max(8, rect.left - 40), top: rect.bottom + 6 });
              }}
            >
              <UI.tidy size={14} strokeWidth={1.9} />
              <span className="cm-label">{t("top.tidy")}</span>
            </button>
          ) : null}
          {!onBar(COMPACT.chrome) ? (
            <button className="cm-item" onClick={() => { setMoreMenu(null); startReading(); }}>
              <UI.read size={14} strokeWidth={1.9} />
              <span className="cm-label">{t("top.read")}</span>
            </button>
          ) : null}
          {!onBar(COMPACT.tidyExport) ? (
            <button
              className="cm-item"
              onClick={(event) => {
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                setMoreMenu(null);
                setExportMenu({ left: Math.max(8, rect.left - 40), top: rect.bottom + 6 });
              }}
            >
              <UI.download size={14} strokeWidth={1.9} />
              <span className="cm-label">{t("top.export")}</span>
            </button>
          ) : null}
          {!onBar(COMPACT.tidyExport) || !onBar(COMPACT.chrome) ? <div className="cm-sep" /> : null}
          {!onBar(COMPACT.collab) ? (
            <>
              <button className="cm-item" onClick={() => { setMoreMenu(null); setDrawer(drawer === "comments" ? null : "comments"); }}>
                <UI.comment size={14} strokeWidth={1.9} />
                <span className="cm-label">{t("top.comments")}</span>
                {openComments ? <span className="cm-hint">{openComments}</span> : null}
              </button>
              {features.taskBackend !== "local" ? (
                <button className="cm-item" onClick={() => { setMoreMenu(null); setDrawer(drawer === "agent" ? null : "agent"); }}>
                  <UI.agent size={14} strokeWidth={1.9} />
                  <span className="cm-label">{t("top.agent")}</span>
                </button>
              ) : null}
            </>
          ) : null}
          {!onBar(COMPACT.extras) ? (
            <>
              {!features.browserStorage ? (
                <button className="cm-item" onClick={() => { setMoreMenu(null); setDrawer(drawer === "history" ? null : "history"); }}>
                  <UI.history size={14} strokeWidth={1.9} />
                  <span className="cm-label">{t("top.history")}</span>
                </button>
              ) : null}
              <button className="cm-item" onClick={() => { setMoreMenu(null); setDrawer(drawer === "settings" ? null : "settings"); }}>
                <UI.settings size={14} strokeWidth={1.9} />
                <span className="cm-label">{t("top.settings")}</span>
              </button>
            </>
          ) : null}
          {/* 最窄那档连存储胶囊都让位了，入口在这里补回来 */}
          {!onBar(COMPACT.chrome) ? (
            <button className="cm-item" onClick={() => { setMoreMenu(null); setDrawer(drawer === "storage" ? null : "storage"); }}>
              <UI.database size={14} strokeWidth={1.9} />
              <span className="cm-label">{t("top.storage.title")}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {layoutMenu ? (
        <div ref={menuRef} className="layout-menu" style={{ left: layoutMenu.left, top: layoutMenu.top }}>
          <button className="cm-item" onClick={() => tidy("tidy")}>
            <UI.tidy size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.tidy")}</span>
            <span className="cm-hint">{t("tidy.tidy.hint")}</span>
          </button>
          <div className="cm-note">{t("tidy.note.tidy")}</div>
          <div className="cm-sep" />
          <button className="cm-item" onClick={() => tidy("LR")}>
            <UI.layoutH size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.LR")}</span>
            <span className="cm-hint">{t("tidy.LR.hint")}</span>
          </button>
          <button className="cm-item" onClick={() => tidy("TB")}>
            <UI.layoutV size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.TB")}</span>
            <span className="cm-hint">{t("tidy.TB.hint")}</span>
          </button>
          <button className="cm-item" onClick={() => tidy("flow")}>
            <UI.run size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.flow")}</span>
            <span className="cm-hint">{t("tidy.flow.hint")}</span>
          </button>
          <div className="cm-note">{t("tidy.note.flow")}</div>
          <div className="cm-sep" />
          <button className="cm-item" onClick={() => tidy("group")}>
            <UI.blocks size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.group")}</span>
            <span className="cm-hint">{t("tidy.group.hint")}</span>
          </button>
          <button className="cm-item" onClick={() => tidy("grid")}>
            <UI.grid size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.grid")}</span>
            <span className="cm-hint">{t("tidy.grid.hint")}</span>
          </button>
          <div className="cm-note">{t("tidy.note.reflow")}</div>
          <div className="cm-sep" />
          <button className="cm-item" onClick={() => tidy("timeline")}>
            <UI.timeline size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.timeline")}</span>
            <span className="cm-hint">{t("tidy.timeline.hint")}</span>
          </button>
          <button className="cm-item" onClick={() => tidy("kanban")}>
            <UI.kanban size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.kanban")}</span>
            <span className="cm-hint">{t("tidy.kanban.hint")}</span>
          </button>
          <div className="cm-note">{t("tidy.note.timeline")}</div>
          <div className="cm-sep" />
          <button className="cm-item" onClick={() => tidy("matrix")}>
            <UI.matrix size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.matrix")}</span>
            <span className="cm-hint">{t("tidy.matrix.hint")}</span>
          </button>
          <button className="cm-item" onClick={() => tidy("swimlane")}>
            <UI.swimlane size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.swimlane")}</span>
            <span className="cm-hint">{t("tidy.swimlane.hint")}</span>
          </button>
          <button className="cm-item" onClick={() => tidy("cluster")}>
            <UI.cluster size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.cluster")}</span>
            <span className="cm-hint">{t("tidy.cluster.hint")}</span>
          </button>
          <div className="cm-note">{t("tidy.note.matrix")}</div>
          <div className="cm-sep" />
          <button className="cm-item" onClick={() => flow.fitView({ padding: canvasFitPadding(), maxZoom: 1.4, duration: 260 })}>
            <UI.fit size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("tidy.fitOnly")}</span>
          </button>
        </div>
      ) : null}

      {exportMenu ? (
        <div ref={exportRef} className="layout-menu" style={{ left: exportMenu.left, top: exportMenu.top }}>
          {!features.browserStorage ? <>
          <button className="cm-item" onClick={() => void runPdf()}>
            <UI.page size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("export.pdf")}</span>
            <span className="cm-hint">{t("export.pdf.hint")}</span>
          </button>
          <button className="cm-item" onClick={() => openPdfPanel()}>
            <UI.settings size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("export.pdfSettings")}</span>
            <span className="cm-hint">{t("export.pdfSettings.hint")}</span>
          </button>
          <div className="cm-note">{t("export.note.pdf")}<b>{t("export.note.pdf.em")}</b>{t("export.note.pdf.after")}</div>
          <div className="cm-sep" />
          <button className="cm-item" onClick={() => runServerHtml()}>
            <UI.page size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("export.html")}</span>
            <span className="cm-hint">{t("export.html.hint")}</span>
          </button>
          <button className="cm-item" onClick={() => previewServerHtml()}>
            <UI.eye size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("export.preview")}</span>
            <span className="cm-hint">{t("export.preview.hint")}</span>
          </button>
          <button className="cm-item" onClick={() => runServerHtml({ comments: true })}>
            <UI.comment size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("export.review")}</span>
            <span className="cm-hint">{t("export.review.hint")}</span>
          </button>
          {filtering ? (
            <button className="cm-item" onClick={() => runServerHtml({ q: search, types: typeFilter })}>
              <UI.filter size={14} strokeWidth={1.9} />
              <span className="cm-label">{t("export.filtered")}</span>
              <span className="cm-hint">{t("export.filtered.hint", { count: hitCount })}</span>
            </button>
          ) : null}
          <div className="cm-note">{t("export.note.html")}</div>
          <div className="cm-sep" />
          </> : <div className="cm-note">{t("export.note.browser")}</div>}
          <button className="cm-item" onClick={() => runExport("png")}>
            <UI.image size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("export.png")}</span>
            <span className="cm-hint">{t("export.png.hint")}</span>
          </button>
          {!features.browserStorage ? <button className="cm-item" onClick={() => runExport("md")}>
            <UI.markdown size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("export.md")}</span>
            <span className="cm-hint">{t("export.md.hint")}</span>
          </button> : null}
          <button className="cm-item" onClick={() => runExport("json")}>
            <UI.code size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("export.json")}</span>
            <span className="cm-hint">{t("export.json.hint")}</span>
          </button>
          <button className="cm-item" onClick={() => runBundle()}>
            <UI.download size={14} strokeWidth={1.9} />
            <span className="cm-label">{t("export.bundle")}</span>
            <span className="cm-hint">{t("export.bundle.hint")}</span>
          </button>
          <div className="cm-note">
            画板包（.blotboard.json）连评论、附件与子画板一起带走，在另一台画板上「导入画板…」就立起来了；
            上面那份排版 HTML 也带着同一份数据——发出去给人看的文件，对方同样能导进自己的画板
          </div>
        </div>
      ) : null}
    </header>
  );
}
