"use client";

/**
 * 画板全局状态（zustand）。
 *
 * 分工：这里放「领域数据 + UI 开关 + 异步动作」；
 * 卡片拖动时的坐标由 React Flow 自己的 node state 托管（见 components/BoardCanvas.tsx），
 * 拖完才回写这里并防抖落库——拖动路径上不触发全局订阅者重渲染。
 */
import { create } from "zustand";
import { api } from "./api-client";
import { boardEditSignature } from "./history-content";
import { tr } from "./i18n/client";
import type { BoardHistoryState } from "./board-history-types";
import {
  BOARDS_REFRESH_MS,
  COMPARE_MAX,
  LS_ALIGN_SNAP,
  LS_COMMENT_PINS,
  LS_FOCUS_MODE,
  LS_LAST_BOARD,
  LS_SIDEBAR,
  LS_SIDEBAR_W,
  LS_NODE_TOOLBAR,
  LS_SNAP_GRID,
  LS_TOOL,
  LS_TOOLBOX,
  LS_VIEW_MODE,
  POLL_SUPPRESS_MS,
  SIDEBAR_W_DEFAULT,
  SIDEBAR_W_MAX,
  SIDEBAR_W_MIN,
  TYPE_META,
} from "./constants";
import { readingOrder, type TidyMode } from "./layout";
import { frameCandidateIds } from "./frames";
import { buildCardClipboard, cardClipboardBounds, type CardClipboard } from "./card-clipboard";
import { cardSearchText } from "./search-text";
import type { BoardCheckpoint, BoardImportMode, BoardImportSummary, EdgePatch, FullSpec } from "./api-client";
import type {
  BoardCard,
  BoardComment,
  BoardDetail,
  BoardListItem,
  BoardEdge,
  BoardPreviewData,
  CardType,
  CommentTarget,
  EdgeKind,
  LiveTaskStatus,
  Viewport,
} from "./types";

export type Selection = { kind: "card" | "edge"; id: string } | null;

/**
 * 看这块板的两种方式。
 *
 * canvas 是画布（二维摆放，本体）；outline 是**同一份数据的一维读法**——
 * 按阅读顺序摊成一列文本，通读与批量改标题正文比在画布上一张张点开快得多。
 * 两者共享同一份 store 与同一条 PATCH 通道，不是两套数据。
 */
export type ViewMode = "canvas" | "outline";
export type DrawerKind =
  | "storage"
  | "settings"
  | "agent"
  | "card"
  | "mindmap"
  | "excalidraw"
  | "aidocs"
  | "books"
  | "task"
  | "read"
  | "templates"
  | "specs"
  | "comments"
  | "history"
  | "pdf"
  | null;

/** 删掉的一批东西：撤销时按 卡片 → 连线 → 批注 的顺序原样放回去 */
export interface DeletedSnapshot {
  cards: BoardCard[];
  edges: BoardEdge[];
  comments: BoardComment[];
}

export interface BoardCrumb {
  id: string;
  name: string;
}

/**
 * 正在写、还没发出去的一条评论。
 *
 * screen 是**打开输入框那一刻**的屏幕坐标：输入框就固定停在那儿，不跟着画布平移跑——
 * 它是个转瞬即逝的浮层，让它跟着视口做仿射变换只会在打字时抖。
 */
export interface CommentDraft {
  target: CommentTarget;
  targetId: string | null;
  /** 画布坐标：只有钉在空白处的画布评论需要 */
  x: number | null;
  y: number | null;
  screen: { x: number; y: number };
}

/** 评论列表的过滤档：默认只看没处理完的 */
export type CommentFilter = "open" | "resolved" | "all";

/** 派出去的 agent 任务：抽屉里显示实时进展，画板同时进入快轮询 */
export interface AgentRun {
  taskId: string;
  commandTitle: string;
  startedAt: number;
  status: string;
  summary: string;
  boardTouched: boolean;
}

interface BoardStore {
  boards: BoardListItem[];
  boardId: string | null;
  board: BoardDetail | null;
  selection: Selection;
  editingCardId: string | null;
  /** 子画板下钻路径（从最外层到当前板的上一级） */
  trail: BoardCrumb[];
  focusMode: boolean;
  /** 画布 / 大纲：同一块板的两种看法（见 ViewMode） */
  viewMode: ViewMode;
  /** 吸附网格：拖动 / 缩放时卡片吸到画布点阵上（默认关，见 lib/constants.ts 的 SNAP_GRID） */
  snapGrid: boolean;
  /** 对齐吸附：拖动时吸到附近卡片的边线 / 中线 / 等间距上，并画参考线（默认开，见 lib/align-snap.ts） */
  alignSnap: boolean;
  /** 选中卡片上方的悬浮工具条（默认开；关了不少任何功能，⋯ 与右键菜单照旧） */
  nodeToolbar: boolean;
  refTarget: string | null;
  /** 子画板缩略图缓存：undefined = 没拉过，null = 目标板没了 */
  boardPreviews: Record<string, BoardPreviewData | null>;

  /**
   * 历史快照清单（改板安全网）。**只在历史抽屉打开时拉**——
   * 它跟画布上看得见的东西无关，没理由跟着每跳轮询走一遍。
   * null = 还没拉过；enabled=false 表示这台部署把快照功能关了。
   */
  checkpoints: { enabled: boolean; keep: number; items: BoardCheckpoint[] } | null;
  checkpointsLoading: boolean;
  historyState: BoardHistoryState | null;
  historyBusy: boolean;
  loadHistory: () => Promise<void>;
  undoHistory: () => Promise<void>;
  undoHistoryIfCurrent: (boardId: string, revision: number, content?: string) => Promise<void>;
  redoHistory: () => Promise<void>;
  flushPendingSave: () => Promise<void>;

  /** 卡片规格表（id → 完整规格 + 开关）。渲染规格卡与编辑表单都要它，启动时拉一次。 */
  specs: Record<string, FullSpec>;
  specsLoaded: boolean;
  /** 卡片包开关（type → enabled）；null = 清单还没拉到（工具条先全显示）。 */
  cardPacks: Record<string, boolean> | null;
  /** 任务抽屉 / 阅读弹窗当前对着哪张卡 */
  taskCardId: string | null;
  readCardId: string | null;
  /**
   * 对比模式里并排的那 2-4 张卡（空数组 = 没在对比）。
   *
   * 存 id 而不是卡片副本：对比期间 agent / 轮询改了内容，栏里跟着变才是对的——
   * 「改稿前后」这个用法本来就要求看见最新的那一版。
   */
  compareIds: string[];
  taskStatuses: Record<string, LiveTaskStatus>;
  suppressPollUntil: number;
  dragging: boolean;
  drawer: DrawerKind;
  sidebarCollapsed: boolean;
  /** 左栏宽度（px）：右边缘可拖拽，长画板名需要地方 */
  sidebarWidth: number;
  /** 左上角浮动工具箱（建卡工具条 + 画布搜索）收起成一颗小按钮 */
  toolboxCollapsed: boolean;
  saveHint: string;
  toast: { text: string; seq: number; action?: { label: string; run: () => void } } | null;
  loadError: string | null;
  /** 正在跟踪的 agent 任务（派出后自动进入，完成或手动停止后清空） */
  agentRun: AgentRun | null;
  /** 定位到某张卡片（深链 / 任务台「回到卡片」用），画布消费后清空。 */
  focusRequest: { cardId: string; seq: number } | null;
  /** 请求「适应内容」（应用模板后用）；画布拿到节点再执行，消费后清空。 */
  fitRequest: { seq: number } | null;
  /** 搜索与类型筛选：命中的卡片高亮，其余变淡 */
  search: string;
  typeFilter: CardType[];
  /** 画布主工具：select = 左键框选（卡片多了要批量选），pan = 左键平移 */
  tool: "select" | "pan";
  /**
   * 临时关掉「只渲染可视区」。
   * 导出 PNG 是把 .react-flow__viewport 这个 DOM 截下来的，
   * 屏幕外的卡片不在 DOM 里就会缺卡——导出前后各切一次。
   */
  renderAllNodes: boolean;
  /** 当前被框选/多选的卡片（React Flow 是真源，这里只做镜像，给菜单和快捷键用） */
  selectedCardIds: string[];

  /* ── 评论 ──────────────────────────────────────
     评论正文跟着 board.comments 走（轮询自带，agent 加的评论会自己冒出来），
     这里只放「此刻在写谁 / 在看谁 / 气泡显不显示」这几个纯 UI 状态。 */
  /** 正在写的那条评论；null = 没在写 */
  commentDraft: CommentDraft | null;
  /** 抽屉里高亮并滚到的那条（点画布气泡进来的） */
  activeCommentId: string | null;
  /** 画布上显不显示评论气泡 */
  showComments: boolean;
  commentFilter: CommentFilter;

