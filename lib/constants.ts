/**
 * 前端展示常量（图标 / 默认尺寸 / 颜色 / 文案），与 goal-agent 版画板保持同一套心智。
 *
 * 文案表存的是**字典键**（`DictKey`）而不是中文：这些标签同时出现在画布、任务台、
 * 抽屉里，界面语言一换全都要跟着换，键留在表里、译文留在 lib/i18n/dicts/ 才只有一处真源。
 * 例外是 `EDGE_KIND_META`——它的 `label` 还要给**服务端导出**（lib/export-html.ts /
 * lib/export-print.ts）用，那条路上没有「当前语言」这回事，所以它保持中文原样，
 * 界面那一份另走下面的 `EDGE_KIND_LABEL_KEY` / `EDGE_KIND_HINT_KEY`。
 */
import { CARD_META_BY_TYPE } from "./card-metas";
import type { DictKey } from "./i18n";
import type { CardColor, CardType, ContextMode, EdgeKind, EdgeStyle, TaskPriority, TaskStatus } from "./types";

/**
 * 卡片类型的展示元信息——**从卡片包注册表派生**（真源在 cards/&lt;type&gt;/meta.ts）。
 * 图标见 lib/icons.tsx 的 TYPE_ICON（统一走 lucide，不用 emoji）。
 * 只有原生类型的键；数据里可能出现未知类型，按 card.type 索引前
 * 先兜底（`TYPE_META[type] || …` 或用 card-metas 的 cardMetaOf）。
 */
export const TYPE_META: Record<CardType, { label: string; size: [number, number]; color: CardColor }> =
  Object.fromEntries(
    Object.entries(CARD_META_BY_TYPE).map(([type, meta]) => [type, { label: meta.label, size: meta.size, color: meta.color }]),
  ) as Record<CardType, { label: string; size: [number, number]; color: CardColor }>;

export const COLORS: Record<CardColor, string> = {
  amber: "#f0b429",
  blue: "#6d9eeb",
  green: "#68c48f",
  violet: "#b39ddb",
  rose: "#e8927f",
  slate: "#cfd4dc",
};

/** 任务卡四态的文案键。译文与卡面页脚同一组键（cards/task/ui.tsx 也吃它们），只有一处真源。 */
export const STATUS_META: Record<TaskStatus, DictKey> = {
  idea: "cards.task.status.idea",
  issued: "cards.task.status.issued",
  running: "cards.task.status.running",
  done: "cards.task.status.done",
};

export const STATUS_DOT: Record<TaskStatus, string> = {
  idea: "#c9ccd1",
  issued: "#5b8def",
  running: "#e8a33d",
  done: "#3da169",
};

/**
 * Issue 状态文案：goal-agent 的七态（与其 src/shared/issues.js 一致）
 * + local 后端专用的三个（pending 待派 / blocked 受阻 / aborted 已中止）。
 * 同一张表两个后端共用——展示层不需要知道状态来自谁。
 */
export const ISSUE_STATUS_LABEL: Record<string, DictKey> = {
  inbox: "canvas.issue.status.inbox",
  analysis: "canvas.issue.status.analysis",
  ready: "canvas.issue.status.ready",
  pending: "canvas.issue.status.pending",
  in_progress: "canvas.issue.status.in_progress",
  blocked: "canvas.issue.status.blocked",
  review: "canvas.issue.status.review",
  done: "canvas.issue.status.done",
  aborted: "canvas.issue.status.aborted",
  parked: "canvas.issue.status.parked",
};

/** 执行态文案键：与任务卡页脚同一组（cards.task.run.*），口径见 cards/task/ui.tsx。 */
export const RUNNER_STATUS_LABEL: Record<string, DictKey> = {
  // local 后端 run 的初始态：prompt 生成了，还没有 agent 接手
  pending: "cards.task.run.pending",
  running: "cards.task.run.running",
  waiting: "cards.task.run.waiting",
  completed: "cards.task.run.completed",
  failed: "cards.task.run.failed",
  aborted: "cards.task.run.aborted",
  unknown: "cards.task.run.unknown",
};

export const PRIORITIES: Record<TaskPriority, DictKey> = {
  urgent: "cards.task.priority.urgent",
  high: "cards.task.priority.high",
  medium: "cards.task.priority.medium",
  low: "cards.task.priority.low",
  none: "cards.task.priority.none",
};

export const TASK_COLUMNS: TaskStatus[] = ["idea", "issued", "running", "done"];

/**
 * 连线语义：颜色 + 文案 + 线型（虚线用于「引用」这种弱关系）。
 *
 * **这张表的 `label` 故意仍是中文**：服务端导出（lib/export-html.ts / lib/export-print.ts）
 * 与给 agent 的画板清单都读它，那两条路上没有「当前界面语言」。
 * 界面上的语义名与解释走下面两张平行的键表。
 */
