/**
 * 卡片包注册表（服务端）：静态 import 全部 cards/&lt;type&gt;/{meta,schema,export}。
 *
 * 这里**不得**引任何 React 组件——ui.tsx 走另一份 lib/card-registry-client.ts。
 * 不做运行时装载：「装插件」= 放目录 + 在两份注册表各补一行 + rebuild
 * （浏览器热装第三方代码是安全窟窿，见 OPEN-SOURCE-PLAN §3.2）。
 */
import type { ServerCardPack } from "./card-pack-types";
import type { CardType } from "./types";

import { meta as textMeta } from "@/cards/text/meta";
import { schema as textSchema } from "@/cards/text/schema";
import { meta as taskMeta } from "@/cards/task/meta";
import { schema as taskSchema } from "@/cards/task/schema";
import { exporter as taskExport } from "@/cards/task/export";
import { meta as linkMeta } from "@/cards/link/meta";
import { schema as linkSchema } from "@/cards/link/schema";
import { exporter as linkExport } from "@/cards/link/export";
import { meta as quoteMeta } from "@/cards/quote/meta";
import { schema as quoteSchema } from "@/cards/quote/schema";
import { exporter as quoteExport } from "@/cards/quote/export";
import { meta as imageMeta } from "@/cards/image/meta";
import { schema as imageSchema } from "@/cards/image/schema";
import { exporter as imageExport } from "@/cards/image/export";
import { meta as mediaMeta } from "@/cards/media/meta";
import { schema as mediaSchema } from "@/cards/media/schema";
import { exporter as mediaExport } from "@/cards/media/export";
import { meta as pdfMeta } from "@/cards/pdf/meta";
import { schema as pdfSchema } from "@/cards/pdf/schema";
import { exporter as pdfExport } from "@/cards/pdf/export";
import { meta as refMeta } from "@/cards/ref/meta";
import { schema as refSchema } from "@/cards/ref/schema";
import { exporter as refExport } from "@/cards/ref/export";
import { meta as boardMeta } from "@/cards/board/meta";
import { schema as boardSchema } from "@/cards/board/schema";
import { exporter as boardExport } from "@/cards/board/export";
import { meta as mindmapMeta } from "@/cards/mindmap/meta";
import { schema as mindmapSchema } from "@/cards/mindmap/schema";
import { exporter as mindmapExport } from "@/cards/mindmap/export";
import { meta as todoMeta } from "@/cards/todo/meta";
import { schema as todoSchema } from "@/cards/todo/schema";
import { exporter as todoExport } from "@/cards/todo/export";
import { meta as svgMeta } from "@/cards/svg/meta";
import { schema as svgSchema } from "@/cards/svg/schema";
import { exporter as svgExport } from "@/cards/svg/export";
import { meta as mermaidMeta } from "@/cards/mermaid/meta";
import { schema as mermaidSchema } from "@/cards/mermaid/schema";
import { exporter as mermaidExport } from "@/cards/mermaid/export";
import { meta as excalidrawMeta } from "@/cards/excalidraw/meta";
import { schema as excalidrawSchema } from "@/cards/excalidraw/schema";
import { exporter as excalidrawExport } from "@/cards/excalidraw/export";
import { meta as dataMeta } from "@/cards/data/meta";
import { schema as dataSchema } from "@/cards/data/schema";
import { exporter as dataExport } from "@/cards/data/export";
import { meta as bookMeta } from "@/cards/book/meta";
import { schema as bookSchema } from "@/cards/book/schema";
import { exporter as bookExport } from "@/cards/book/export";
import { meta as htmlMeta } from "@/cards/html/meta";
import { schema as htmlSchema } from "@/cards/html/schema";
import { exporter as htmlExport } from "@/cards/html/export";
import { meta as codeMeta } from "@/cards/code/meta";
import { schema as codeSchema } from "@/cards/code/schema";
import { exporter as codeExport } from "@/cards/code/export";
import { meta as tableMeta } from "@/cards/table/meta";
import { schema as tableSchema } from "@/cards/table/schema";
import { exporter as tableExport } from "@/cards/table/export";
import { meta as chartMeta } from "@/cards/chart/meta";
import { schema as chartSchema } from "@/cards/chart/schema";
import { exporter as chartExport } from "@/cards/chart/export";
import { meta as frameMeta } from "@/cards/frame/meta";
import { schema as frameSchema } from "@/cards/frame/schema";
import { exporter as frameExport } from "@/cards/frame/export";

export const SERVER_CARD_PACKS: Record<CardType, ServerCardPack> = {
  text: { meta: textMeta, schema: textSchema },
  task: { meta: taskMeta, schema: taskSchema, export: taskExport },
  link: { meta: linkMeta, schema: linkSchema, export: linkExport },
  quote: { meta: quoteMeta, schema: quoteSchema, export: quoteExport },
  image: { meta: imageMeta, schema: imageSchema, export: imageExport },
  media: { meta: mediaMeta, schema: mediaSchema, export: mediaExport },
  pdf: { meta: pdfMeta, schema: pdfSchema, export: pdfExport },
  ref: { meta: refMeta, schema: refSchema, export: refExport },
  board: { meta: boardMeta, schema: boardSchema, export: boardExport },
  mindmap: { meta: mindmapMeta, schema: mindmapSchema, export: mindmapExport },
  todo: { meta: todoMeta, schema: todoSchema, export: todoExport },
  svg: { meta: svgMeta, schema: svgSchema, export: svgExport },
  mermaid: { meta: mermaidMeta, schema: mermaidSchema, export: mermaidExport },
  excalidraw: { meta: excalidrawMeta, schema: excalidrawSchema, export: excalidrawExport },
  data: { meta: dataMeta, schema: dataSchema, export: dataExport },
  book: { meta: bookMeta, schema: bookSchema, export: bookExport },
  html: { meta: htmlMeta, schema: htmlSchema, export: htmlExport },
  code: { meta: codeMeta, schema: codeSchema, export: codeExport },
  table: { meta: tableMeta, schema: tableSchema, export: tableExport },
  chart: { meta: chartMeta, schema: chartSchema, export: chartExport },
  frame: { meta: frameMeta, schema: frameSchema, export: frameExport },
};

/** 按 type 取包；未知类型返回 null，调用方走透传 / 兜底渲染。 */
export function serverPack(type: string): ServerCardPack | null {
  return (SERVER_CARD_PACKS as Record<string, ServerCardPack>)[type] || null;
}

/** 是不是本机代码里有的原生类型。 */
export function isKnownCardType(type: string): type is CardType {
  return Boolean(serverPack(type));
}