  showToast: (text: string, action?: { label: string; run: () => void }) => void;
  setSelection: (selection: Selection) => void;
  setEditing: (cardId: string | null) => void;
  setDragging: (dragging: boolean) => void;
  setDrawer: (drawer: DrawerKind) => void;
  /** 聚焦模式：选中一张卡时只亮它和一跳邻居，其余淡出 */
  toggleFocusMode: () => void;
  /** 切画布 / 大纲（存 localStorage，刷新保持） */
  setViewMode: (mode: ViewMode) => void;
  /** 吸附网格开关：跟聚焦模式同一套（工具条上按一下，存 localStorage） */
  toggleSnapGrid: () => void;
  /** 对齐吸附开关（同上，默认开） */
  toggleAlignSnap: () => void;
  /** 悬浮工具条开关（同上） */
  toggleNodeToolbar: () => void;
  /** 知识库检索结果要追加到哪张资料卡（抽屉互斥会清掉 editingCardId，所以单独记一份） */
  setRefTarget: (cardId: string | null) => void;
  loadBoardPreview: (boardId: string, options?: { force?: boolean }) => Promise<void>;
  loadSpecs: (options?: { force?: boolean }) => Promise<void>;
  /** 拉一次这块板的快照清单（历史抽屉打开 / 回滚后刷新用） */
  loadCheckpoints: () => Promise<void>;
  /** 回滚到某一份快照：整块板换成那一版（回滚前服务端会自动再打一份点） */
  restoreCheckpoint: (stamp: string) => Promise<void>;
  removeCheckpoint: (stamp: string) => Promise<void>;
  /** 拉一次卡片包开关清单（工具条显隐靠它）；开关改动后传 force 重拉。 */
  loadCardPacks: (options?: { force?: boolean }) => Promise<void>;
  /** 开 / 关一个卡片包（写 card-packs.json 的 API），成功后就地更新 state——工具条即时响应。 */
  setCardPackEnabled: (type: string, enabled: boolean) => Promise<void>;
  openTaskDetail: (cardId: string | null) => void;
  openReader: (cardId: string | null) => void;
  /** 并排对比 2-4 张卡；给空数组 / 少于 2 张就是关闭 */
  openCompare: (cardIds: string[]) => void;
  toggleSidebar: () => void;
  /** 拖拽中频繁调用：只写 state，落 localStorage 交给 persist 参数控制 */
  setSidebarWidth: (width: number, persist?: boolean) => void;
  setToolboxCollapsed: (collapsed: boolean) => void;
  setSaveHint: (hint: string) => void;
  requestFocus: (cardId: string) => void;
  consumeFocus: () => void;
  requestFit: () => void;
  consumeFit: () => void;
  markTouched: (revision?: { updatedAt?: number; stale?: boolean }) => void;
  startAgentRun: (taskId: string, commandTitle: string) => void;
  stopAgentRun: () => void;
  pollAgentRun: () => Promise<void>;
  tidyLayout: (mode: TidyMode) => Promise<number>;
  alignSelection: (positions: { id: string; x: number; y: number }[]) => Promise<number>;
  setSearch: (search: string) => void;
  setTool: (tool: "select" | "pan") => void;
  setRenderAllNodes: (renderAll: boolean) => void;
  setSelectedCardIds: (ids: string[]) => void;
  removeCards: (ids: string[]) => Promise<number>;
  patchCards: (ids: string[], patch: Record<string, unknown>) => Promise<number>;
  /** 改归属：把这几张卡圈进某个分组框（frameId 给 null = 拿出来） */
  setCardsFrame: (ids: string[], frameId: string | null) => Promise<number>;
  /**
   * 显式收纳：把**几何上落在这个框里、却还没归属任何框**的自由卡收进来。
   * 只在用户点了那颗按钮时发生；返回收了几张（0 = 没有候选）。
   */
  captureFrameCards: (frameId: string) => Promise<number>;
  toggleTypeFilter: (type: CardType) => void;
  clearFilters: () => void;
  setEdgeKind: (edgeId: string, kind: EdgeKind) => Promise<void>;
  /** 连线外观（颜色 / 线型 / 粗细）；传 null 恢复「跟随语义」 */
  patchEdgeStyle: (edgeId: string, patch: EdgePatch) => Promise<void>;
  restorePositions: (positions: { id: string; x: number; y: number }[]) => Promise<void>;
  duplicateCard: (cardId: string) => Promise<BoardCard | null>;
  /** ⌘C：把这几张卡（连同它们之间的连线）放进剪贴板 */
  copyCards: (ids: string[]) => Promise<number>;
  /** ⌘V：把剪贴板里的卡片落到当前画板；data 给 null 就用内存里那份 */
  pasteCards: (
    data: CardClipboard | null,
    /** at 默认按「整批的中心落在这一点」摆（⌘V 粘在鼠标处）；align="topLeft" 是左上角对齐 */
    options?: { at?: { x: number; y: number } | null; align?: "center" | "topLeft"; silent?: boolean },
  ) => Promise<BoardCard[]>;
  /** 内存里那份剪贴板（右键菜单据此决定要不要显示「粘贴」） */
  clipboardCards: () => CardClipboard | null;
  /** 系统剪贴板写成功了没有——没成功（非安全上下文）时 ⌘V 就认内存那份 */
  clipboardIsSystem: () => boolean;

  startComment: (draft: CommentDraft) => void;
  cancelComment: () => void;
  addComment: (payload: {
    target: CommentTarget;
    targetId?: string | null;
    text: string;
    x?: number | null;
    y?: number | null;
  }) => Promise<BoardComment>;
  editComment: (commentId: string, text: string) => Promise<void>;
  resolveComment: (commentId: string, resolved: boolean) => Promise<void>;
  replyComment: (commentId: string, text: string) => Promise<void>;
  removeComment: (commentId: string) => Promise<void>;
  /** 把服务端回来的那条替换进本地表（各写操作共用） */
  mergeComment: (comment: BoardComment) => void;
  /** 开评论抽屉；给了 id 就顺便高亮那条（点画布气泡的路径） */
  openComments: (commentId?: string | null) => void;
  setActiveComment: (commentId: string | null) => void;
  setCommentFilter: (filter: CommentFilter) => void;
  toggleCommentPins: () => void;

  loadBoards: () => Promise<BoardListItem[]>;
  openBoard: (boardId: string, options?: { focusCardId?: string | null; trail?: BoardCrumb[] }) => Promise<void>;
  /** 下钻进子画板：把当前板压进面包屑，回来时按面包屑逐级返回 */
  drillInto: (boardId: string, name: string) => Promise<void>;
  popTrail: (index: number) => Promise<void>;
  refreshBoard: () => Promise<void>;
  createBoard: (name: string, options?: { parentId?: string; group?: string }) => Promise<BoardListItem>;
  /** 导入一份导出文件（画板包 / 单块板 JSON / 导出的 HTML）：新板落好后打开第一块 */
  importBoardsFile: (file: File, mode?: BoardImportMode) => Promise<BoardImportSummary>;
  /** 同上，但入参是已经读出来的原文——恢复那条路要先解析算影响摘要，不该把文件再读一遍 */
  importBoardsText: (text: string, mode?: BoardImportMode) => Promise<BoardImportSummary>;
  removeBoard: (boardId: string) => Promise<void>;
  renameBoard: (name: string) => Promise<void>;
  setBoardGroup: (boardId: string, group: string) => Promise<void>;
  setBoardParent: (boardId: string, parentId: string | null) => Promise<void>;

  createCard: (payload: Record<string, unknown> & { type?: CardType }) => Promise<BoardCard>;
  patchCard: (cardId: string, patch: Record<string, unknown>) => Promise<BoardCard>;
  absorbCard: (card: BoardCard, revision?: { updatedAt?: number; stale?: boolean }) => void;
  removeCard: (cardId: string) => Promise<void>;
  /** 删卡 + 给一次撤销机会（画布、左栏、快捷键都走它） */
  deleteCardsWithUndo: (ids: string[]) => Promise<void>;
  restoreDeleted: (snapshot: DeletedSnapshot) => Promise<void>;
  applyGeometry: (geometry: { id: string; x: number; y: number; w?: number; h?: number; z?: number }[]) => void;
  setViewport: (viewport: Viewport) => void;

  addEdge: (from: string, to: string, label?: string) => Promise<void>;
  relabelEdge: (edgeId: string, label: string) => Promise<void>;
  removeEdge: (edgeId: string) => Promise<void>;
  deleteEdgeWithUndo: (edgeId: string) => Promise<void>;

  refreshTaskStatuses: (force?: boolean) => Promise<void>;
  pollOnce: () => Promise<void>;
}

/**
 * 卡片剪贴板的内存副本。
 * 系统剪贴板是首选（跨窗口、跨机器都能粘），但它只在安全上下文里有；
 * 走 Tailscale 的 http://100.x 上 `navigator.clipboard` 是 undefined，这时就靠这一份。
 */
let memoryClipboard: CardClipboard | null = null;
let systemClipboardOk = false;
/** 超过这个大小就不往系统剪贴板塞了（内存那份照样能用）——一张 SVG 卡就能有几十 KB */
const MAX_CLIPBOARD_TEXT = 2_000_000;

// 在途的缩略图请求：用它去重，别把「加载中」写进缓存（那会被当成「板没了」）
const previewInFlight = new Set<string>();
let toastSeq = 0;
let focusSeq = 0;
let lastStatusFetch = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight: Promise<void> | null = null;
let saveGeneration = 0;
let savedGeneration = 0;
const pendingBoardActions = new Map<string, Set<Promise<unknown>>>();
let historyLoadSequence = 0;
/** 上一次真正落库的几何/视口签名：一模一样就别再发请求（切板恢复视口会走到这条路） */
let lastSavedSignature = "";
/** 左栏画板列表上次拉取时间：当前板没变化时不必每跳都刷 */
let lastBoardsFetch = 0;

