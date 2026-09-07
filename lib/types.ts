/**
 * 画板数据模型（前后端共享）。
 * 字段形状与 goal-agent `src/web/board.js` 的 boards.json 100% 一致——迁移即原样搬。
 */
import type { UploadKind } from "./upload-accept";

export type { UploadKind };

export const BOARD_CARD_TYPES = ["text", "task", "link", "quote", "image", "media", "pdf", "ref", "board", "mindmap", "todo", "svg", "mermaid", "excalidraw", "data", "book", "html", "code", "table", "chart", "frame"] as const;
export type CardType = (typeof BOARD_CARD_TYPES)[number];

export const CARD_COLORS = ["amber", "blue", "green", "violet", "rose", "slate"] as const;
export type CardColor = (typeof CARD_COLORS)[number];

export const TASK_STATUSES = ["idea", "issued", "running", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** 连线语义：默认 rel（一般关联），其余四种给工作流用 */
export const EDGE_KINDS = ["rel", "blocks", "enables", "references", "produces"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** 连线线型：语义决定默认线型，这里可单独覆盖 */
export const EDGE_STYLES = ["solid", "dashed", "dotted"] as const;
export type EdgeStyle = (typeof EDGE_STYLES)[number];

/** 转 Issue 时带哪些画板上下文 */
export const CONTEXT_MODES = ["neighbors", "upstream", "downstream", "all", "none"] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

/** Issue 自动同步开关：auto = 编辑保存后自动推；off = 只在手动点同步 / 发起任务前推 */
export const ISSUE_SYNC_MODES = ["auto", "off"] as const;
export type IssueSyncMode = (typeof ISSUE_SYNC_MODES)[number];

export interface IssueContextPolicy {
  mode: ContextMode;
  /** 只带这些类型的卡片；空数组 = 不限类型 */
  types: CardType[];
}

export interface TaskField {
  status: TaskStatus;
  goal: string;
  priority: TaskPriority;
  issueId: string | null;
  issueNumber: string | null;
  taskId: string | null;
  taskStatus: string | null;
  /** 上一次成功推给 Goal Agent 的时刻（自动回写，前端只读） */
  issueSyncedAt: number | null;
  /**
   * 上一次推过去的那份 Issue 正文的指纹（title + description + priority）。
   * 只有指纹变了才真的发请求 —— 改个颜色、挪个位置不该惊动 Goal Agent。
   */
  issueSyncHash: string | null;
  /** 上一次推送失败的原因；成功后清空 */
  issueSyncError: string | null;
}

export interface LinkField {
  url: string;
  host: string;
  title: string;
  desc: string;
}

export interface QuoteField {
  source: string;
}

/** 知识库检索结果里的一条（来源由 `AIDOCS_URL` 指定的服务） */
export interface RefItem {
  /** 知识库的 resource_id，形如 doc:bilibili:186864 */
  resourceId: string;
  title: string;
  /** 原始出处（B站/公众号…）；资料卡默认打开的是知识库里的那篇，这个只作次要入口 */
  url?: string;
  platform?: string;
  /** 知识库内的文档主键，用来拼 /document/{docId}?platform= */
  docId?: string;
  snippet?: string;
  score?: number | null;
}

/**
 * 图书卡（来源由 `BOOK_LIBRARY_URL` 指定的本机书库索引）。
 *
 * 跟资料卡同一条红线——**书不搬进画板**：这里只留 bookId 与一份摆得出卡面的元信息，
 * 封面走 `/api/books/{bookId}/cover` 现取（书库重新生成封面，卡面跟着变），
 * 正文 / PDF / Markdown 三个入口都回书库打开。
 */
export interface BookField {
  /** 书库里的书 id，封面与三个阅读入口都按它拼 */
  bookId: string;
  name: string;
  subtitle?: string;
  author?: string;
  desc?: string;
  /** 书库登记的产物文件名；有哪个就给哪个入口（在线读 / PDF / Markdown） */
  files?: { html?: string; pdf?: string; md?: string };
  /** 写这本书用的模型 / 流水线版本，卡面当元信息显示 */
  model?: string;
  created?: string;
  updated?: string;
  /** 从书库抓下来的时刻：元信息是快照，书库改了名字这里不会自己变 */
  fetchedAt: number;
}

export const REF_MODES = ["hybrid", "vector"] as const;
export type RefMode = (typeof REF_MODES)[number];

/** 参考资料组：一次检索选中的若干条，攒成一张卡当参考素材 */
export interface RefField {
  source: "aidocs";
  query: string;
  mode: RefMode;
  items: RefItem[];
  fetchedAt: number;
}

/** 子画板卡：把另一块画板当成本板上的一个节点，双击下钻进去 */
export interface BoardRefField {
  boardId: string;
  /** 冗余存一份名字：目标板被删了也还看得出这张卡原来指的是什么 */
  name: string;
}

/** 思维导图节点（子卡片形态的最简导图） */
export interface MindNode {
  id: string;
  text: string;
  collapsed?: boolean;
  children: MindNode[];
}

/** 导图布局：右侧单展开，或左右双侧分叉（根节点居中） */
export const MIND_LAYOUTS = ["right", "both"] as const;
export type MindLayout = (typeof MIND_LAYOUTS)[number];

/** 导图预设风格：只改字块与连线的样子，不动结构 */
export const MIND_THEMES = ["classic", "pill", "plain", "card"] as const;
export type MindTheme = (typeof MIND_THEMES)[number];

export interface MindmapField {
  root: MindNode;
  layout?: MindLayout;
  theme?: MindTheme;
}

/** 待办清单里的一条（收集箱：先记下来，之后再决定要不要变成任务卡） */
export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  doneAt?: number | null;
}

export interface TodoField {
  items: TodoItem[];
}

/** 手写 / agent 生成的 SVG 图；卡面按 data URI 当图片渲染，脚本不执行 */
export interface SvgField {
  source: string;
}

/** Mermaid 图（流程图 / 时序图 / 甘特…）；源码存这里，渲染在前端做 */
export interface MermaidField {
  source: string;
}

/* ── 代码卡（code）：一段源码 + 语言标识 ───────────────────── */

/**
 * 代码卡。
 *
 * 与 mermaid / svg 卡的分工：那两种是「源码画出一张图」，这一种是「源码本身就是内容」——
 * 卡面等宽显示 + 语法高亮，不做任何求值。高亮库在浏览器里**按需 import**
 * （见 components/cards/CodeCard.tsx），没有代码卡的板一个字节都不为它买单。
 */
export interface CodeField {
  /** 源码原文，逐字保存（不 trim 行内空白：缩进是代码的一部分） */
  source: string;
  /**
   * 短语言标识，小写，如 `ts` / `python` / `bash`。
   * 空串 = 不标语言，卡面按纯文本等宽显示（仍然是一张合法的代码卡）。
   */
  language: string;
  /** 这段代码在哪个文件里（`lib/store.ts`）；卡面与导出都显示，纯展示不做校验 */
  filename?: string;
}

/* ── 表格卡（table）：行列数据，Markdown / CSV 都能直接塞 ───── */

export const TABLE_ALIGNS = ["left", "center", "right"] as const;
export type TableAlign = (typeof TABLE_ALIGNS)[number];

export interface TableColumn {
  /** 行对象里的键；由表头文字派生（重名自动加后缀），调用方也可以自己指定 */
  key: string;
  label: string;
  align?: TableAlign;
}

/**
 * 表格卡：**单元格一律是纯文本**。
 * 不支持嵌套 / 富文本 / 公式——那是电子表格的活，一张卡片装不下，也没法在卡面上一眼看完。
 */
export interface TableField {
  columns: TableColumn[];
  /** 行按列的 `key` 取值；缺的键当空字符串 */
  rows: Record<string, string>[];
  caption?: string;
}

/* ── 图表卡（chart）：填数据，不写语法 ─────────────────────── */

/** 支持的图表种类；每一种对应一段 mermaid 源码（映射见 cards/chart/source.ts） */
export const CHART_KINDS = ["bar", "line", "pie", "quadrant"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** 一条数据系列（bar / line 用）：values 与 labels 一一对应 */
export interface ChartSeries {
  name?: string;
  values: number[];
}

/** 饼图的一瓣 */
export interface ChartSlice {
  label: string;
  value: number;
}

/** 四象限图上的一个点：x / y 都在 [0,1] 区间 */
export interface ChartPoint {
  label: string;
  x: number;
  y: number;
}

/**
 * 图表卡。
 *
 * 与 mermaid 卡的分界线：**这张卡不写语法**。调用方只给「什么图 + 什么数据」，
 * 卡片自己翻成 mermaid 源码再交给同一条渲染路径（cards/chart/source.ts →
 * components/cards/DiagramCard 的 MermaidCard）。agent 写 mermaid 的 xychart 语法
 * 极易写错（缩进 / 方括号 / 引号），而它手上本来就是一组数——让它填数就行。
 */
export interface ChartField {
  kind: ChartKind;
  title?: string;
  /* bar / line：labels 是 x 轴刻度，series 是一条条折线 / 一组组柱子 */
  labels?: string[];
  series?: ChartSeries[];
  xLabel?: string;
  yLabel?: string;
  /* pie */
  slices?: ChartSlice[];
  /* quadrant：axes 是两根轴的端点文字，quadrants 是四个象限的名字 */
  axes?: { x?: [string, string]; y?: [string, string] };
  quadrants?: string[];
  points?: ChartPoint[];
}

/* ── HTML 嵌入卡（html）：外部 PPT / 网页，沙箱 iframe 渲染 ───────── */

/** 卡面加载时机：auto = 进可视区自动加载；manual = 点一下才加载（重页面 / 一板十几张时省资源） */
export const HTML_EMBED_MODES = ["auto", "manual"] as const;
export type HtmlEmbedMode = (typeof HTML_EMBED_MODES)[number];

/**
 * HTML 嵌入卡。
 *
 * 只存 URL，**不存 HTML 正文**——卡面是一个 sandbox iframe，里面跑的是别人的脚本：
 * 「能嵌什么」由服务端白名单说了算（lib/embed-allow.ts，写入时校验，非白名单域 400），
 * 「嵌进来的东西能干什么」由 iframe 的 sandbox 属性说了算（components/cards/HtmlCard.tsx）。
 * 这两条是这张卡唯一的安全边界，改任何一条之前先看 README 的「HTML 嵌入卡」一节。
 */
export interface HtmlField {
  /** 被嵌页面地址；只允许 http(s)，且 host 要过白名单 */
  url: string;
  /** 从 url 解出来的 host（含端口），卡面页脚显示用，与 link 卡同一套 */
  host: string;
  mode: HtmlEmbedMode;
  /**
   * 被嵌页面的**逻辑视口**：卡面按它等比缩放（PPT 常见 1280×720 / 960×540）。
   * 0 = 不缩放，iframe 直接铺满卡片（页面自己是响应式的时候用这个）。
   */
  frameW: number;
  frameH: number;
}

/* ── 规格卡（data）：按一份「卡片规格」填好的结构化信息 ───────────── */

/** 字段值：标量 / 标量数组（tags）/ 一层对象数组（list）。刻意不支持任意嵌套——
 *  卡片是给人一眼看的，嵌套三层的 JSON 没法在一张卡上显示，也没法在表单里改。 */
export type DataScalar = string | number | boolean | null;
export type DataValue = DataScalar | DataScalar[] | Record<string, DataScalar>[];

/** 这张卡从哪个外部系统来（飞书 / 公众号 / GitHub…），回溯与去重都靠它 */
export interface DataSource {
  /** 来源系统标识，如 feishu / wechat / github */
  app?: string;
  /** 原始出处链接 */
  url?: string;
  /** 对方系统里的主键（消息 id / 文档 token / issue number…），同规格 + 同 externalId = 同一张卡 */
  externalId?: string;
  fetchedAt?: number;
}

export interface DataField {
  /** 引用哪份卡片规格（kebab-case，见 data/card-specs/*.json） */
  specId: string;
  /** 写入时的规格版本；规格升级后靠它判断这张卡是不是老结构 */
  specVersion: number;
  /** 按规格 fields 填的值；规格不在本机时原样保留（降级成 key-value 表显示） */
  fields: Record<string, DataValue>;
  source?: DataSource;
}

/**
 * Excalidraw 自由画：完整 .excalidraw JSON + 卡面缩略图（PNG dataURL）。
 * 编辑走双击全屏弹窗，里面跑的就是官方 @excalidraw/excalidraw 组件，
 * 保存时同步写回 source 和缩略图。缩略图只是加速卡面——没有它，
 * 卡面会拿 source 现场渲一张（见 components/cards/DiagramCard.tsx）。
 */
export interface ExcalidrawField {
  /** .excalidraw JSON 字符串（normalize 会剥 script 标签、on* 属性、javascript: 协议） */
  source: string;
  /** PNG dataURL，给卡面当缩略图用；可空（用户还没保存过） */
  thumbnail?: string;
  /** 最近一次保存时间戳（毫秒），给卡面显示「已同步」 */
  updatedAt?: number;
}

/* ── 分组框（frame）：把几张卡圈进一个框，整体拖动 ─────────────
   **跟子画板卡（board）的分界线**：board 卡是「下钻到另一块板」（另一份数据、另一个视口、
   自己的卡片与连线）；frame 是「就在本板圈一块地」（同一份数据，只是多了一层归属）。
   要把一堆东西挪出视线用 board，要把一堆东西一起搬用 frame。 */

/**
 * 分组框卡。
 *
 * **为什么叫 frame 不叫 group**：这仓库里 `group` 这个词已经被占了两次——
 * 布局模式 `group`（按类型分区）与 `Board.group`（分组 / 项目名）。
 * 再来一个「分组框」会让「整理成 group」「板的 group」「卡的 group」三件事互相打架。
 *
 * 框的标题就是卡片自己的 `title`（不另设 frame.title：一个东西两处真源，
 * 迟早会有一处忘了改）；尺寸就是卡片的 w/h——框有多大就圈多大。
 */
export interface FrameField {
  /** 折叠：子卡在画布上隐藏，框上只显示计数（数据一张不动，只是不画） */
  collapsed: boolean;
}

/**
 * 上传件的引用（image / media / pdf 三种卡共用一个 `file` 字段）。
 *
 * `kind` 决定卡面怎么渲染：image → `<img>`、audio/video → `<audio>`/`<video>`、file → 文件条。
 * 它由服务端按上传件 id 的扩展名**推导**（见 cards/image/schema.ts），不信调用方报的值——
 * 一个 .mp4 说自己是 image 只会得到一张裂图。老数据里只有 image / file 两种值，
 * 推导出来的结果与它们一致，所以这是个向后兼容的扩展。
 */
export interface FileField {
  uploadId?: string;
  name?: string;
  kind?: UploadKind;
  mediaType?: string;
  size?: number | null;
  /** 仅在下发前端时补上，不落库 */
  url?: string;
  previewUrl?: string | null;
}

export interface BoardCard {
  id: string;
  type: CardType;
  createdAt: number;
  updatedAt?: number;
  createdBy: "user" | "agent";
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  color: CardColor;
  title: string;
  content: string;
  task?: TaskField;
  link?: LinkField;
  quote?: QuoteField;
  file?: FileField;
  ref?: RefField;
  boardRef?: BoardRefField;
  mindmap?: MindmapField;
  todo?: TodoField;
  svg?: SvgField;
  mermaid?: MermaidField;
  html?: HtmlField;
  code?: CodeField;
  table?: TableField;
  chart?: ChartField;
  excalidraw?: ExcalidrawField;
  data?: DataField;
  book?: BookField;
  frame?: FrameField;
  /**
   * 归属哪个分组框（**公共字段**：任何类型的卡都能被圈进框里，跟 color 一样）。
   * null / 缺省 = 自由卡。值必须是**同一块板上**一张 type=frame 的卡片 id——
   * 它是本板内主键，所以带 frameId 的卡片走信封换机器时这个字段会被丢掉（见 cards/frame/skill.md）。
   */
  frameId?: string | null;
  /**
   * 这张卡在**阅读顺序**里的例外（**公共字段**，跟 color / frameId 一样不归卡片包管）。
   * 缺省 = 没有例外，完全按摆放位置读（见 lib/layout.ts 的 readingOrder）。
   */
  reading?: CardReading;
  /** 绑在这张卡上的 agent 指令片段：转 Issue / 发起任务时拼进 goal */
  agentPrompt?: string;
}

/**
 * 阅读顺序的两条例外。默认都不设——不设的时候，阅读序列跟从前**逐张一致**。
 *
 * 为什么要有它们：阅读模式把二维画板压成一条序列，靠的是「摆在哪」。
 * 那对讲一件事的板子基本够用，但总有两类东西破坏节奏——
 * 侧边的服务信息、意见入口这种「附录」（该跳过），
 * 以及作者心里有明确先后、几何上却排不出来的开场几张（该指定序号）。
 * 这两条都必须是**用户显式写下的**，系统不替他猜。
 */
export interface CardReading {
  /**
   * 阅读模式跳过这张卡（`true` 才算跳过）。
   * 只影响**阅读模式**：导出与大纲照旧收录整块板——产物少了内容比顺序不对更糟。
   */
  skip?: boolean;
  /**
   * 显式阅读序号（越小越靠前）。设了序号的卡按序号排在最前面，
   * 没设的仍按摆放位置跟在后面——所以只给开场几张编号就够了，不用给全板编。
   */
  order?: number | null;
}

/* ── 评论（画板批注） ───────────────────────────────
   评论不是又一种卡片，而是挂在画板上的一层批注：
   它不参与布局 / 导出的卡片语义、不能连线、也不该被「整理」推来推去，
   但要能钉在**卡片 / 连线 / 画布任意一点**上——所以单独一张表。 */

/** 评论钉在哪：某张卡 / 某条连线 / 画布本身（画布评论可带坐标钉一个点，也可不带当整板留言） */
export const COMMENT_TARGETS = ["card", "edge", "board"] as const;
export type CommentTarget = (typeof COMMENT_TARGETS)[number];

/** 一条评论下的追加回复（跟图书评论一样：一条批注下面能接着说） */
export interface CommentReply {
  id: string;
  text: string;
  createdBy: "user" | "agent";
  createdAt: number;
}

export interface BoardComment {
  id: string;
  target: CommentTarget;
  /** 卡片 id / 连线 id；target 为 board 时是 null */
  targetId: string | null;
  /**
   * 画布坐标。
   * · target=board：钉在这个点（两者都为 null = 不钉，只在评论列表里当整板留言）
   * · target=card/edge：气泡跟着目标走，这里只留一份「当时钉在哪」的兜底，
   *   目标被外部删掉时评论还能落在原处而不是飞到原点
   */
  x: number | null;
  y: number | null;
  text: string;
  createdBy: "user" | "agent";
  createdAt: number;
  updatedAt: number;
  /** 已处理：画布上的气泡收起来，只在评论抽屉「已解决」里还看得到 */
  resolved: boolean;
  resolvedAt: number | null;
  replies: CommentReply[];
}

/* ── 工作日志（agent 改板留下的痕迹） ─────────────────
   跟评论一样是「挂在板上的第二张表」，但方向相反：评论是人写给 agent 的，
   日志是服务端替调用方记的——谁（浏览器还是 agent）在什么时候、用哪个批量入口、
   改动了多少东西、对应哪一份快照。**只由服务端写**，任何请求体里的 activity 一律不认。 */

/** 会打点也会记日志的批量入口（与 CheckpointReason 同一套口径，见 lib/checkpoints.ts）。 */
export const BOARD_ACTIVITY_ACTIONS = [
  "whole",
  "ingest",
  "paste",
  "tidy",
  "patch",
  "delete",
  "restore",
  "template",
  "import",
] as const;
export type BoardActivityAction = (typeof BOARD_ACTIVITY_ACTIONS)[number];

/** 谁干的：鉴权通道推断（x-auth-key = agent，x-board-web = 浏览器），推不出来算 user。 */
export type BoardActor = "user" | "agent";

export interface BoardActivity {
  at: number;
  actor: BoardActor;
  action: BoardActivityAction;
  /** 一句人话：「整板改写：卡片 12 → 15」这种，直接摆进抽屉 */
  summary: string;
  /** 这次动了多少东西（各入口自报，键随入口不同） */
  counts?: Record<string, number>;
  /** 这条改动之前那一刻的快照时间戳；null = 没打上（功能关了 / 写快照失败） */
  checkpoint?: string | null;
}

/** 一块板最多留多少条日志（滚动淘汰最旧的）：日志是「最近发生了什么」，不是审计账本。 */
export const MAX_BOARD_ACTIVITY = 50;

export interface BoardEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: EdgeKind;
  /** 覆盖语义默认色；null / 缺省 = 跟随 kind */
  color?: CardColor | null;
  /** 覆盖语义默认线型；null / 缺省 = 跟随 kind */
  style?: EdgeStyle | null;
  /** 线宽档位 1-3；缺省 = 2（普通） */
  width?: number | null;
  /**
   * 关系强弱 1-5（1 = 很弱的联想，5 = 强耦合 / 硬依赖）；null / 缺省 = 没标过。
   *
   * **跟 width 分开是刻意的**：width 是「这条线画多粗」（纯视觉，用户为了好看也会调），
   * weight 是「这个关系有多强」（语义，agent 与布局算法读它）。合成一个字段的话，
   * 把线调粗一点就等于悄悄改了语义，而按语义排版又会强行改变用户调好的视觉。
   * 分层重排 / 子图分簇会把 weight 喂给 dagre 的 edge weight（见 lib/layout-dagre.ts）。
   */
  weight?: number | null;
  /** 关系上的短标签（≤6 个，每个 ≤20 字）：给「同一条线属于哪几条主线」这种维度用 */
  tags?: string[];
  createdBy: "user" | "agent";
  createdAt: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface BoardSettings {
  /** 转 Issue 时的默认上下文策略；单次调用可覆盖 */
  issueContext: IssueContextPolicy;
  /**
   * 转过 Issue 的卡片改了之后，要不要自动把最新内容推回 Goal Agent。
   * 默认 auto：画板是这份需求的真源，Goal Agent 那边执行时读到的必须是画板上的现状。
   */
  issueSync: IssueSyncMode;
}

export const MAX_BOARD_GROUP = 40;

export interface Board {
  id: string;
  name: string;
  /** 从哪块板里新建出来的；左栏靠它缩进成层级 */
  parentId?: string | null;
  /** 分组 / 项目名；空串 = 未分组 */
  group?: string;
  createdAt: number;
  updatedAt: number;
  viewport: Viewport;
  settings?: BoardSettings;
  cards: BoardCard[];
  edges: BoardEdge[];
  /** 老画板文件里没有这个字段，读的时候补空数组，不需要迁移落盘 */
  comments?: BoardComment[];
  /**
   * 批量写入的工作日志（最新在前，上限 MAX_BOARD_ACTIVITY）。
   * 老板子里没有这张表，读的时候补空数组；**只由服务端追加**，whole 之类的整表替换不碰它。
   */
  activity?: BoardActivity[];
}

/** GET /api/boards/:id/preview —— 只有几何与颜色，给子画板卡画缩略图用 */
export interface BoardPreviewCard {
  id: string;
  type: CardType;
  color: CardColor;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
}

export interface BoardPreviewData {
  id: string;
  name: string;
  updatedAt: number;
  counts: { cards: number; edges: number };
  cards: BoardPreviewCard[];
  edges: { x1: number; y1: number; x2: number; y2: number }[];
}

export interface BoardCounts {
  cards: number;
  edges: number;
  tasks?: number;
  comments?: number;
  /** 未解决的评论数：左栏红点与顶栏角标看的是这个，不是总数 */
  openComments?: number;
}

/** 列表项（不含 cards/edges 正文） */
export interface BoardListItem {
  id: string;
  name: string;
  parentId?: string | null;
  group?: string;
  createdAt: number;
  updatedAt: number;
  counts: BoardCounts;
}

/** GET /api/boards/search 命中的一张卡（跨画板全文搜索） */
export interface BoardSearchCardHit {
  id: string;
  type: CardType;
  title: string;
  /** 命中处前后截出来的摘要（原文大小写） */
  snippet: string;
}

/** GET /api/boards/search 命中的一块板：名字命中、卡片命中，或两者都有 */
export interface BoardSearchHit {
  id: string;
  name: string;
  group: string;
  parentId: string | null;
  updatedAt: number;
  /** 板名/分组本身是否含关键词（左栏树过滤已经覆盖这层，前端主要看 cards） */
  nameHit: boolean;
  /** 全板实际命中的卡片数（cards 只带前几张） */
  cardTotal: number;
  cards: BoardSearchCardHit[];
}

export interface BoardSearchResult {
  query: string;
  boards: BoardSearchHit[];
  /** 命中板总数（boards 有截断上限） */
  totalBoards: number;
  totalCards: number;
}

/** GET /api/boards/:id 返回的画板（cards 已补 file.url/previewUrl） */
export interface BoardDetail extends Omit<Board, "cards" | "edges" | "comments" | "activity"> {
  counts: BoardCounts;
  settings: BoardSettings;
  cards: BoardCard[];
  edges: BoardEdge[];
  comments: BoardComment[];
  /** 工作日志随整板一起下发：历史抽屉不用再打一次接口，轮询也顺带把新条目带过来 */
  activity: BoardActivity[];
}

export interface BoardsFile {
  version: string;
  boards: Board[];
}

export interface LiveTaskStatus {
  taskId: string;
  status: string;
  summary: string;
  updatedAt: number | null;
}

export interface TaskIndexItem {
  boardId: string;
  boardName: string;
  card: BoardCard;
}

/* ── 卡片导航（/nav 子页面） ─────────────────────────
   导航页要回答的问题只有两个：这块地方有哪些卡、哪些是新的。
   所以索引里只留「摆得上一张导航卡」的字段——正文、几何、连线全不带。 */

/** 排序字段：按更新时间（默认）或创建时间 */
export const NAV_SORTS = ["updated", "created"] as const;
export type NavSort = (typeof NAV_SORTS)[number];

/** 排序方向：新→旧（默认）/ 旧→新 */
export const NAV_ORDERS = ["desc", "asc"] as const;
export type NavOrder = (typeof NAV_ORDERS)[number];

export interface BoardNavCard {
  id: string;
  type: CardType;
  color: CardColor;
  /** 原样下发，空标题由前端按类型兜底（与画布上那张卡显示的一致） */
  title: string;
  /** 标题之外的一段可读文本；带关键词时截的是命中处 */
  preview: string;
  createdAt: number;
  /** 老卡片没有 updatedAt，索引里统一补成 createdAt，前端不用再兜底 */
  updatedAt: number;
  boardId: string;
  boardName: string;
  group: string;
  /** 任务卡的状态；其余类型是 null */
  taskStatus: TaskStatus | null;
}

export interface BoardNavResult {
  /** 按 limit/offset 切出来的一页 */
  cards: BoardNavCard[];
  /** 当前范围 + 关键词下的命中总数 */
  total: number;
  limit: number;
  offset: number;
  /** 各类型的命中数：**不受 types 筛选影响**——筛选条自己要显示全部可选项 */
  typeCounts: Partial<Record<CardType, number>>;
}

export interface UploadRecord {
  id: string;
  kind: UploadKind;
  name: string;
  mediaType: string;
  size: number;
  previewUrl?: string;
}
