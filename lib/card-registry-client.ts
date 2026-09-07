"use client";

/**
 * 卡片包注册表（客户端）：静态 import 全部 cards/&lt;type&gt;/{meta,ui}。
 *
 * 与 lib/card-registry.ts（服务端）成对：那边 meta + schema + export，
 * 这边 meta + ui（React 组件只在这份里出现）。React Flow 的 nodeTypes 仍只注册
 * 一种 `card` 单壳（CardNode：锚点 / 缩放 / 选中），包只提供壳内的 CardFace——
 * 壳的一致性不交给插件作者，也避开「nodeTypes 必须是稳定常量」的重渲警告。
 */
import type { ClientCardPack } from "./card-pack-client";
import type { CardType } from "./types";

import { meta as textMeta } from "@/cards/text/meta";
import { ui as textUi } from "@/cards/text/ui";
import { meta as taskMeta } from "@/cards/task/meta";
import { ui as taskUi } from "@/cards/task/ui";
import { meta as linkMeta } from "@/cards/link/meta";
import { ui as linkUi } from "@/cards/link/ui";
import { meta as quoteMeta } from "@/cards/quote/meta";
import { ui as quoteUi } from "@/cards/quote/ui";
import { meta as imageMeta } from "@/cards/image/meta";
import { ui as imageUi } from "@/cards/image/ui";
import { meta as mediaMeta } from "@/cards/media/meta";
import { ui as mediaUi } from "@/cards/media/ui";
import { meta as pdfMeta } from "@/cards/pdf/meta";
import { ui as pdfUi } from "@/cards/pdf/ui";
import { meta as refMeta } from "@/cards/ref/meta";
import { ui as refUi } from "@/cards/ref/ui";
import { meta as boardMeta } from "@/cards/board/meta";
import { ui as boardUi } from "@/cards/board/ui";
import { meta as mindmapMeta } from "@/cards/mindmap/meta";
import { ui as mindmapUi } from "@/cards/mindmap/ui";
import { meta as todoMeta } from "@/cards/todo/meta";
import { ui as todoUi } from "@/cards/todo/ui";
import { meta as svgMeta } from "@/cards/svg/meta";
import { ui as svgUi } from "@/cards/svg/ui";
import { meta as mermaidMeta } from "@/cards/mermaid/meta";
import { ui as mermaidUi } from "@/cards/mermaid/ui";
import { meta as excalidrawMeta } from "@/cards/excalidraw/meta";
import { ui as excalidrawUi } from "@/cards/excalidraw/ui";
import { meta as dataMeta } from "@/cards/data/meta";
import { ui as dataUi } from "@/cards/data/ui";
import { meta as bookMeta } from "@/cards/book/meta";
import { ui as bookUi } from "@/cards/book/ui";
import { meta as htmlMeta } from "@/cards/html/meta";
import { ui as htmlUi } from "@/cards/html/ui";
import { meta as codeMeta } from "@/cards/code/meta";
import { ui as codeUi } from "@/cards/code/ui";
import { meta as tableMeta } from "@/cards/table/meta";
import { ui as tableUi } from "@/cards/table/ui";
import { meta as chartMeta } from "@/cards/chart/meta";
import { ui as chartUi } from "@/cards/chart/ui";
import { meta as frameMeta } from "@/cards/frame/meta";
import { ui as frameUi } from "@/cards/frame/ui";

export const CLIENT_CARD_PACKS: Record<CardType, ClientCardPack> = {
  text: { meta: textMeta, ui: textUi },
  task: { meta: taskMeta, ui: taskUi },
  link: { meta: linkMeta, ui: linkUi },
  quote: { meta: quoteMeta, ui: quoteUi },
  image: { meta: imageMeta, ui: imageUi },
  media: { meta: mediaMeta, ui: mediaUi },
  pdf: { meta: pdfMeta, ui: pdfUi },
  ref: { meta: refMeta, ui: refUi },
  board: { meta: boardMeta, ui: boardUi },
  mindmap: { meta: mindmapMeta, ui: mindmapUi },
  todo: { meta: todoMeta, ui: todoUi },
  svg: { meta: svgMeta, ui: svgUi },
  mermaid: { meta: mermaidMeta, ui: mermaidUi },
  excalidraw: { meta: excalidrawMeta, ui: excalidrawUi },
  data: { meta: dataMeta, ui: dataUi },
  book: { meta: bookMeta, ui: bookUi },
  html: { meta: htmlMeta, ui: htmlUi },
  code: { meta: codeMeta, ui: codeUi },
  table: { meta: tableMeta, ui: tableUi },
  chart: { meta: chartMeta, ui: chartUi },
  frame: { meta: frameMeta, ui: frameUi },
};

/** 按 type 取包；未知类型（数据里有、代码里没有）返回 null，调用方走 Tier 0 兜底。 */
export function clientPack(type: string): ClientCardPack | null {
  return (CLIENT_CARD_PACKS as Record<string, ClientCardPack>)[type] || null;
}