/** 几何 + 视口的签名，用来判断「这次真的有变化吗」。 */
function stateSignature(boardId: string, board: BoardDetail): string {
  const viewport = board.viewport || { x: 0, y: 0, zoom: 1 };
  const head = `${boardId}|${Math.round(viewport.x || 0)},${Math.round(viewport.y || 0)},${(viewport.zoom || 1).toFixed(4)}`;
  const cards = board.cards.map((card) => `${card.id}:${card.x},${card.y},${card.w},${card.h},${card.z}`).join(";");
  return `${head}|${cards}`;
}

/** 换板 / 外部改动后重置基线，免得把「刚拉下来的状态」又原样写回去一次。 */
function primeSaveSignature(boardId: string | null, board: BoardDetail | null): void {
  lastSavedSignature = boardId && board ? stateSignature(boardId, board) : "";
  savedGeneration = saveGeneration;
}

/**
 * 「服务端上有更新的版本」之后要做的全部善后，只此一份。
 *
 * 三条路径都会走到这里：常规轮询、agent 跟踪期的快轮询、以及写操作发现 stale 后的补拉。
 * 各写各的会出岔子——之前 agent 跟踪条那句「画板已同步」就只挂在其中一条路径上，
 * 一旦改动被另一条先取走，提示就永远不出现了。
 */
function applyRemoteBoard(
  get: () => BoardStore,
  set: (partial: Partial<BoardStore>) => void,
  next: BoardDetail,
): void {
  const state = get();
  const boardId = state.boardId;
  // 迟到的响应可能属于上一块板，丢掉
  if (!boardId || (next.id && next.id !== boardId)) return;
  // 正在编辑的那张保留本地版本：用户没提交的输入不能被服务端盖掉
  const editingId = state.editingCardId;
  const editingCard = editingId ? state.board?.cards.find((card) => card.id === editingId) : null;
  const merged = editingCard
    ? { ...next, cards: next.cards.map((card) => (card.id === editingId ? editingCard : card)) }
    : next;
  set({ board: merged });
  void get().loadHistory();
  primeSaveSignature(boardId, merged);
  void get().loadBoards();
  const run = get().agentRun;
  if (run && !run.boardTouched) {
    set({ agentRun: { ...run, boardTouched: true } });
    get().showToast(tr("canvas.toast.agentSynced", { title: run.commandTitle }));
  }
}

function readLocal(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式下忽略 */
  }
}

