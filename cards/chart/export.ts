/**
 * 图表卡的排版导出：**有意的诚实降级 —— 出数据表，不出图**。
 *
 * 为什么不画图：服务端那支笔（lib/mermaid-flow.ts）只会渲流程图。
 * 把真 mermaid 搬进服务端要 8 MB 依赖、还缺一个能量文字宽度的 DOM
 * （理由写在 mermaid-flow.ts 的抬头，`/api/capabilities` 的 mermaid 段也是这么对外声明的）。
 *
 * 那为什么不干脆放一段源码块：因为**图表卡的内容是那组数**，不是那段语法。
 * 把数据摊成一张表，离线打开这份 HTML 的人一个数都不会少看；
 * 而一段 xychart-beta 源码对他既画不出图、也读不出重点。
 * 加一行灰字说清楚「图在画板里看」，比假装渲染失败诚实。
 */
import { escapeHtml, type ExportHtmlCtx } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";
import { chartToGrid } from "./source";

const KIND_LABEL: Record<string, string> = { bar: "柱状图", line: "折线图", pie: "饼图", quadrant: "四象限图" };

export const exporter: CardPackExport = {
  html(card, _ctx: ExportHtmlCtx) {
    const chart = card.chart;
    if (!chart) return `<p class="empty">空的图表卡</p>`;
    const grid = chartToGrid(chart);
    const kicker = `${KIND_LABEL[chart.kind] || chart.kind}${chart.title ? ` · ${chart.title}` : ""}`;
    if (!grid) return `<p class="note">${escapeHtml(kicker)}</p><p class="empty">这张图表还没有数据</p>`;
    return (
      `<p class="note">${escapeHtml(kicker)} —— 图表在画板里查看，这里列出原始数据</p>` +
      `<table class="sub"><thead><tr>${grid.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>` +
      `<tbody>${grid.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`
    );
  },
};