export const EDGE_KIND_META: Record<EdgeKind, { label: string; color: string; dashed: boolean; hint: string }> = {
  rel: { label: "关联", color: "#a6abaf", dashed: false, hint: "一般关联（默认）" },
  blocks: { label: "阻塞", color: "#e5484d", dashed: false, hint: "上游没完成，下游做不了" },
  enables: { label: "前置", color: "#2f855a", dashed: false, hint: "上游完成后，下游才具备条件" },
  references: { label: "引用", color: "#8e9aab", dashed: true, hint: "只是参考，不构成依赖" },
  produces: { label: "产出", color: "#9f7aea", dashed: false, hint: "上游产生了下游这个东西" },
};

/** EDGE_KIND_META 的界面那一份：语义名。 */
export const EDGE_KIND_LABEL_KEY: Record<EdgeKind, DictKey> = {
  rel: "canvas.edge.kind.rel",
  blocks: "canvas.edge.kind.blocks",
  enables: "canvas.edge.kind.enables",
  references: "canvas.edge.kind.references",
  produces: "canvas.edge.kind.produces",
};

/** EDGE_KIND_META 的界面那一份：一句话解释（菜单与工具条的 title）。 */
export const EDGE_KIND_HINT_KEY: Record<EdgeKind, DictKey> = {
  rel: "canvas.edge.kind.rel.hint",
  blocks: "canvas.edge.kind.blocks.hint",
  enables: "canvas.edge.kind.enables.hint",
  references: "canvas.edge.kind.references.hint",
  produces: "canvas.edge.kind.produces.hint",
};

/** 连线可选色：跟卡片同一套色板，线上要更实一点，所以单独给一份深色值 */
export const EDGE_COLORS: Record<CardColor, string> = {
  amber: "#d99b20",
  blue: "#3b82f6",
  green: "#3da169",
  violet: "#8b5cf6",
  rose: "#e5484d",
  slate: "#8b9099",
};

export const EDGE_STYLE_META: Record<EdgeStyle, { label: DictKey; dash?: string }> = {
  solid: { label: "canvas.edge.style.solid" },
  dashed: { label: "canvas.edge.style.dashed", dash: "6 5" },
  dotted: { label: "canvas.edge.style.dotted", dash: "2 4" },
};

export const EDGE_WIDTHS = [1.3, 1.9, 3] as const;
export const EDGE_WIDTH_LABEL: DictKey[] = ["canvas.edge.width.thin", "canvas.edge.width.normal", "canvas.edge.width.thick"];

/**
 * 关系强弱 1-5 的人话档位（BoardEdge.weight）。
 * 跟 width 的「细 / 普通 / 粗」刻意用完全不同的词——一个说的是画多粗，一个说的是有多要紧。
 */
export const EDGE_WEIGHT_LABEL: DictKey[] = [
  "canvas.edge.weight.1",
  "canvas.edge.weight.2",
  "canvas.edge.weight.3",
  "canvas.edge.weight.4",
  "canvas.edge.weight.5",
];
/** 一条连线最多挂几个标签（服务端同一个上限，真源 lib/normalize-base.ts） */
export const MAX_EDGE_TAGS = 6;

export const CONTEXT_MODE_LABEL: Record<ContextMode, DictKey> = {
  neighbors: "canvas.context.neighbors",
  upstream: "canvas.context.upstream",
  downstream: "canvas.context.downstream",
  all: "canvas.context.all",
  none: "canvas.context.none",
};

export const LS_LAST_BOARD = "blotboard_last";
export const LS_SIDEBAR = "blotboard_sidebar";
export const LS_TOOL = "blotboard_tool";
export const LS_FOCUS_MODE = "blotboard_focus";
export const LS_TOOLBOX = "blotboard_toolbox";
export const LS_SIDEBAR_W = "blotboard_sidebar_w";
/** 卡片导航页（/nav）的排序偏好：{ sort, order } */
export const LS_NAV = "blotboard_nav";
/** 画布上的评论气泡开关：读板子的时候想要清爽版，关掉它 */
export const LS_COMMENT_PINS = "blotboard_comment_pins";
/** 吸附网格开关（默认关：不擅自改变已经习惯自由摆放的人的手感） */
export const LS_SNAP_GRID = "blotboard_snap";
/**
 * 对齐吸附开关（**默认开**）。
 *
 * 跟网格吸附相反的默认值，是因为它俩改变手感的方式不一样：网格吸附时时刻刻都在拽，
 * 而对齐吸附只在你已经快要对齐的最后几个像素上帮一把——不想对齐的时候它根本不出现。
 * 让「随手一摆就是齐的」成为默认，比让人先去找个开关更符合这块板的用法。
 */
