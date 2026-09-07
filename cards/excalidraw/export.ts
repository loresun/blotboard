/** Excalidraw 卡的排版导出（自 lib/export-html.ts 机械拆入）。 */
import { WIDE_AT, escapeHtml } from "@/lib/export-helpers";
import { renderExcalidrawSvg } from "@/lib/excalidraw-svg";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card, ctx) {
    // 场景 JSON 才是这张画的真身，缩略图只是「在编辑器里存过一次」留下的缓存——
    // agent 批量建的卡根本没进过编辑器。所以先照着 source 现渲一张矢量图，
    // 渲不出来（外来 JSON 什么都可能）才退回那张缓存
    const render = renderExcalidrawSvg(card.excalidraw?.source || "", card.title || "");
    if (render.svg) {
      if (render.width > WIDE_AT) ctx.wide.add(card.id);
      return `<div class="figure">${render.svg}</div>`;
    }
    const thumbnail = card.excalidraw?.thumbnail || "";
    if (thumbnail.startsWith("data:image/")) {
      return `<div class="figure"><img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(card.title || "Excalidraw 图")}" /></div>`;
    }
    return `<p class="note">这张 Excalidraw 卡画不出来：${escapeHtml(render.reason || "场景是空的")}。</p>`;
  },
};
