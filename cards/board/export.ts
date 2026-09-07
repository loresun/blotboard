/** 子画板卡的排版导出（自 lib/export-html.ts 机械拆入）。 */
import { body, escapeHtml, link } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card, ctx) {
    const ref = card.boardRef;
    if (!ref?.boardId) return `<p class="empty">这张子画板卡还没指向任何板</p>`;
    return (
      `<p class="note">子画板：<strong>${escapeHtml(ref.name || ref.boardId)}</strong>` +
      (ctx.origin ? ` · ${link(`${ctx.origin}/?board=${encodeURIComponent(ref.boardId)}`, "在画板里打开")}` : ` · <code>${escapeHtml(ref.boardId)}</code>`) +
      `</p><p class="dim">子画板的内容不在这份导出里，各自导各自的一份。</p>` +
      body(card.content)
    );
  },
};
