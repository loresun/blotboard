/** Mermaid 卡的排版导出（自 lib/export-html.ts 机械拆入）：服务端渲成矢量流程图。 */
import { WIDE_AT, escapeHtml, svgWidth } from "@/lib/export-helpers";
import { renderMermaidFlowchart } from "@/lib/mermaid-flow";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card, ctx) {
    const source = card.mermaid?.source || "";
    if (!source.trim()) return `<p class="empty">这张图表还没有源码</p>`;
    const render = renderMermaidFlowchart(source);
    if (render.svg) {
      if (svgWidth(render.svg) > WIDE_AT) ctx.wide.add(card.id);
      return `<div class="figure">${render.svg}</div>`;
    }
    return (
      `<p class="note">${escapeHtml(render.kind ? `${render.kind} 不是流程图，服务端只渲染流程图，这里保留源码` : render.reason || "无法渲染")}</p>` +
      `<pre class="code">${escapeHtml(source)}</pre>`
    );
  },
};
