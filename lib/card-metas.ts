/**
 * 卡片包 meta 注册表（前后端共用，零 React / 零 node 依赖）。
 *
 * 构建期静态 import 全部 cards/&lt;type&gt;/meta.ts——不做运行时装载（安全边界见
 * OPEN-SOURCE-PLAN §3.2：「装插件」= 放目录 + rebuild）。TYPE_META / TYPE_ICON /
 * TYPE_FALLBACK_TITLE / DEFAULT_W/H / GROUP_ORDER / 信封类型白名单 / 检索 haystack
 * 全部从这里派生，加一种卡片不再要改十几处枚举。
 *
 * 类型源头仍是 lib/types.ts 的 BOARD_CARD_TYPES 元组（CardType 联合类型由它生成，
 * 运行时数组没法反过来喂类型系统）；下面的 Record 声明保证两边一一对应——
 * 少写一个 meta 或类型拼错，typecheck 直接红。
 */
import type { CardMeta } from "./card-pack-types";
import type { CardType } from "./types";

import { meta as text } from "@/cards/text/meta";
import { meta as task } from "@/cards/task/meta";
import { meta as link } from "@/cards/link/meta";
import { meta as quote } from "@/cards/quote/meta";
import { meta as image } from "@/cards/image/meta";
import { meta as media } from "@/cards/media/meta";
import { meta as pdf } from "@/cards/pdf/meta";
import { meta as ref } from "@/cards/ref/meta";
import { meta as board } from "@/cards/board/meta";
import { meta as mindmap } from "@/cards/mindmap/meta";
import { meta as todo } from "@/cards/todo/meta";
import { meta as svg } from "@/cards/svg/meta";
import { meta as mermaid } from "@/cards/mermaid/meta";
import { meta as excalidraw } from "@/cards/excalidraw/meta";
import { meta as data } from "@/cards/data/meta";
import { meta as book } from "@/cards/book/meta";
import { meta as html } from "@/cards/html/meta";
import { meta as code } from "@/cards/code/meta";
import { meta as table } from "@/cards/table/meta";
import { meta as chart } from "@/cards/chart/meta";
import { meta as frame } from "@/cards/frame/meta";

export const CARD_META_BY_TYPE: Record<CardType, CardMeta> = {
  text,
  task,
  link,
  quote,
  image,
  media,
  pdf,
  ref,
  board,
  mindmap,
  todo,
  svg,
  mermaid,
  excalidraw,
  data,
  book,
  html,
  code,
  table,
  chart,
  frame,
};

/** 全部包的 meta，顺序与 BOARD_CARD_TYPES 一致（能力上报 / 卡片中心列表用它）。 */
export const CARD_METAS: CardMeta[] = Object.values(CARD_META_BY_TYPE);

/** 按 type 取 meta；未知类型（数据里有、代码里没有）返回 null，调用方走 Tier 0 兜底。 */
export function cardMetaOf(type: string): CardMeta | null {
  return (CARD_META_BY_TYPE as Record<string, CardMeta>)[type] || null;
}

/** 未知类型也给得出的展示名：优先包 label，没有就把 type 原样亮出来。 */
export function typeLabelOf(type: string): string {
  return cardMetaOf(type)?.label || type;
}

/** 未知类型也给得出的兜底标题。 */
export function fallbackTitleOf(type: string): string {
  return cardMetaOf(type)?.fallbackTitle || `${type} 卡片`;
}
