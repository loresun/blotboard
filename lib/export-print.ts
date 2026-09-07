/**
 * PDF 排版用的**分块产物**（`GET /api/boards/{id}/export?format=print`）。
 *
 * 与单文件 HTML 导出（lib/export-html.ts）的分工：
 *
 *   内容（一张卡长什么样、怎么分节、编号、筛选口径）—— 两者共用 `prepareExport` +
 *   卡片包的 `cards/<type>/export.ts`，**只有一份真源**；
 *   版面（纸张、页边距、分页、页码、目录页码）—— 归浏览器那一侧（lib/export-pdf.ts）。
 *
 * 为什么版面不在这里算：分页要知道**每一块渲染出来有多高**，而高度只有真正排版过
 * 才知道（字体、换行、图片实际尺寸）。服务端没有排版引擎，硬算只能靠估，估错就是
 * 卡片被劈成两半。所以这边只负责把内容切成「不该被拆开的最小块」，浏览器那边量完再装页。
 *
 * 产物是纯数据（JSON）：块 + 一份样式表 + 封面要用的统计。它不是一份能直接打开的
 * HTML——那是 `format=html` 的活。
 */
import { EDGE_KIND_META } from "./constants";
import { typeLabelOf } from "./card-metas";
import { MERMAID_FLOW_CSS } from "./mermaid-flow";
import {
  DOC_CSS,
  cardTitle,
  escapeHtml,
  prepareExport,
  renderCard,
  renderComments,
  renderRelations,
  type HtmlExportOptions,
} from "./export-html";
import type { Board } from "./types";

/** 一块「不该被拆开的东西」。分页时以它为单位装页；装不下就整块挪到下一页。 */
export interface PrintBlock {
  kind: "section" | "card" | "relations" | "comments";
  /** 锚点：卡片 id 或节锚点。目录跳转与「这块落在第几页」都认它 */
  anchor: string;
  /** 目录里显示的名字 */
  title: string;
  /** 卡片编号（全篇连续，与卡头上印的是同一个号）；节标题没有 */
  index?: number;
  /** 目录层级：0 = 节，1 = 卡片 */
  level: 0 | 1;
  /** 节标题不能落在页尾：分页时至少要带走后面一块 */
  keepWithNext?: boolean;
  /** 进不进目录（关系一览这种附录不进） */
  toc: boolean;
  /** 这一块的宽内容（大图 / 宽表）：分栏排版时要横跨整页 */
  wide?: boolean;
  html: string;
}

export interface PrintDoc {
  service: "blotboard";
  boardId: string;
  title: string;
  group: string;
  generatedAt: number;
  stats: { cards: number; edges: number; sections: number; comments: number; openComments: number };
  /** 连线关系的分布，封面上印一行 */
  edgeKinds: { label: string; count: number }[];
  /** 开着筛选时：关键词 / 类型 / 没命中的张数——封面要说清楚这份不是整块板 */
  filtered: { q: string; types: string[]; hidden: number } | null;
  /** 内容样式（与单文件 HTML 导出同一份）。版面样式由浏览器那侧另加 */
  css: string;
  blocks: PrintBlock[];
}

export async function renderPrintDoc(board: Board, options: HtmlExportOptions = {}): Promise<PrintDoc> {
  const prepared = await prepareExport(board, options);
  const { all, cards, edges, comments, looseComments, sections, bare, filtering, q, types, ctx, now } = prepared;

  const blocks: PrintBlock[] = [];
  /* 卡片编号全篇连续：目录、卡头、正文引用的是同一个号（与 HTML 导出同一套口径） */
  let seq = 0;

  sections.forEach((section, at) => {
    const total = section.cards.length + (section.head ? 1 : 0);
    const title = section.head ? cardTitle(section.head) : "单独的卡片";
    if (!bare) {
      blocks.push({
        kind: "section",
        anchor: `sec-${at + 1}`,
        title,
        level: 0,
        // 节标题独占页尾最后一行是最难看的排版错误，分页时它必须带走下一块
        keepWithNext: true,
        toc: true,
        html:
          `<div class="sec-head"><h2>${escapeHtml(title)}</h2>` +
          `<span class="sec-count">${total} 张</span></div>`,
      });
    }
    if (section.head) {
      seq += 1;
      blocks.push({
        kind: "card",
        anchor: section.head.id,
        title: cardTitle(section.head),
        index: seq,
        level: 1,
        toc: true,
        // 区头卡摆成整节的导语（与 HTML 导出一致），样式挂在外层
        html: `<div class="sec-intro">${renderCard(section.head, seq, ctx)}</div>`,
        wide: true,
      });
    }
    for (const card of section.cards) {
      seq += 1;
      blocks.push({
        kind: "card",
        anchor: card.id,
        title: cardTitle(card),
        index: seq,
        level: 1,
        toc: true,
        html: renderCard(card, seq, ctx),
        // 宽内容（大图 / 宽表）由卡片包在渲染时回填，分栏排版要让它横跨整页
        wide: ctx.wide.has(card.id),
      });
    }
  });

  const relationsHtml = renderRelations(cards, edges);
  if (relationsHtml) {
    blocks.push({
      kind: "relations",
      anchor: "sec-relations",
      title: "关系一览",
      level: 0,
      toc: true,
      wide: true,
      html: relationsHtml,
    });
  }

  if (looseComments.length) {
    blocks.push({
      kind: "comments",
      anchor: "sec-loose",
      title: "画布与连线上的评论",
      level: 0,
      toc: true,
      wide: true,
      html:
        `<div class="sec-head"><h2>画布与连线上的评论</h2><span class="sec-count">${looseComments.length} 条</span></div>` +
        `<article class="card">${renderComments(looseComments)}</article>`,
    });
  }

  const edgeKinds = new Map<string, number>();
  for (const edge of edges) {
    const label = EDGE_KIND_META[edge.kind]?.label || "关联";
    edgeKinds.set(label, (edgeKinds.get(label) || 0) + 1);
  }

  return {
    service: "blotboard",
    boardId: board.id,
    title: board.name,
    group: board.group || "",
    generatedAt: now,
    stats: {
      cards: cards.length,
      edges: edges.length,
      sections: sections.length,
      comments: comments.length,
      openComments: comments.filter((comment) => !comment.resolved).length,
    },
    edgeKinds: [...edgeKinds].map(([label, count]) => ({ label, count })),
    filtered: filtering
      ? { q: q.trim(), types: types.map((type) => typeLabelOf(type)), hidden: all.length - cards.length }
      : null,
    css: `${DOC_CSS}${MERMAID_FLOW_CSS}`,
    blocks,
  };
}
