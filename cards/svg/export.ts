/** SVG 卡的排版导出（自 lib/export-html.ts 机械拆入）。 */
import { WIDE_AT, escapeHtml, svgWidth } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card, ctx) {
    const source = card.svg?.source || "";
    if (!source.trim()) return `<p class="empty">这张卡还没有 SVG</p>`;
    if (svgWidth(source) > WIDE_AT) ctx.wide.add(card.id);
    // 走 data URI 当图片：图片上下文本来就不执行脚本，比把外来 SVG 直接放进文档安全
    return `<div class="figure"><img src="data:image/svg+xml;utf8,${encodeURIComponent(source)}" alt="${escapeHtml(card.title || "SVG 图")}" /></div>`;
  },
};
