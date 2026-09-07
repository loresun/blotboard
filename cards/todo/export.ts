/** 待办卡的排版导出（自 lib/export-html.ts 机械拆入）。 */
import { escapeHtml } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card) {
    const items = card.todo?.items || [];
    if (!items.length) return `<p class="empty">这个清单还是空的</p>`;
    const done = items.filter((item) => item.done).length;
    return (
      `<p class="note">${done} / ${items.length} 已完成</p><ul class="todo">` +
      items
        .map((item) => `<li class="${item.done ? "done" : ""}"><span class="box">${item.done ? "✓" : ""}</span>${escapeHtml(item.text)}</li>`)
        .join("") +
      `</ul>`
    );
  },
};
