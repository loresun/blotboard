/**
 * 卡片包（CardPack）接口定义 —— OPEN-SOURCE-PLAN §3.2 的落地版。
 *
 * 一种卡片 = cards/&lt;type&gt;/ 一个目录，按 Next.js 的服务端 / 客户端边界拆成多个入口文件：
 *  · meta.ts    —— 展示元信息 + 检索贡献，零依赖（只 import 类型），前后端共用；
 *  · schema.ts  —— 服务端：专属字段的归一化（建卡 / 类型互转 / 打补丁）与 Markdown 导出贡献；
 *  · export.ts  —— 服务端：HTML 排版导出贡献（只有需要的类型有）；
 *  · ui.tsx     —— 客户端：卡面 / 阅读视图 / 编辑器 / 工具条入口（类型见 lib/card-pack-client.ts）。
 *
 * 两份注册表各引各的（服务端代码不得 import React 组件）：
 *  · lib/card-registry.ts        —— 服务端：meta + schema + export；
 *  · lib/card-registry-client.ts —— 客户端：meta + ui。
 *
 * 接口刻意保持极小（兼容铁律 3）：加能力先问「能不能下沉为 Tier 1 的声明式特性」。
 */
import type { BoardCard, CardColor, CardType } from "./types";
import type { ExportHtmlCtx } from "./export-helpers";

export type { ExportHtmlCtx };

/** 接口版本：破坏性改动时 +1，包声明的版本对不上就拒绝装载。 */
export const CARD_PACK_API_VERSION = 1 as const;

export interface CardMeta {
  apiVersion: typeof CARD_PACK_API_VERSION;
  type: CardType;
  /** 工具条 / 筛选器上的短名（原 constants.TYPE_META.label） */
  label: string;
  /** 空标题卡片的兜底标题（原 board-schema.TYPE_FALLBACK_TITLE） */
  fallbackTitle: string;
  /** 图标名：lib/icons.tsx 的 PACK_ICONS 键（meta 零依赖，不直接引组件） */
  icon: string;
  /** 前端建卡的预估尺寸（原 TYPE_META.size；用于新卡落点居中等） */
  size: [number, number];
  /**
   * 服务端落库的默认宽高（原 board-schema DEFAULT_W / DEFAULT_H）。
   * task / link 两型与 size 有几像素的历史出入——机械迁移，保持原值不动。
   */
  defaultW: number;
  defaultH: number;
  /** 默认颜色（原 TYPE_META.color） */
  color: CardColor;
  /** 专属字段在 BoardCard 上的键；text 没有；image/pdf 共用 file */
  fieldKey: keyof BoardCard | null;
  /** 「按类型分组」布局的排序位次（原 layout.ts GROUP_ORDER 的下标） */
  groupOrder: number;
  /** 允许经卡片信封导入的原生类型（原 card-ingest.ENVELOPE_NATIVE_TYPES） */
  envelope?: boolean;
  /** card-packs.json 首次生成时是否进默认启用集（方案默认集，见 lib/card-pack-store.ts） */
  defaultEnabled?: boolean;
  /**
   * 全文检索贡献：这张卡的专属字段里，哪些文本参与搜索（原 lib/search-text.ts 的枚举）。
   * 放 meta 而不放 schema：画布搜索在浏览器里跑，这份函数必须前后端同构。
   * 对**所有**包调用而不只按 card.type 分派——类型互转会留下旧类型的残留字段，
   * 那些字段今天就参与搜索，机械迁移不改这个行为。
   */
  searchParts?: (card: BoardCard) => (string | null | undefined)[];
}

export interface SchemaCtx {
  uploadsDir?: string;
  /**
   * 「建卡严」：单卡 POST / PATCH 走这条时为 true，包里的枚举字段（如 task.status）
   * 收到非法值应当抛 400 而不是静默兜底；whole / 粘贴 / 信封不传（收卡宽，照旧兜底）。
   */
  strict?: boolean;
}

/**
 * 服务端 schema：normalize 的三个时机，与 board-schema.normalizeCardInput 原分支一一对应。
 * 全部可缺省（text 卡就什么都不用做）。
 */
export interface CardPackSchema {
  /** 新建（含 whole 全量替换 / 粘贴 / 模板 / 信封）：给 card 补上专属字段 */
  onCreate?(card: BoardCard, input: Record<string, any>, ctx: SchemaCtx): void;
  /** 类型互转（转**成**本类型）之前的校验，可抛 ApiError（如 image/pdf 必须有 uploadId） */
  beforeConvert?(card: BoardCard, patch: Record<string, any>, ctx: SchemaCtx): void;
  /** 类型互转（转成本类型）：按旧卡现状 + 补丁重建专属字段 */
  onConvert?(card: BoardCard, patch: Record<string, any>, ctx: SchemaCtx): void;
  /** 同类型打补丁：patch 里带了自己的字段才动 */
  onPatch?(card: BoardCard, patch: Record<string, any>, ctx: SchemaCtx): void;
  /** Markdown 导出贡献（原 board-service.exportBoardMarkdown 的类型分支） */
  markdownLines?(card: BoardCard): string[];
  /**
   * markdown 行插在公共行（链接 / 出处 / 文件名）之前还是之后。
   * 只有 task 是 before——机械保持原导出的行序。
   */
  markdownBeforeCommon?: boolean;
}

export interface CardPackExport {
  /** 这张卡在单文件 HTML 导出里的正文（原 lib/export-html.ts renderCardBody 的分支） */
  html?(card: BoardCard, ctx: ExportHtmlCtx): string;
}

/** 服务端注册表里的一个包。 */
export interface ServerCardPack {
  meta: CardMeta;
  schema: CardPackSchema;
  export?: CardPackExport;
}