export const useBoardStore = create<BoardStore>((set, get) => ({
  boards: [],
  boardId: null,
  board: null,
  selection: null,
  editingCardId: null,
  trail: [],
  focusMode: false,
  viewMode: "canvas",
  snapGrid: false,
  alignSnap: true,
  nodeToolbar: true,
  refTarget: null,
  boardPreviews: {},
  checkpoints: null,
  checkpointsLoading: false,
  historyState: null,
  historyBusy: false,
  specs: {},
  specsLoaded: false,
  cardPacks: null,
  taskCardId: null,
  readCardId: null,
  compareIds: [],
  taskStatuses: {},
  suppressPollUntil: 0,
  dragging: false,
  drawer: null,
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_W_DEFAULT,
  toolboxCollapsed: false,
  saveHint: "",
  toast: null,
  loadError: null,
  agentRun: null,
  focusRequest: null,
  fitRequest: null,
  search: "",
  typeFilter: [],
  tool: "select",
  renderAllNodes: false,
  selectedCardIds: [],
  commentDraft: null,
  activeCommentId: null,
  showComments: true,
  commentFilter: "open",

  showToast: (text, action) => set({ toast: { text, seq: ++toastSeq, action } }),

  /**
   * 拉一次规格表。规格是「装上就不常动」的东西，所以默认只拉一次；
   * 开关规格 / 新建规格之后调用方传 force 重拉。失败不弹 toast——
   * 画板上没有规格卡时，用户根本不该被一个读不到规格的错误打扰。
   */
  async loadSpecs({ force = false } = {}) {
    if (get().specsLoaded && !force) return;
    try {
      const { specs } = await api.listFullSpecs();
      set({ specs: Object.fromEntries(specs.map((spec) => [spec.id, spec])), specsLoaded: true });
    } catch {
      set({ specsLoaded: true });
    }
  },

  async loadHistory() {
    const boardId = get().boardId;
    if (!boardId) return;
    const sequence = ++historyLoadSequence;
    try {
      const { history } = await api.boardHistory(boardId);
      if (get().boardId === boardId && sequence === historyLoadSequence) set({ historyState: history });
    } catch {
      if (get().boardId === boardId && sequence === historyLoadSequence) set({ historyState: null });
    }
  },
  flushPendingSave: () => flushGeometrySave(get, set),
  undoHistory: () => stepHistory(get, set, "undo"),
  undoHistoryIfCurrent: (boardId, revision, content) => stepHistory(get, set, "undo", { boardId, revision, content }),
  redoHistory: () => stepHistory(get, set, "redo"),

  /** 快照清单：抽屉打开时拉一次，回滚 / 删除之后重拉。 */
  async loadCheckpoints() {
    const { boardId } = get();
    if (!boardId) return;
    set({ checkpointsLoading: true });
    try {
      const data = await api.listCheckpoints(boardId);
      // 迟到的响应可能属于上一块板，丢掉（跟整板拉取同一条规矩）
      if (get().boardId !== boardId) return;
      set({ checkpoints: { enabled: data.enabled, keep: data.keep, items: data.checkpoints || [] } });
    } catch (err) {
      get().showToast(tr("canvas.toast.checkpointsFailed", { error: (err as Error).message }));
    } finally {
      set({ checkpointsLoading: false });
    }
  },

  /**
   * 回滚：服务端把整块板换成那一版，响应直接带回新的整板，
   * 所以这里不用再拉一次——但要 primeSaveSignature，
   * 否则下一次几何防抖会把回滚前的坐标当成「本地改动」再写回去。
   */
  async restoreCheckpoint(stamp) {
    const { boardId } = get();
    if (!boardId) return;
    const result = await api.restoreCheckpoint(boardId, stamp);
    set({ board: result.board, selection: null, selectedCardIds: [], editingCardId: null });
    primeSaveSignature(boardId, result.board);
    get().markTouched({ updatedAt: result.board.updatedAt });
    void get().loadBoards();
    void get().loadCheckpoints();
    get().requestFit();
  },

  async removeCheckpoint(stamp) {
    const { boardId } = get();
    if (!boardId) return;
    await api.deleteCheckpoint(boardId, stamp);
    await get().loadCheckpoints();
  },

  /**
   * 卡片包开关清单。失败不弹 toast：拉不到就维持「全显示」，
   * 用户照常干活，服务端的新建闸门仍然兜底。
   */
  async loadCardPacks({ force = false } = {}) {
    if (get().cardPacks && !force) return;
    try {
      const { packs } = await api.listCardPacks();
      set({ cardPacks: Object.fromEntries(packs.map((pack) => [pack.type, pack.enabled])) });
    } catch {
      /* 保持 null（全显示） */
    }
  },

  async setCardPackEnabled(type, enabled) {
    const { packs } = await api.setCardPackEnabled(type, enabled);
    set({ cardPacks: Object.fromEntries(packs.map((pack) => [pack.type, pack.enabled])) });
  },
  /**
   * 单选走这里；同时同步 selectedCardIds——两份选中状态必须是一份，
   * 否则「框选多张 → 拖动 → 节点重建」时会拿单选字段把多选清掉。
   */
  setSelection: (selection) =>
    set({
      selection,
      selectedCardIds: selection?.kind === "card" ? [selection.id] : [],
    }),
  /**
   * 编辑不在卡面上做（卡面太窄）：普通卡片开右侧抽屉，导图卡开全屏弹窗——
   * 导图是一张要看全局的图，塞进 520px 的抽屉就只剩横向滚动条了。
   * Excalidraw 同理：iframe 本来就要整屏。
   */
  setEditing: (editingCardId) =>
    set((state) => {
      const card = editingCardId ? state.board?.cards.find((item) => item.id === editingCardId) : null;
      const editor: DrawerKind =
        card?.type === "mindmap" ? "mindmap" : card?.type === "excalidraw" ? "excalidraw" : "card";
      const leaving = state.drawer === "card" || state.drawer === "mindmap" || state.drawer === "excalidraw";
      return {
        editingCardId,
        drawer: editingCardId ? editor : leaving ? null : state.drawer,
        ...(editingCardId ? { suppressPollUntil: 0 } : {}),
      };
    }),
  setDragging: (dragging) => set({ dragging }),
  setDrawer: (drawer) =>
    set((state) => {
      const wasEditing =
        state.drawer === "card" || state.drawer === "mindmap" || state.drawer === "excalidraw";
      return { drawer, ...(wasEditing && drawer !== state.drawer ? { editingCardId: null } : {}) };
    }),

  setRefTarget: (refTarget) => set({ refTarget }),

  openTaskDetail: (taskCardId) =>
    set((state) => ({ taskCardId, drawer: taskCardId ? "task" : state.drawer === "task" ? null : state.drawer })),

  openReader: (readCardId) =>
    set((state) => ({ readCardId, drawer: readCardId ? "read" : state.drawer === "read" ? null : state.drawer })),

  /**
   * 并排对比。上限 4 栏是屏幕决定的——再多每栏就窄到读不成正文，
   * 那时候要的其实是阅读模式一张张翻，不是并排。
   */
  openCompare: (cardIds) => {
    const ids = [...new Set(cardIds)].slice(0, COMPARE_MAX);
    if (ids.length < 2) {
      set({ compareIds: [] });
      return;
    }
    // 对比是全屏的，跟阅读模式互斥：两个全屏弹窗叠着谁也读不了
    set({ compareIds: ids, drawer: null, readCardId: null });
  },

  /** 同一块板被多张子画板卡引用时只拉一次；改过内容想刷新就传 force */
  async loadBoardPreview(boardId, { force = false } = {}) {
    if (!force && (boardId in get().boardPreviews || previewInFlight.has(boardId))) return;
    previewInFlight.add(boardId);
    try {
      const preview = await api.boardPreview(boardId);
      set((state) => ({ boardPreviews: { ...state.boardPreviews, [boardId]: preview } }));
    } catch {
      set((state) => ({ boardPreviews: { ...state.boardPreviews, [boardId]: null } }));
    } finally {
      previewInFlight.delete(boardId);
    }
  },

  toggleFocusMode: () => {
    const next = !get().focusMode;
    writeLocal(LS_FOCUS_MODE, next ? "1" : "0");
    set({ focusMode: next });
  },
  setViewMode: (mode) => {
    writeLocal(LS_VIEW_MODE, mode);
    set({ viewMode: mode });
  },
  toggleSnapGrid: () => {
    const next = !get().snapGrid;
    writeLocal(LS_SNAP_GRID, next ? "1" : "0");
    set({ snapGrid: next });
  },
  toggleAlignSnap: () => {
    const next = !get().alignSnap;
    writeLocal(LS_ALIGN_SNAP, next ? "1" : "0");
    set({ alignSnap: next });
  },
  toggleNodeToolbar: () => {
    const next = !get().nodeToolbar;
    writeLocal(LS_NODE_TOOLBAR, next ? "1" : "0");
    set({ nodeToolbar: next });
  },
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    writeLocal(LS_SIDEBAR, next ? "1" : "0");
    set({ sidebarCollapsed: next });
  },
  setSidebarWidth: (width, persist = true) => {
    const next = Math.round(Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, width)));
    if (persist) writeLocal(LS_SIDEBAR_W, String(next));
    set({ sidebarWidth: next });
  },
  setToolboxCollapsed: (collapsed) => {
    writeLocal(LS_TOOLBOX, collapsed ? "1" : "0");
    set({ toolboxCollapsed: collapsed });
  },
  setSaveHint: (saveHint) => set({ saveHint }),
  requestFocus: (cardId) => set({ focusRequest: { cardId, seq: ++focusSeq } }),
  consumeFocus: () => set({ focusRequest: null }),
  requestFit: () => set({ fitRequest: { seq: ++focusSeq } }),
  consumeFit: () => set({ fitRequest: null }),
  setSearch: (search) => set({ search }),
  setTool: (tool) => {
    writeLocal(LS_TOOL, tool);
    set({ tool });
  },
  setRenderAllNodes: (renderAllNodes) => set({ renderAllNodes }),
  setSelectedCardIds: (ids) => {
    const current = get().selectedCardIds;
    if (current.length === ids.length && current.every((id, index) => id === ids[index])) return;
    set({ selectedCardIds: ids });
  },

  /**
   * 批量删卡：一次请求搞定。
   *
   * 以前是 for 循环一张一张 DELETE —— 框选 50 张按 Del 就是 50 次往返、
   * 服务端 50 次落盘，实测要好几秒，期间整个服务被反复堵住。
   */
  async removeCards(ids) {
    const { boardId, board } = get();
    if (!boardId || !board || !ids.length) return 0;
    const result = await api.deleteCardsBulk(boardId, ids, board.updatedAt);
    const gone = new Set(result.removed);
    set({
      board: {
        ...board,
        cards: board.cards.filter((card) => !gone.has(card.id)),
        edges: board.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to)),
      },
      selection: null,
      selectedCardIds: [],
    });
    get().markTouched(result);
    void get().loadBoards();
    return result.removed.length;
  },

  /** 批量改卡（改色、类型互转这类）：同样一次请求、服务端一次事务。 */
  async patchCards(ids, patch) {
    const { boardId, board } = get();
    if (!boardId || !board || !ids.length) return 0;
    const result = await api.patchCardsBulk(boardId, ids, patch, board.updatedAt);
    const updated = new Map(result.cards.map((card) => [card.id, card]));
    set({ board: { ...board, cards: board.cards.map((card) => updated.get(card.id) || card) } });
    get().markTouched(result);
    void get().loadBoards();
    return result.updated;
  },
  /**
   * 改分组归属。**一张卡走单卡 PATCH，多张才走批量口**——
   * 不是为了省一次请求：批量口会在服务端打一份整板快照（改板安全网），
   * 而「把一张卡拖进框」是随手操作，每拖一下刷一份快照会把真正值钱的那几份挤掉。
   * 一次regroup 好几张确实是一次批量改动，那份快照是该留的。
   */
  async setCardsFrame(ids, frameId) {
    const { boardId, board } = get();
    if (!boardId || !board || !ids.length) return 0;
    if (ids.length === 1) {
      await get().patchCard(ids[0], { frameId });
      return 1;
    }
    return get().patchCards(ids, { frameId });
  },

  /**
   * 「收纳框内卡片」。跟拖一张卡进框的区别在于**它是一次批量改动**：
   * 一律走批量口，服务端因此会先打一份整板快照、并往工作日志里记一条
   * （改板安全网的合同，见 AGENTS.md「改代码的红线」第 6 条），撤销才有东西可回。
   *
   * 候选口径在 lib/frames.ts：只收还没归属任何框的自由卡，
   * 不从别的框里抢——那是用户明确表达过的归属。
   */
  async captureFrameCards(frameId) {
    const { boardId, board } = get();
    if (!boardId || !board) return 0;
    const ids = frameCandidateIds(board.cards, frameId);
    if (!ids.length) return 0;
    return get().patchCards(ids, { frameId });
  },

  toggleTypeFilter: (type) => {
    const current = get().typeFilter;
    set({ typeFilter: current.includes(type) ? current.filter((item) => item !== type) : [...current, type] });
  },
  clearFilters: () => set({ search: "", typeFilter: [] }),

  async setEdgeKind(edgeId, kind) {
    await get().patchEdgeStyle(edgeId, { kind });
  },

  async patchEdgeStyle(edgeId, patch) {
    const { boardId, board } = get();
    if (!boardId || !board) return;
    const result = await api.patchEdge(boardId, edgeId, patch, board.updatedAt);
    set({ board: { ...board, edges: board.edges.map((item) => (item.id === edgeId ? result.edge : item)) } });
    get().markTouched(result);
  },

  /**
   * 本地刚写过：给轮询一个静默窗口，别把还没落库的状态盖回去。
   *
   * 采纳服务端回来的 updatedAt —— 这一点很要紧：以前这里盖的是**客户端**时钟，
   * 和服务端的时间戳永远对不上，于是下一跳轮询必然判定「板变了」，
   * 白拉一次整板 + 整块画布重建（大板上就是那个凭空来一下的卡顿）。
   *
   * 但只有 stale 为假时才能采纳：stale 表示「写之前手上那一版就已经过期了」。
   */
  markTouched: (revision) => {
    const { board, boards, boardId } = get();
    if (!board) return;
    if (revision?.stale) {
      // 手上的内容不完整（这中间 agent / 别的窗口写过东西）：
      // 保留旧版本号，并立刻补拉一次整块板。采纳新版本号会让那次改动被永久跳过。
      set({ suppressPollUntil: 0 });
      void get().pollOnce();
      return;
    }
    const stamp = revision?.updatedAt || Date.now();
    set({
      board: { ...board, updatedAt: stamp },
      suppressPollUntil: Date.now() + POLL_SUPPRESS_MS,
      boards: boards.map((item) => (item.id === boardId ? { ...item, updatedAt: stamp } : item)),
    });
    void get().loadHistory();
  },

  /** 派出 agent 任务后进入跟踪：抽屉里显示进展，画板轮询自动加速。 */
  startAgentRun(taskId, commandTitle) {
    set({
      agentRun: { taskId, commandTitle, startedAt: Date.now(), status: "running", summary: "", boardTouched: false },
      suppressPollUntil: 0,
    });
  },

  stopAgentRun: () => set({ agentRun: null }),

  /** 查 agent 任务状态；同时强拉一次画板（agent 的改动要立刻看得见）。 */
  async pollAgentRun() {
    const { agentRun, boardId } = get();
    if (!agentRun || !boardId) return;
    try {
      const payload = await api.runnerTask(agentRun.taskId);
      const task = payload?.task || payload || {};
      const status = String(task.status || "unknown");
      const summary = String(task.summary || "");
      if (status !== agentRun.status || summary !== agentRun.summary) {
        set({ agentRun: { ...get().agentRun!, status, summary } });
      }
    } catch {
      /* runner 忙时静默 */
    }
    // 跟踪期间不吃防抖窗口：agent 写完要立刻反映到画布（但没变化时同样只回几十字节）
    try {
      const next = await api.getBoardSince(boardId, get().board?.updatedAt);
      if (next) applyRemoteBoard(get, set, next);
    } catch {
      /* 服务暂不可达时静默 */
    }
    const finished = ["completed", "failed", "aborted"].includes(get().agentRun?.status || "");
    if (finished) {
      const run = get().agentRun!;
      get().showToast(
        run.status === "completed"
          ? tr("canvas.toast.runDone", { title: run.commandTitle })
          : tr(run.status === "failed" ? "canvas.toast.runFailed" : "canvas.toast.runAborted"),
      );
    }
  },

  /** 一键整理：整齐化或分层重排，返回受影响卡片数；调用方负责给撤销入口。 */
  async tidyLayout(mode) {
    const boardId = get().boardId;
    if (!boardId) return 0;
    await get().flushPendingSave();
    if (get().boardId !== boardId) return 0;
    const result = await api.tidyBoard(boardId, mode);
    if (get().boardId !== boardId) return result.changed;
    await get().refreshBoard();
    void get().loadBoards();
    void get().loadCheckpoints();
    return result.changed;
  },

  /** 对齐 / 等距：只动传进来的这几张，写法与整理一致（立刻落库，好给撤销）。 */
  async alignSelection(positions) {
    const boardId = get().boardId;
    if (!boardId || !positions.length) return 0;
    await get().flushPendingSave();
    if (get().boardId !== boardId) return 0;
    const board = get().board;
    if (!board) return 0;
    const changed = positions.filter((item) => {
      const current = board.cards.find((card) => card.id === item.id);
      return current && (current.x !== item.x || current.y !== item.y);
    });
    if (!changed.length) return 0;
    const byId = new Map(changed.map((item) => [item.id, item]));
    const cards = board.cards.map((card) => {
      const next = byId.get(card.id);
      return next ? { ...card, x: next.x, y: next.y } : card;
    });
    set({ board: { ...board, cards } });
    const saved = await api.saveState(
      boardId,
      { cards: cards.map((card) => ({ id: card.id, x: card.x, y: card.y, w: card.w, h: card.h, z: card.z })) },
      board.updatedAt,
    );
    if (get().boardId !== boardId) return changed.length;
    get().markTouched(saved);
    primeSaveSignature(boardId, get().board);
    return changed.length;
  },

  /** 撤销整理：把整理前的坐标写回去。 */
  async restorePositions(positions) {
    const { board, boardId } = get();
    if (!board || !boardId) return;
    const byId = new Map(positions.map((item) => [item.id, item]));
    const cards = board.cards.map((card) => {
      const prev = byId.get(card.id);
      return prev ? { ...card, x: prev.x, y: prev.y } : card;
    });
    set({ board: { ...board, cards } });
    const saved = await api.saveState(
      boardId,
      { cards: cards.map((card) => ({ id: card.id, x: card.x, y: card.y, w: card.w, h: card.h, z: card.z })) },
      board.updatedAt,
    );
    get().markTouched(saved);
    primeSaveSignature(boardId, get().board);
  },

  /**
   * 复制卡片：同类型同内容，落在原卡右下方并置顶——
   * 不置顶的话副本会被原卡压住，看起来像「没复制成功」。
   */
  /**
   * 复制卡片：走粘贴那条服务端路径。
   *
   * 以前这里是前端自己拼 payload，字段列表漏了 svg / mermaid / excalidraw / mindmap /
   * todo / ref / book / html / data / boardRef——复制一张 SVG 卡出来是张空卡。
   * 现在整张卡交给服务端 normalizeCardInput，漏不了。
   */
  async duplicateCard(cardId) {
    const { board } = get();
    const card = board?.cards.find((item) => item.id === cardId);
    if (!card) return null;
    const copy = { ...card, title: card.title ? `${card.title} 副本` : "" };
    const data = buildCardClipboard([copy as BoardCard], []);
    const created = await get().pasteCards(data, {
      at: { x: card.x + card.w + 32, y: card.y + 28 },
      align: "topLeft",
      silent: true,
    });
    return created[0] || null;
  },

  async copyCards(ids) {
    const { board } = get();
    if (!board || !ids.length) return 0;
    const wanted = new Set(ids);
    const picked = board.cards.filter((card) => wanted.has(card.id));
    if (!picked.length) return 0;
    const data = buildCardClipboard(picked, board.edges, { boardId: board.id, name: board.name });
    memoryClipboard = data;
    systemClipboardOk = false;
    const text = JSON.stringify(data);
    // 写系统剪贴板是「顺带」：成了就能粘到另一个窗口 / 另一台机器的画板上；
    // 不成（非安全上下文，比如走 Tailscale 的 http://100.x）也不影响本窗口——内存那份就够
    if (text.length <= MAX_CLIPBOARD_TEXT) {
      try {
        await navigator.clipboard?.writeText(text);
        systemClipboardOk = true;
      } catch {
        systemClipboardOk = false;
      }
    }
    get().showToast(
      data.edges.length
        ? tr("canvas.toast.copiedWithEdges", { count: picked.length, edges: data.edges.length })
        : tr("canvas.toast.copied", { count: picked.length }),
    );
    return picked.length;
  },

  async pasteCards(data, { at = null, align = "center", silent = false } = {}) {
    const { boardId, board } = get();
    const payload = data || memoryClipboard;
    if (!boardId || !board || !payload?.cards?.length) return [];
    // ⌘V 是「摆在鼠标那一点的中心」，不是让左上角顶着光标；
    // 就地复制一张（duplicate）要的是左上角对齐到指定点，否则副本会压着原卡
    const box = align === "center" ? cardClipboardBounds(payload) : { width: 0, height: 0 };
    const anchor = at ? { x: Math.round(at.x - box.width / 2), y: Math.round(at.y - box.height / 2) } : null;
    try {
      const result = await api.pasteCards(
        boardId,
        { cards: payload.cards, edges: payload.edges, at: anchor },
        board.updatedAt,
      );
      const fresh = get().board;
      if (fresh) {
        set({
          board: { ...fresh, cards: [...fresh.cards, ...result.cards], edges: [...fresh.edges, ...result.edges] },
          selectedCardIds: result.cards.map((card) => card.id),
          selection: result.cards.length === 1 ? { kind: "card", id: result.cards[0].id } : null,
        });
      }
      get().markTouched(result);
      void get().loadBoards();
      if (!silent) {
        const from = payload.from && payload.from.boardId !== boardId ? payload.from.name : "";
        get().showToast(
          from
            ? tr("canvas.toast.pastedFrom", { count: result.cards.length, name: from })
            : tr("canvas.toast.pasted", { count: result.cards.length }),
        );
      }
      return result.cards;
    } catch (err) {
      get().showToast((err as Error).message);
      return [];
    }
  },

  clipboardCards: () => memoryClipboard,
  clipboardIsSystem: () => systemClipboardOk,

  async loadBoards() {
    const boards = await api.listBoards();
    lastBoardsFetch = Date.now();
    set({ boards });
    return boards;
  },

  async openBoard(boardId, { focusCardId = null, trail = [] } = {}) {
    await get().flushPendingSave();
    const board = await api.getBoard(boardId);
    writeLocal(LS_LAST_BOARD, boardId);
    // 基线对齐到刚拉下来的状态：接下来画布恢复视口时会触发一次 setViewport，
    // 没有这一步就会把「服务端本来就是这样」的几何原样再写回去一次（每切一次板一次全量写盘）
    primeSaveSignature(boardId, board);
    set({
      board,
      boardId,
      trail,
      selection: null,
      editingCardId: null,
      taskCardId: null,
      readCardId: null,
      // 换板时把右侧抽屉里的卡片编辑收掉，别留一个指向上一块板的编辑器
      drawer: get().drawer === "card" ? null : get().drawer,
      taskStatuses: {},
      // 打开一块板 = 接下来多半要改它，父板上那张子画板卡的缩略图缓存就此作废：
      // popTrail（面包屑往回走）本来就会 force 一次，这一条管的是「从左栏直接切板」那条路，
      // 否则回到父板看到的还是改动之前的缩略图与标题
      boardPreviews: Object.fromEntries(
        Object.entries(get().boardPreviews).filter(([id]) => id !== boardId),
      ),
      // 快照清单是按板拉的：换板就作废，别把上一块板的历史留在抽屉里
      checkpoints: null,
      historyState: null,
      loadError: null,
    });
    lastStatusFetch = 0;
    void get().loadHistory();
    void get().refreshTaskStatuses(true);
    if (focusCardId) get().requestFocus(focusCardId);
  },

  async drillInto(boardId, name) {
    const { board, boardId: current, trail } = get();
    if (!current || current === boardId) return;
    // 已经在面包屑里就是「往回走」，截断而不是无限追加（A→B→A 不该越堆越长）
    const seen = trail.findIndex((crumb) => crumb.id === boardId);
    const nextTrail =
      seen >= 0 ? trail.slice(0, seen) : [...trail, { id: current, name: board?.name || current }];
    await get().openBoard(boardId, { trail: nextTrail });
  },

  async popTrail(index) {
    const { trail, boardId } = get();
    const crumb = trail[index];
    if (!crumb) return;
    await get().openBoard(crumb.id, { trail: trail.slice(0, index) });
    // 刚从子画板出来，上一层那张子画板卡的缩略图要跟着更新
    if (boardId) void get().loadBoardPreview(boardId, { force: true });
  },

  async refreshBoard() {
    const { boardId } = get();
    if (!boardId) return;
    const board = await api.getBoard(boardId);
    set({ board });
    primeSaveSignature(boardId, board);
    void get().loadHistory();
  },

  async setBoardGroup(boardId, group) {
    await api.patchBoard(boardId, { group });
    set({ boards: await api.listBoards() });
  },

  async setBoardParent(boardId, parentId) {
    await api.patchBoard(boardId, { parentId });
    set({ boards: await api.listBoards() });
  },

  async createBoard(name, options = {}) {
    const board = await api.createBoard(name, options);
    await get().loadBoards();
    return board;
  },

  /**
   * 导入：读文件 → 交给 api.importBoards → 刷新左栏 → 打开导进来的第一块板。
   *
   * 打开第一块是有意的：导入之后最想确认的就是「东西真的进来了吗」，
   * 让用户自己去左栏里找那块新板是多一步。缺件之类的提示随 toast 一起说。
   */
  async importBoardsFile(file, mode = "copy") {
    return get().importBoardsText(await file.text(), mode);
  },

  async importBoardsText(text, mode = "copy") {
    const result = await api.importBoards(text, mode);
    await get().loadBoards();
    if (result.boardIds.length) await get().openBoard(result.boardIds[0]);
    return result;
  },

  async removeBoard(boardId) {
    await api.deleteBoard(boardId);
    const boards = await get().loadBoards();
    if (get().boardId === boardId) {
      set({ board: null, boardId: null });
      if (boards.length) await get().openBoard(boards[0].id);
    }
  },

  async renameBoard(name) {
    const { boardId, board, boards } = get();
    if (!boardId || !board) return;
    const renamed = await api.renameBoard(boardId, name);
    set({
      board: { ...board, name },
      boards: boards.map((item) => (item.id === boardId ? { ...item, name } : item)),
    });
    // 改名接口本来就回整块板，直接用它的版本号
    get().markTouched({ updatedAt: renamed.updatedAt });
  },

  async createCard(payload) {
    const { boardId, board } = get();
    if (!boardId || !board) throw new Error(tr("toolbar.toast.needBoard"));
    const type = (payload.type && TYPE_META[payload.type as CardType] ? payload.type : "text") as CardType;
    const meta = TYPE_META[type];
    const result = await api.createCard(
      boardId,
      { w: meta.size[0], h: meta.size[1], color: meta.color, createdBy: "user", ...payload, type },
      board.updatedAt,
    );
    const card = result.card;
    set({ board: { ...board, cards: [...board.cards, card] } });
    get().markTouched(result);
    void get().loadBoards();
    return card;
  },

  async patchCard(cardId, patch) {
    const { boardId, board } = get();
    if (!boardId || !board) throw new Error(tr("canvas.error.boardNotReady"));
    const result = await api.patchCard(boardId, cardId, patch, board.updatedAt);
    const card = result.card;
    set({
      board: { ...board, cards: board.cards.map((item) => (item.id === cardId ? card : item)) },
    });
    get().markTouched(result);
    void get().loadBoards();
    return card;
  },

  /**
   * 服务端回来的一张卡并回本地。
   * 用在「不是用户编辑，但服务端改了这张卡」的回写上（现在只有 Issue 同步的账本），
   * 顺便采纳新版本号 —— 否则下一次编辑会因为版本对不上白跑一趟 stale 重拉。
   */
  absorbCard: (card, revision) => {
    const { board } = get();
    if (!board) return;
    set({ board: { ...board, cards: board.cards.map((item) => (item.id === card.id ? card : item)) } });
    get().markTouched(revision);
  },

  async removeCard(cardId) {
    const { boardId, board, editingCardId } = get();
    if (!boardId || !board) return;
    const result = await api.deleteCard(boardId, cardId, board.updatedAt);
    set({
      board: {
        ...board,
        cards: board.cards.filter((card) => card.id !== cardId),
        edges: board.edges.filter((edge) => edge.from !== cardId && edge.to !== cardId),
      },
      editingCardId: editingCardId === cardId ? null : editingCardId,
      selection: null,
    });
    get().markTouched(result);
    void get().loadBoards();
  },

  /**
   * 删卡的正门：先把要删的东西收进快照，删完给一条带「撤销」的提示。
   *
   * 原来这里是 window.confirm——每删一张卡都要先关一个系统弹窗，
   * 而弹窗只挡得住手滑，挡不住「删完才发现删错了」。改成删了能撤：
   * 卡片带原 id 建回去，连线和批注也认那个 id，恢复出来的是原来那一份，不是复制品。
   */
  async deleteCardsWithUndo(ids) {
    const { board } = get();
    if (!board || !ids.length) return;
    const gone = new Set(ids);
    const cards = board.cards.filter((card) => gone.has(card.id));
    if (!cards.length) return;
    // 连线和挂在卡/线上的批注都会跟着一起没，一并收好，撤销才是原样回来
    const edges = board.edges.filter((edge) => gone.has(edge.from) || gone.has(edge.to));
    const edgeIds = new Set(edges.map((edge) => edge.id));
    const comments = (board.comments || []).filter(
      (comment) =>
        (comment.target === "card" && comment.targetId && gone.has(comment.targetId)) ||
        (comment.target === "edge" && comment.targetId && edgeIds.has(comment.targetId)),
    );
    const capturedBoardId = get().boardId!;
    try {
      if (cards.length === 1) await get().removeCard(cards[0].id);
      else await get().removeCards(cards.map((card) => card.id));
    } catch (err) {
      get().showToast((err as Error).message);
      return;
    }
    const what =
      cards.length === 1
        ? tr("canvas.toast.deletedCard", { title: cards[0].title || tr("canvas.toast.deleted.untitled") })
        : tr("canvas.toast.deletedCards", { count: cards.length });
    const tail = [
      edges.length ? tr("canvas.toast.deleted.edges", { count: edges.length }) : "",
      comments.length ? tr("canvas.toast.deleted.comments", { count: comments.length }) : "",
    ].filter(Boolean);
    const savedRevision = get().board?.updatedAt || 0;
    const savedContent = boardEditSignature(get().board);
    get().showToast(tail.length ? tr("canvas.toast.deleted.tail", { what, tail: tail.join(" / ") }) : what, {
      label: tr("canvas.action.undo"),
      run: () => void get().undoHistoryIfCurrent(capturedBoardId, savedRevision, savedContent),
    });
  },

  /** 撤销删除：卡片 → 连线 → 批注，按依赖顺序放回去（批注认的是卡/线的 id） */
  async restoreDeleted(snapshot) {
    const { boardId } = get();
    if (!boardId) return;
    try {
      for (const card of snapshot.cards) await api.createCard(boardId, { ...card });
      for (const edge of snapshot.edges) await api.createEdge(boardId, { ...edge });
      for (const comment of snapshot.comments) await api.createComment(boardId, { ...comment });
      await get().refreshBoard();
      void get().loadBoards();
      get().showToast(
        snapshot.cards.length > 1
          ? tr("canvas.toast.restored", { count: snapshot.cards.length })
          : tr("canvas.toast.restoredOne"),
      );
    } catch (err) {
      // 恢复到一半失败（比如那块板被别人改过）：拉一次真状态，别让画布停在半截
      get().showToast(tr("canvas.toast.restoreFailed", { error: (err as Error).message }));
      await get().refreshBoard().catch(() => undefined);
    }
  },

  /** 拖动 / 缩放结束后回写几何，并防抖批量落库。 */
  applyGeometry(geometry) {
    const { board, boardId } = get();
    if (!board || !boardId) return;
    const byId = new Map(geometry.map((item) => [item.id, item]));
    let changed = false;
    const cards = board.cards.map((card) => {
      const next = byId.get(card.id);
      if (!next) return card;
      const updated = { ...card, x: next.x, y: next.y, w: next.w ?? card.w, h: next.h ?? card.h, z: next.z ?? card.z };
      if (updated.x === card.x && updated.y === card.y && updated.w === card.w && updated.h === card.h && updated.z === card.z) return card;
      changed = true;
      return updated;
    });
    if (!changed) return;
    set({ board: { ...board, cards } });
    scheduleSave(get, set);
  },

  setViewport(viewport) {
    const { board } = get();
    if (!board) return;
    const previous = board.viewport || { x: 0, y: 0, zoom: 1 };
    if (previous.x === viewport.x && previous.y === viewport.y && previous.zoom === viewport.zoom) return;
    set({ board: { ...board, viewport } });
    scheduleSave(get, set);
  },

  /* ── 评论 ─────────────────────────────────────────
     每个写操作都走一遍「乐观改本地 board.comments → 拿服务端版本号」，
     跟卡片/连线同一条路子：markTouched 判 stale 时会自动补拉整块板。 */

  startComment: (commentDraft) => set({ commentDraft }),
  cancelComment: () => set({ commentDraft: null }),

  async addComment(payload) {
    const { boardId, board } = get();
    if (!boardId || !board) throw new Error(tr("toolbar.toast.needBoard"));
    const result = await api.createComment(
      boardId,
      {
        target: payload.target,
        targetId: payload.targetId ?? null,
        text: payload.text,
        x: payload.x ?? null,
        y: payload.y ?? null,
      },
      board.updatedAt,
    );
    const comment = result.comment;
    set((state) => ({
      board: state.board ? { ...state.board, comments: [...(state.board.comments || []), comment] } : state.board,
      commentDraft: null,
    }));
    get().markTouched(result);
    void get().loadBoards();
    return comment;
  },

  async editComment(commentId, text) {
    const { boardId, board } = get();
    if (!boardId || !board) return;
    const result = await api.patchComment(boardId, commentId, { text }, board.updatedAt);
    get().mergeComment(result.comment);
    get().markTouched(result);
  },

  async resolveComment(commentId, resolved) {
    const { boardId, board } = get();
    if (!boardId || !board) return;
    const result = await api.patchComment(boardId, commentId, { resolved }, board.updatedAt);
    get().mergeComment(result.comment);
    get().markTouched(result);
    void get().loadBoards();
  },

  async replyComment(commentId, text) {
    const { boardId, board } = get();
    if (!boardId || !board) return;
    const result = await api.replyComment(boardId, commentId, text, board.updatedAt);
    get().mergeComment(result.comment);
    get().markTouched(result);
  },

  async removeComment(commentId) {
    const { boardId, board } = get();
    if (!boardId || !board) return;
    const result = await api.deleteComment(boardId, commentId, board.updatedAt);
    set((state) => ({
      board: state.board
        ? { ...state.board, comments: (state.board.comments || []).filter((item) => item.id !== commentId) }
        : state.board,
      activeCommentId: state.activeCommentId === commentId ? null : state.activeCommentId,
    }));
    get().markTouched(result);
    void get().loadBoards();
  },

  /** 服务端回来的那条替换掉本地同 id 的（新增走 addComment，这里只管更新）。 */
  mergeComment: (comment) =>
    set((state) => ({
      board: state.board
        ? {
            ...state.board,
            comments: (state.board.comments || []).map((item) => (item.id === comment.id ? comment : item)),
          }
        : state.board,
    })),

  openComments: (commentId = null) =>
    set((state) => ({
      drawer: "comments",
      activeCommentId: commentId,
      // 点开一条已解决的评论时自动把过滤放开，否则抽屉里根本没有它那一行
      commentFilter:
        commentId && (state.board?.comments || []).find((item) => item.id === commentId)?.resolved
          ? "all"
          : state.commentFilter,
      // 抽屉互斥：开评论就把卡片编辑收掉，免得两只抽屉叠在一起
      editingCardId: null,
    })),

  setActiveComment: (activeCommentId) => set({ activeCommentId }),
  setCommentFilter: (commentFilter) => set({ commentFilter }),
  toggleCommentPins: () => {
    const next = !get().showComments;
    writeLocal(LS_COMMENT_PINS, next ? "1" : "0");
    set({ showComments: next });
  },

  async addEdge(from, to, label = "") {
    const { boardId, board } = get();
    if (!boardId || !board) return;
    const result = await api.createEdge(boardId, { from, to, label }, board.updatedAt);
    set({ board: { ...board, edges: [...board.edges, result.edge] } });
    get().markTouched(result);
  },

  async relabelEdge(edgeId, label) {
    const { boardId, board } = get();
    if (!boardId || !board) return;
    const result = await api.patchEdge(boardId, edgeId, { label }, board.updatedAt);
    set({ board: { ...board, edges: board.edges.map((item) => (item.id === edgeId ? result.edge : item)) } });
    get().markTouched(result);
  },

  async removeEdge(edgeId) {
    const { boardId, board } = get();
    if (!boardId || !board) return;
    const result = await api.deleteEdge(boardId, edgeId, board.updatedAt);
    set({
      board: { ...board, edges: board.edges.filter((edge) => edge.id !== edgeId) },
      selection: null,
    });
    get().markTouched(result);
  },

  /** 删连线同样给一次撤销：连线带原 id 建回去，线上的批注也跟着回来 */
  async deleteEdgeWithUndo(edgeId) {
    const { board, boardId } = get();
    const edge = board?.edges.find((item) => item.id === edgeId);
    if (!edge || !boardId) return;
    const comments = (board?.comments || []).filter(
      (comment) => comment.target === "edge" && comment.targetId === edgeId,
    );
    try {
      await get().removeEdge(edgeId);
    } catch (err) {
      get().showToast((err as Error).message);
      return;
    }
    const savedRevision = get().board?.updatedAt || 0;
    const savedContent = boardEditSignature(get().board);
    get().showToast(
      comments.length
        ? tr("canvas.toast.deletedEdgeWithComments", { count: comments.length })
        : tr("canvas.toast.deletedEdge"),
      {
        label: tr("canvas.action.undo"),
        run: () => void get().undoHistoryIfCurrent(boardId, savedRevision, savedContent),
      },
    );
  },

  async refreshTaskStatuses(force = false) {
    const { board, boardId, taskStatuses } = get();
    if (!board || !boardId) return;
    const running = board.cards.filter((card) => card.type === "task" && card.task?.taskId && card.task.status === "running");
    if (!running.length) return;
    if (!force && Date.now() - lastStatusFetch < 5000) return;
    lastStatusFetch = Date.now();
    try {
      const statuses = await api.taskStatuses(boardId);
      if (JSON.stringify(statuses) !== JSON.stringify(taskStatuses)) set({ taskStatuses: statuses });
    } catch {
      /* runner 忙时静默 */
    }
  },

  /**
   * 轮询：感知 agent / 其他窗口的写入。
   * 正在编辑的卡片保留本地版本（用户输入不能被覆盖），其余跟随服务端最新。
   *
   * 带 since 做条件拉取：没变化时服务端只回几十字节，不必把整块板
   * （大的有 866 KB）每 15 秒重传一遍。左栏列表也只在本板变了、
   * 或者隔了一分钟没刷时才拉——别的窗口新建/删板仍然看得到。
   */
  async pollOnce() {
    const { boardId, board, suppressPollUntil, dragging } = get();
    if (!boardId || dragging || Date.now() < suppressPollUntil) return;
    try {
      const next = await api.getBoardSince(boardId, board?.updatedAt);
      if (next) {
        applyRemoteBoard(get, set, next);
      } else if (Date.now() - lastBoardsFetch > BOARDS_REFRESH_MS) {
        await get().loadBoards();
      }
      await get().refreshTaskStatuses();
    } catch {
      /* 服务暂不可达时静默 */
    }
  },
}));

