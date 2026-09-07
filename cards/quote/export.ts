/** 引用卡的排版导出（自 lib/export-html.ts 机械拆入）。 */
import { body, escapeHtml } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card) {
    return (
      `<blockquote>${body(card.content) || ""}</blockquote>` +
      (card.quote?.source ? `<p class="quote-src">—— ${escapeHtml(card.quote.source)}</p>` : "")
    );
  },
};
