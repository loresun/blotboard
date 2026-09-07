/**
 * 表格卡的排版导出：一张**真表格**。
 * 沿用规格卡那套属性表的样式语言（`table.sub`，有表头底色与细边框），
 * 不另起一套 class——导出产物的视觉一致性靠的就是这几个类。
 */
import { escapeHtml, type ExportHtmlCtx } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";
import { TABLE_ALIGNS, type TableField } from "@/lib/types";

/** 表格卡与图表卡的降级表共用这一份渲染。 */
export function renderTableHtml(table: TableField): string {
  const columns = table.columns || [];
  if (!columns.length) return "";
  // whole/import intentionally preserve malformed legacy fields: validate again at the HTML sink.
  const align = (column: { align?: string }) =>
    column.align && (TABLE_ALIGNS as readonly string[]).includes(column.align)
      ? ` style="text-align:${column.align}"`
      : "";
  const head = columns.map((column) => `<th${align(column)}>${escapeHtml(column.label)}</th>`).join("");
  const body = (table.rows || [])
    .map(
      (row) =>
        `<tr>${columns.map((column) => `<td${align(column)}>${escapeHtml(row[column.key] ?? "")}</td>`).join("")}</tr>`,
    )
    .join("");
  return (
    (table.caption ? `<p class="note">${escapeHtml(table.caption)}</p>` : "") +
    `<table class="sub"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  );
}

export const exporter: CardPackExport = {
  html(card, _ctx: ExportHtmlCtx) {
    const table = card.table;
    if (!table?.columns?.length) return `<p class="empty">这张表格还没有列</p>`;
    return renderTableHtml(table);
  },
};