/**
 * Track complete store actions, including their response handling and revision
 * adoption. Waiting for fetch alone would still race markTouched / refreshBoard.
 * History and flush actions are deliberately excluded to prevent self-waiting.
 */
const BOARD_WRITE_ACTIONS = [
  "createCard", "patchCard", "removeCard", "removeCards", "patchCards", "setCardsFrame", "captureFrameCards",
  "deleteCardsWithUndo", "restoreDeleted", "pasteCards", "duplicateCard",
  "addEdge", "relabelEdge", "removeEdge", "deleteEdgeWithUndo", "setEdgeKind", "patchEdgeStyle",
  "addComment", "editComment", "resolveComment", "replyComment", "removeComment",
  "renameBoard", "setBoardGroup", "setBoardParent", "restoreCheckpoint", "tidyLayout", "alignSelection", "restorePositions",
] as const;
for (const name of BOARD_WRITE_ACTIONS) {
  const original = useBoardStore.getState()[name] as (...args: any[]) => Promise<unknown>;
  const wrapped = (...args: any[]) => {
    const boardId = name === "setBoardGroup" || name === "setBoardParent" ? String(args[0]) : useBoardStore.getState().boardId;
    const result = original(...args);
    if (!boardId) return result;
    const actions = pendingBoardActions.get(boardId) || new Set<Promise<unknown>>();
    actions.add(result);
    pendingBoardActions.set(boardId, actions);
    const finish = () => {
      actions.delete(result);
      if (!actions.size && pendingBoardActions.get(boardId) === actions) pendingBoardActions.delete(boardId);
    };
    void result.then(finish, finish);
    return result;
  };
  useBoardStore.setState({ [name]: wrapped } as unknown as Partial<BoardStore>);
}

