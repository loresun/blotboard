/** 链接卡的排版导出（自 lib/export-html.ts 机械拆入）。 */
import { body, escapeHtml, link } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card) {
    return (
      `<p class="link-line">${link(card.link?.url, card.link?.title || card.link?.url)}</p>` +
      (card.link?.desc ? `<p class="dim">${escapeHtml(card.link.desc)}</p>` : "") +
      body(card.content)
    );
  },
};
