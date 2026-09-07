/**
 * 卡片包的客户端接口（cards/&lt;type&gt;/ui.tsx 实现这里的形状）。
 *
 * 与 lib/card-pack-types.ts（服务端）分开：服务端代码不得 import React 组件，
 * 所以两份注册表各引各的（客户端那份见 lib/card-registry-client.ts）。
 *
 * 槽位全部可缺省（兼容铁律 3：接口刻意极小）：
 *  · CardFace  —— 卡面（React Flow 单壳 CardNode 之内的正文；壳不交给包）
 *  · FullView  —— 阅读模式的摊开视图；缺省走通用文本渲染
 *  · editor    —— 编辑抽屉里的专属字段区；缺省只有公共字段（标题 / 颜色 / agent 指令）
 *  · toolbar   —— 工具条入口；缺省没有入口（image/pdf 走「上传」按钮）
 */
import type { ComponentType } from "react";
import type { CardMeta } from "./card-pack-types";
import type {
  BoardCard,
  CardColor,
  CardReading,
  CardType,
  ChartKind,
  DataValue,
  HtmlEmbedMode,
  LiveTaskStatus,
  MindNode,
  RefField,
  TableColumn,
  TaskPriority,
  TodoItem,
} from "./types";

/** 卡面页脚 / 菜单能对一张卡发起的动作（原 components/cards/CardBody.tsx 的 CardAction）。 */
export type CardAction = "issue" | "launch" | "detail" | "copy-task" | "done" | "reopen" | "open-board" | "toggle-frame";

/** 编辑器提交的补丁形状（原 components/cards/CardEditor.tsx 的 CardPatch，原样搬来）。 */
export interface CardPatch {
  title?: string;
  content?: string;
  color?: CardColor;
  agentPrompt?: string;
  /** 阅读例外（跳过 / 显式序号）；传 null = 清掉例外，跟 frameId 一样是公共字段 */
  reading?: CardReading | null;
  quote?: { source: string };
  task?: { priority: TaskPriority; goal: string };
  link?: { url: string; title: string };
  boardRef?: { boardId: string; name: string };
  frame?: { collapsed: boolean };
  mindmap?: { root: MindNode };
  ref?: RefField;
  todo?: { items: TodoItem[] };
  svg?: { source: string };
  mermaid?: { source: string };
  html?: { url: string; mode: HtmlEmbedMode; frameW: number; frameH: number };
  data?: { specId: string; fields: Record<string, DataValue> };
  excalidraw?: { source: string; thumbnail?: string; updatedAt?: number };
  code?: { source: string; language: string; filename?: string };
  /** 表格：编辑器发的是 markdown 形态，API 也收 columns/rows（两条路同一个归一化，见 cards/table/schema.ts） */
  table?: { markdown?: string; csv?: string; columns?: TableColumn[]; rows?: Record<string, string>[]; caption?: string };
  /** 图表：数据键按 kind 分（bar/line 用 labels+series，pie 用 slices，quadrant 用 points） */
  chart?: {
    kind: ChartKind;
    title?: string;
    xLabel?: string;
    yLabel?: string;
    labels?: string[];
    /** null = 显式清空（不传 = 保留上一版，见 cards/chart/schema.ts 的合并语义） */
    series?: { name?: string; values: number[] }[] | null;
    slices?: { label: string; value: number }[] | null;
    points?: { label: string; x: number; y: number }[] | null;
  };
}

export interface CardFaceProps {
  card: BoardCard;
  live?: LiveTaskStatus;
  related: { up: BoardCard[]; down: BoardCard[] };
  onAction: (action: CardAction) => void;
}

export interface FullViewProps {
  card: BoardCard;
  /** mermaid 要往 DOM 里挂唯一 id；同一张卡可能同时在多处在场，前缀得分开 */
  idPrefix: string;
}

export interface EditorFieldsProps {
  card: BoardCard;
  /** 本包的草稿切片（editor.draftFrom 的返回形状） */
  draft: Record<string, any>;
  /** 合并式更新草稿 */
  patch: (partial: Record<string, any>) => void;
  /** drawer 版式（正文撑满高度） */
  roomy: boolean;
  /** 挡住自动保存并说明原因（如 html 卡的「地址不在白名单」）；null = 放行 */
  setBlocked: (reason: string | null) => void;
}

export interface CardEditorPack {
  /** 卡片 → 本包的草稿切片。挂载初值、换卡重置、「有没有改过」的基准都由它统一给 */
  draftFrom(card: BoardCard): Record<string, any>;
  /** 草稿 → 补丁（只填本包负责的键，含 content——text/task/quote/link 的正文归包管） */
  buildPatch(card: BoardCard, draft: Record<string, any>): CardPatch;
  /** 专属字段的表单区；缺省 = 本类型没有专属字段可编辑 */
  Fields?: ComponentType<EditorFieldsProps>;
}

export interface CardToolbarCtx {
  /** 在视口中心建一张该类型的卡并进入编辑 */
  add(type: CardType): void;
  /** 子画板专用：先建板再建指向它的卡 */
  addSubBoard(): void;
}

export interface CardToolbarSpec {
  /** 按钮文字；缺省用 meta.label */
  label?: string;
  title: string;
  /**
   * 需要的可选集成（阶段 A 的 feature 开关）：**包启用且 feature 配置了**，
   * 两道闸都过才显示入口（ref / book 用）。
   */
  feature?: "search" | "library";
  /**
   * 工具条分组（按**卡片属性**分，与谁用得多无关——那是各人的事，默认顺序得对所有人成立）：
   *   1 基础·写       文本 / 任务 / 待办 / 引用 / 链接
   *   2 表达·画与结构  导图 / 图表 / 数据图 / SVG / Excalidraw / 表格 / 代码
   *   3 组织与结构化   规格卡 / 子画板 / 分组框 / 网页
   *   4 外部来源       资料 / 图书（依赖外部服务，没配就整个不显示）
   * 1、2 常驻工具条，3、4 收进「更多」——二十个按钮排一行会把画布顶掉。
   */
  group: 1 | 2 | 3 | 4;
  /** 组内排序 */
  order: number;
  onClick(ctx: CardToolbarCtx): void;
}

export interface CardPackUi {
  CardFace?: ComponentType<CardFaceProps>;
  FullView?: ComponentType<FullViewProps>;
  editor?: CardEditorPack;
  toolbar?: CardToolbarSpec;
}

export interface ClientCardPack {
  meta: CardMeta;
  ui?: CardPackUi;
}