async function waitForBoardActions(boardId: string): Promise<void> {
  while (pendingBoardActions.get(boardId)?.size) {
    // New child actions can start while their parent is completing; recheck the
    // same board until all current writes have finished. Other boards never wait.
    await Promise.all([...pendingBoardActions.get(boardId)!]);
  }
}

/**
 * 几何 + 视口的防抖批量保存（600ms，与旧版一致）。
 *
 * 两处要紧的改动：
 * 1. 内容没变就不发请求。切板时恢复视口会一路走到这里，
 *    以前每切一块板都要白白重写一次整个数据文件。
 * 2. 用服务端回来的 updatedAt 更新本地版本号，
 *    否则下一跳轮询会把「我刚保存的」当成「别人改了」，再把整块板拉一遍。
 */
function scheduleSave(get: () => BoardStore, set: (partial: Partial<BoardStore>) => void): void {
  ++saveGeneration;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushGeometrySave(get, set).catch((error: Error) => get().showToast(error.message));
  }, 600);
}

async function flushGeometrySave(get: () => BoardStore, set: (partial: Partial<BoardStore>) => void): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (saveInFlight) await saveInFlight;
  const generation = saveGeneration;
  if (generation === savedGeneration) return;
  const { boardId, board } = get();
  if (!boardId || !board) return;
  const signature = stateSignature(boardId, board);
  if (signature === lastSavedSignature) { savedGeneration = generation; return; }
  const cards = board.cards.map((card) => ({ id: card.id, x: card.x, y: card.y, w: card.w, h: card.h, z: card.z }));
  const viewport = { x: Math.round(board.viewport?.x || 0), y: Math.round(board.viewport?.y || 0), zoom: board.viewport?.zoom || 1 };
  const pending = api.saveState(boardId, { viewport, cards }, board.updatedAt).then(async (saved) => {
    const state = get();
    if (state.boardId !== boardId || !state.board) return;
    if (saved.stale) {
      await state.refreshBoard();
      throw new Error(tr("canvas.error.parallelEdit"));
    }
    lastSavedSignature = signature;
    savedGeneration = generation;
    set({
      saveHint: tr("canvas.saveHint", { time: new Date().toLocaleTimeString("zh-CN", { hour12: false }) }),
      board: { ...state.board, updatedAt: saved.updatedAt },
      boards: state.boards.map((item) => (item.id === boardId ? { ...item, updatedAt: saved.updatedAt } : item)),
    });
    void state.loadHistory();
  }).catch((error) => {
    lastSavedSignature = "";
    set({ saveHint: "" });
    throw error;
  });
  saveInFlight = pending;
  try { await pending; }
  finally { if (saveInFlight === pending) saveInFlight = null; }
}

