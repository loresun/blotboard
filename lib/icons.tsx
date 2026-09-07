"use client";

/**
 * 图标统一出口（lucide-react，MIT）。
 * 全站不用 emoji：emoji 跨平台字形不一致、无法调色调粗细、也没法跟线性 UI 对齐。
 */
import {
  AlignHorizontalJustifyStart,
  AppWindow,
  ArrowLeft,
  ArrowUpRight,
  Atom,
  AudioLines,
  Ban,
  Banknote,
  Bell,
  Bug,
  Blocks,
  BookMarked,
  BookOpen,
  BookOpenText,
  Boxes,
  CalendarCheck,
  CalendarRange,
  Check,
  ChartColumn,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  CircleHelp,
  CircleDashed,
  CircleDot,
  CirclePlay,
  ClipboardList,
  Code,
  Columns2,
  Columns3,
  Compass,
  Database,
  Copy,
  CornerDownRight,
  Ellipsis,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  FileType,
  Film,
  Frame,
  Gauge,
  Flag,
  GitBranch,
  Grid2x2,
  Group,
  Grid3x3,
  Hexagon,
  History,
  Image as ImageIcon,
  Keyboard,
  Layers,
  LayoutTemplate,
  Library,
  ListTodo,
  ListTree,
  LayoutGrid,
  Lightbulb,
  Link2,
  Hand,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Milestone,
  MousePointer2,
  Move,
  Network,
  Newspaper,
  Package,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  PenTool,
  Pin,
  Plus,
  Quote,
  Recycle,
  RefreshCw,
  Repeat,
  Route,
  Download,
  Expand,
  Braces,
  Funnel,
  RotateCcw,
  Rows3,
  Scale,
  Search,
  Shrink,
  Send,
  Settings2,
  Shuffle,
  Sparkles,
  Split,
  SquareCheck,
  Stethoscope,
  Table2,
  Tags,
  Target,
  Telescope,
  Timer,
  Trash2,
  Undo2,
  Upload,
  User,
  WandSparkles,
  Waypoints,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { CardType, TaskStatus } from "./types";
import { CARD_META_BY_TYPE } from "./card-metas";
import { AGENT_ICON_NAMES, SPEC_ICON_NAMES, TEMPLATE_ICON_NAMES, type AgentIconName, type SpecIconName, type TemplateIconName } from "./icon-names";

export { AGENT_ICON_NAMES, SPEC_ICON_NAMES, TEMPLATE_ICON_NAMES };
export type { AgentIconName, SpecIconName, TemplateIconName };

export type { LucideIcon };

/**
 * 卡片包图标表：meta.ts 零依赖只写图标名，名字 → lucide 组件的映射在这里。
 * 加一种卡片：包里起个名，这里补一行。
 */
const PACK_ICONS: Record<string, LucideIcon> = {
  text: FileText,
  task: SquareCheck,
  link: Link2,
  quote: Quote,
  image: ImageIcon,
  media: Film,
  pdf: FileType,
  ref: Library,
  board: Frame,
  mindmap: ListTree,
  todo: ListTodo,
  svg: PenTool,
  mermaid: Workflow,
  excalidraw: Pencil,
  data: Braces,
  book: BookMarked,
  html: AppWindow,
  code: Code,
  table: Table2,
  chart: ChartColumn,
  // 分组框用 Group（Frame 已经给了子画板卡：那是「另一块板」，这个是「就地圈一块地」）
  frame: Group,
};

/** 卡片类型图标——从卡片包注册表派生（真源在 cards/&lt;type&gt;/meta.ts 的 icon 名）。 */
export const TYPE_ICON: Record<CardType, LucideIcon> = Object.fromEntries(
  Object.entries(CARD_META_BY_TYPE).map(([type, meta]) => [type, PACK_ICONS[meta.icon] || Boxes]),
) as Record<CardType, LucideIcon>;

/** 未知类型也给得出的图标：数据里的 type 本机没有对应卡片包时，别让 undefined 组件炸掉渲染。 */
export function typeIcon(type: string): LucideIcon {
  return (TYPE_ICON as Record<string, LucideIcon>)[type] || Boxes;
}

/** 任务状态图标（看板列头、卡片状态条共用） */
export const STATUS_ICON: Record<TaskStatus, LucideIcon> = {
  idea: Lightbulb,
  issued: ClipboardList,
  running: Timer,
  done: CircleCheckBig,
};

export const UI = {
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  fit: Maximize2,
  /** 阅读模式的全屏进 / 出（把版面铺满整块屏，见 components/panels/ReaderModal.tsx） */
  fullscreen: Expand,
  fullscreenExit: Shrink,
  /** 键盘归属：正文里嵌了别人的页面时，←/→ 到底是翻卡还是翻那页 PPT */
  keyboard: Keyboard,
  reset: RotateCcw,
  refresh: RefreshCw,
  search: Search,
  download: Download,
  image: ImageIcon,
  audio: AudioLines,
  code: Braces,
  markdown: FileText,
  expand: Expand,
  filter: Funnel,
  select: MousePointer2,
  pan: Hand,
  tasks: LayoutGrid,
  agent: Sparkles,
  sidebarOpen: PanelLeft,
  sidebarClose: PanelLeftClose,
  upload: Upload,
  close: X,
  more: Ellipsis,
  edit: Pencil,
  copy: Copy,
  remove: Trash2,
  add: Plus,
  tidy: WandSparkles,
  layoutH: AlignHorizontalJustifyStart,
  layoutV: Rows3,
  layoutGrid: Grid2x2,
  /** 时间线整理（一天一列）与看板整理（按状态分列）：整理菜单里的两项 */
  timeline: CalendarRange,
  kanban: Columns3,
  /** 第三波三种整理：四象限 / 泳道（类型 × 状态）/ 子图分簇 */
  matrix: Grid3x3,
  swimlane: Table2,
  cluster: Waypoints,
  /** 大纲视图（画布之外的第二种看板方式）与对比模式（2-4 张卡并排） */
  outlineView: ListTree,
  compare: Columns2,
  /** 连线语义两件套：关系强弱与关系标签 */
  weight: Gauge,
  tags: Tags,
  undo: Undo2,
  relations: Network,
  external: ExternalLink,
  open: ArrowUpRight,
  send: Send,
  run: CirclePlay,
  pin: Pin,
  move: Move,
  chevron: ChevronDown,
  prev: ChevronLeft,
  next: ChevronRight,
  check: Check,
  ban: Ban,
  detail: Layers,
  target: Target,
  flag: Flag,
  pending: CircleDashed,
  blocks: Blocks,
  rows: Rows3,
  library: Library,
  grid: Grid2x2,
  align: AlignHorizontalJustifyStart,
  template: LayoutTemplate,
  fill: Zap,
  outline: ListTree,
  read: BookOpen,
  page: FileType,
  back: ArrowLeft,
  comment: MessageSquare,
  commentAdd: MessageSquarePlus,
  reply: CornerDownRight,
  resolved: CircleCheckBig,
  eye: Eye,
  /** 历史抽屉（改动记录 + 历史快照）：改板安全网的入口 */
  history: History,
  eyeOff: EyeOff,
  compass: Compass,
  /** 存储形态（服务端 / 浏览器）——顶栏那颗胶囊收进「更多」时也用它 */
  database: Database,
  settings: Settings2,
  /** 帮助文档页（/docs）：介绍 / 上手 / 各功能怎么用 */
  docs: BookOpenText,
  /** 文档页里「这条还没写」「有疑问」的占位图标 */
  help: CircleHelp,
} satisfies Record<string, LucideIcon>;

/** 自定义 agent 指令可选的图标（固定集合，避免动态 import 整个图标库；名字表在 lib/icon-names.ts） */
export const AGENT_ICONS = {
  sparkles: Sparkles,
  wand: WandSparkles,
  target: Target,
  clipboard: ClipboardList,
  network: Network,
  layers: Layers,
  lightbulb: Lightbulb,
  flag: Flag,
  blocks: Blocks,
  send: Send,
  run: CirclePlay,
  check: CircleCheckBig,
} satisfies Record<string, LucideIcon>;

/** 卡片规格可选的图标（固定集合，名字表在 lib/icon-names.ts） */
export const SPEC_ICONS = {
  message: MessageSquare,
  doc: FileText,
  article: Newspaper,
  code: Code,
  branch: GitBranch,
  user: User,
  chart: ChartColumn,
  money: Banknote,
  calendar: CalendarCheck,
  clipboard: ClipboardList,
  package: Package,
  bug: Bug,
  bell: Bell,
  scale: Scale,
  target: Target,
  boxes: Boxes,
  flag: Flag,
  link: Link2,
} satisfies Record<SpecIconName, LucideIcon>;

export function specIcon(name?: string): LucideIcon {
  return SPEC_ICONS[(name || "") as SpecIconName] || Braces;
}

export function agentIcon(name?: string): LucideIcon {
  return AGENT_ICONS[(name || "") as AgentIconName] || Sparkles;
}

/** 统一的图标尺寸与线宽：跟 12–13px 正文对齐 */
export const ICON_SM = { size: 14, strokeWidth: 1.9 } as const;
export const ICON_MD = { size: 16, strokeWidth: 1.8 } as const;
export const ICON_LG = { size: 20, strokeWidth: 1.7 } as const;

/** 模板可选图标（名字表在 lib/icon-names.ts，服务端按它校验模板 json） */
export const TEMPLATE_ICONS = {
  grid: Grid3x3,
  shuffle: Shuffle,
  hexagon: Hexagon,
  compass: Compass,
  telescope: Telescope,
  atom: Atom,
  repeat: Repeat,
  circle: CircleDot,
  scale: Scale,
  stethoscope: Stethoscope,
  calendar: CalendarCheck,
  route: Route,
  book: BookOpen,
  boxes: Boxes,
  target: Target,
  milestone: Milestone,
  split: Split,
  waypoints: Waypoints,
  recycle: Recycle,
  branch: GitBranch,
} satisfies Record<TemplateIconName, LucideIcon>;

export function templateIcon(name?: string): LucideIcon {
  return TEMPLATE_ICONS[(name || "") as TemplateIconName] || LayoutTemplate;
}