export const LS_ALIGN_SNAP = "blotboard_align_snap";
/**
 * 选中卡片上方的悬浮工具条（React Flow 官方 NodeToolbar）。**默认开**——
 * 它是快捷层不是新入口：卡头的 ⋯ 与右键菜单仍然是完整功能，这条只是把最常用的几项
 * 提到手边。嫌它挡眼睛就在工具箱里关掉（关了什么都不少）。
 */
export const LS_NODE_TOOLBAR = "blotboard_nodebar";
/**
 * 视图模式：canvas（画布，默认）/ outline（大纲）。
 * 存本地是因为它是「这个人习惯怎么看板」，跟具体哪块板无关——换板不该被重置。
 */
export const LS_VIEW_MODE = "blotboard_view";

/**
 * 对比模式最多并排几张卡。
 * 上限是屏幕给的：再多每栏就窄到读不成正文——那时候要的是阅读模式一张张翻，不是并排。
 */
export const COMPARE_MAX = 4;

/**
 * 吸附网格的格距。
 *
 * 取 22 是为了跟画布点阵对齐（BoardCanvas 的 `<Background gap={22}>`）——
 * 吸附之后卡片正好落在**看得见的那些点**上，用户能预判下一格在哪；
 * 取一个跟点阵无关的数（比如 16）看起来就像随机跳。
 * 「整理 / 对齐」（lib/layout.ts 的 GRID）用的是**同一个数**：以前那边自成一套 20，
 * 结果整理完落在 20 的倍数上、开着吸附推一张就跳到 22 的倍数——刚整齐的列被戳出豁口。
 * 一块板上只该有一把尺。
 */
export const SNAP_GRID = 22;

/**
 * 卡片缩放手柄的尺寸上下限。
 *
 * 手柄（`NodeResizer`）与缩放吸附共用这一份：吸附是在手柄算完之后再挪一点点的，
 * 各拿一套数字的话，卡片会被参考线推到手柄本来不允许的宽度上。
 */
export const CARD_SIZE_LIMITS = { minW: 150, maxW: 1200, minH: 90, maxH: 1800 };

/* ── 卡片导航页 ─────────────────────────────────── */
/** 一页拉多少张导航卡（服务端上限 400）；不够就点「加载更多」续 */
export const NAV_PAGE_SIZE = 120;
/** 「新建 / 更新」标的时间窗：24 小时内动过的才算新 */
export const NAV_FRESH_MS = 24 * 3600_000;

/** 左栏宽度：默认 242，可拖拽到 [200, 460]——长画板名需要地方 */
export const SIDEBAR_W_DEFAULT = 242;
export const SIDEBAR_W_MIN = 200;
export const SIDEBAR_W_MAX = 460;

/** 轮询节奏：抽屉打开时 3s（要看 agent 改动 / 任务进展），平时 15s。 */
export const POLL_FAST_MS = 3000;
export const POLL_SLOW_MS = 15_000;
/** 跟踪 agent 任务时的节奏：agent 改完要「直接看到」，所以更快且绕过防抖窗口。 */
export const POLL_AGENT_MS = 2000;
/** 本地写操作后的静默窗口，避免轮询把还没落库的状态盖回去。 */
export const POLL_SUPPRESS_MS = 8000;
/**
 * 当前画板没有变化时，左栏画板列表的最低刷新间隔。
 * 以前每一跳轮询都无条件拉一次列表，只为了刷新「N卡/M务」那两个数字。
 */
export const BOARDS_REFRESH_MS = 60_000;

/* ── Excalidraw 卡的体量上限 ──────────────────────────────────
   放这里而不是 board-schema：前端保存前就要按同一套数字自检，
   而 board-schema 引了 node:fs，不能进浏览器 bundle。
   source 是 .excalidraw JSON（一板所有卡共用一个 boards.json，别让一张画把它撑爆），
   thumbnail 是卡面 PNG dataURL；两者相加还要留在卡片接口的请求体上限内。 */
export const MAX_EXCALIDRAW_SOURCE = 400_000;
export const MAX_EXCALIDRAW_THUMBNAIL = 600_000;

/* 缩放下限放到 10%：两百张卡的板在 25% 时还是看不全，而看全局本来就是缩小的唯一目的。
   这个倍率下卡片正文早就糊了——那是预期：这时候要的是版面轮廓与分区，细节回到 100% 再看。 */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 2.5;

export function formatSize(bytes?: number | null): string {
  if (!Number.isFinite(Number(bytes))) return "";
  const value = Number(bytes);
  if (value > 1048576) return `${(value / 1048576).toFixed(1)} MB`;
  if (value > 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

export function formatTime(ms?: number | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString("zh-CN", {
    hour12: false,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