async function stepHistory(get: () => BoardStore, set: (partial: Partial<BoardStore>) => void, direction: "undo" | "redo", expected?: { boardId: string; revision: number; content?: string }): Promise<void> {
  if (get().historyBusy || !get().boardId) return;
  const boardId = get().boardId!;
  set({ historyBusy: true });
  try {
    await waitForBoardActions(boardId);
    if (get().boardId !== boardId) return;
    await get().flushPendingSave();
    if (get().boardId !== boardId || !get().board) return;
    if (expected && (boardId !== expected.boardId || (expected.content !== undefined
      ? boardEditSignature(get().board) !== expected.content
      : get().board!.updatedAt !== expected.revision))) {
      get().showToast(tr("canvas.toast.historyStale"));
      return;
    }
    const result = await api.stepHistory(boardId, direction, get().board!.updatedAt);
    if (get().boardId !== boardId) return;
    ++historyLoadSequence;
    set({ board: result.board, historyState: result.history, selection: null, selectedCardIds: [], editingCardId: null });
    primeSaveSignature(boardId, result.board);
    get().markTouched({ updatedAt: result.board.updatedAt });
    void get().loadBoards();
    void get().loadCheckpoints();
    get().showToast(tr(direction === "undo" ? "canvas.toast.undone" : "canvas.toast.redone", { label: result.label }));
  } catch (error) {
    if (get().boardId === boardId) {
      get().showToast((error as Error).message);
      await get().refreshBoard().catch(() => undefined);
    }
  } finally { set({ historyBusy: false }); }
}

/** 启动时恢复侧栏折叠状态（localStorage 只能在浏览器读）。 */
export function hydrateUiPrefs(): void {
  const tool = readLocal(LS_TOOL) === "pan" ? "pan" : "select";
  const savedWidth = Number(readLocal(LS_SIDEBAR_W));
  useBoardStore.setState({
    sidebarCollapsed: readLocal(LS_SIDEBAR) === "1",
    sidebarWidth: Number.isFinite(savedWidth) && savedWidth > 0
      ? Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, savedWidth))
      : SIDEBAR_W_DEFAULT,
    toolboxCollapsed: readLocal(LS_TOOLBOX) === "1",
    tool,
    focusMode: readLocal(LS_FOCUS_MODE) === "1",
    // 没存过就是画布：大纲是主动选择的读法，不该在第一次打开时替人做决定
    viewMode: readLocal(LS_VIEW_MODE) === "outline" ? "outline" : "canvas",
    // 没存过就是关着：网格吸附一路都在拽着卡片走，改的是全程手感，得由用户主动要
    snapGrid: readLocal(LS_SNAP_GRID) === "1",
    // 没存过就是开着：对齐吸附只在最后几个像素上帮一把，不想对齐时它根本不出现
    alignSnap: readLocal(LS_ALIGN_SNAP) !== "0",
    // 没存过就是开着：评论本来就该一眼看见，「关掉」是主动选择
    showComments: readLocal(LS_COMMENT_PINS) !== "0",
    // 没存过就是开着：悬浮工具条是快捷层，关掉不少任何功能（⋯ 与右键菜单照旧）
    nodeToolbar: readLocal(LS_NODE_TOOLBAR) !== "0",
  });
}

/**
 * 一张卡的一跳邻居（含自己）：聚焦模式用它决定谁还亮着。
 * 只算直接连线，不做传递闭包——「直接关联」才是用户点开一张卡时想看的那一圈。
 */
export function focusSetOf(board: BoardDetail | null, cardId: string | null): Set<string> | null {
  if (!board || !cardId) return null;
  const keep = new Set<string>([cardId]);
  for (const edge of board.edges || []) {
    if (edge.from === cardId) keep.add(edge.to);
    if (edge.to === cardId) keep.add(edge.from);
  }
  return keep;
}

export function lastBoardId(): string | null {
  return readLocal(LS_LAST_BOARD);
}

/** 搜索 + 类型筛选：返回该卡是否命中当前过滤条件（没设过滤时全部命中）。 */
export function cardMatches(card: BoardCard, search: string, typeFilter: CardType[]): boolean {
  if (typeFilter.length && !typeFilter.includes(card.type)) return false;
  const keyword = search.trim().toLowerCase();
  if (!keyword) return true;
  return cardSearchText(card).includes(keyword);
}

export function relatedOf(cardId: string): { up: BoardCard[]; down: BoardCard[] } {
  const board = useBoardStore.getState().board;
  const byId = new Map((board?.cards || []).map((card) => [card.id, card]));
  const up: BoardCard[] = [];
  const down: BoardCard[] = [];
  for (const edge of board?.edges || []) {
    if (edge.to === cardId && byId.has(edge.from)) up.push(byId.get(edge.from)!);
    if (edge.from === cardId && byId.has(edge.to)) down.push(byId.get(edge.to)!);
  }
  return { up, down };
}

/**
 * 阅读序列：整块板压成一条「从上到下、同排从左到右」的顺序，阅读模式靠它左右翻卡。
 *
 * 筛选生效时只读命中的那些（画布上淡掉的卡本来就不是你此刻要看的）；
 * 但如果当前打开的这张自己就被筛掉了（右键直接开的），退回整板顺序——
 * 序列里没有「现在这张」的话，左右键就没有起点了。
 *
 * 标了「阅读时跳过」的卡在这里被摘掉（`reading.skip`，见 lib/types.ts）。
 * 两处例外都留着入口：**筛选**的退路是上面那条（整板兜底），
 * **跳过**的退路是「从这张卡直接打开阅读」时仍然读得到它——
 * 否则用户右键一张跳过的卡点「摊开看」，会开出别的卡来。
 * 跳过只影响阅读模式：导出与大纲照旧收录整块板（产物少内容比顺序不对更糟）。
 */
export function readingSequence(
  cards: BoardCard[] | null | undefined,
  search: string,
  typeFilter: CardType[],
  currentId?: string | null,
): BoardCard[] {
  const all = cards || [];
  const filtering = Boolean(search.trim() || typeFilter.length);
  const pool = filtering ? all.filter((card) => cardMatches(card, search, typeFilter)) : all;
  const list = currentId && !pool.some((card) => card.id === currentId) ? all : pool;
  return readingOrder(list.filter((card) => !card.reading?.skip || card.id === currentId));
}

/* ── 评论：画布上的落点 ─────────────────────────────
   气泡钉在哪是「看板子」时算得出来的纯几何，不该进 store —— 卡片一拖，
   位置就得跟着变，存一份就永远差一帧。 */

/** 一撮共用一个落点的评论（同一张卡上的多条评论只画一枚气泡，标个数字）。 */
export interface CommentPin {
  /** 分组键：卡片/连线用目标 id，画布评论各算各的（它们各钉各的点） */
  key: string;
  x: number;
  y: number;
  comments: BoardComment[];
}

/**
 * 把评论摊成画布上的气泡。
 * 已解决的不画——「解决了」的意思就是不用再在板子上看见它，要翻档案去抽屉里切「已解决」。
 */
export function commentPins(board: BoardDetail | null): CommentPin[] {
  if (!board) return [];
  const byId = new Map((board.cards || []).map((card) => [card.id, card]));
  const edgeById = new Map((board.edges || []).map((edge) => [edge.id, edge]));
  const groups = new Map<string, CommentPin>();

  for (const comment of board.comments || []) {
    if (comment.resolved) continue;
    let key = "";
    let point: { x: number; y: number } | null = null;

    if (comment.target === "card" && comment.targetId) {
      const card = byId.get(comment.targetId);
      // 气泡蹲在卡片右上角外沿：那里既不压正文，拖卡片时也跟着走
      if (card) point = { x: card.x + card.w - 10, y: card.y - 10 };
      key = `card:${comment.targetId}`;
    } else if (comment.target === "edge" && comment.targetId) {
      const edge = edgeById.get(comment.targetId);
      const from = edge ? byId.get(edge.from) : null;
      const to = edge ? byId.get(edge.to) : null;
      if (from && to) {
        point = {
          x: (from.x + from.w / 2 + to.x + to.w / 2) / 2,
          y: (from.y + from.h / 2 + to.y + to.h / 2) / 2,
        };
      }
      key = `edge:${comment.targetId}`;
    } else if (comment.x !== null && comment.y !== null) {
      point = { x: comment.x, y: comment.y };
      key = `pin:${comment.id}`;
    }

    // 目标还在但坐标算不出来（连线两头的卡没了），或者整板留言（不钉点）：只在抽屉里出现
    if (!point) continue;
    const existing = groups.get(key);
    if (existing) existing.comments.push(comment);
    else groups.set(key, { key, x: point.x, y: point.y, comments: [comment] });
  }
  return [...groups.values()];
}

/** 某张卡 / 某条连线上还没处理的评论条数：卡面角标与右键菜单文案都看它。 */
export function openCommentCount(board: BoardDetail | null, target: CommentTarget, targetId: string): number {
  return (board?.comments || []).filter(
    (comment) => !comment.resolved && comment.target === target && comment.targetId === targetId,
  ).length;
}
