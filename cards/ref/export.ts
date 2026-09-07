/** 资料卡的排版导出（自 lib/export-html.ts 机械拆入）。 */
import { chip, escapeHtml, link } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";
import type { RefItem } from "@/lib/types";

/** 资料条目的落点：先去知识库的阅读页；解不出 docId、或知识库根本没配置时退回原文链接 */
function refUrl(item: RefItem, aidocsBase: string): string {
  const parts = String(item.resourceId || "").split(":");
  const tail = parts[parts.length - 1] || "";
  const docId = item.docId || (/^\d+$/.test(tail) ? tail : "");
  if (!docId || !aidocsBase) return item.url || "";
  const platform = item.platform || parts[1] || "";
  return `${aidocsBase}/document/${encodeURIComponent(docId)}${platform ? `?platform=${encodeURIComponent(platform)}` : ""}`;
}

export const exporter: CardPackExport = {
  html(card, ctx) {
    const items = card.ref?.items || [];
    return (
      `<p class="note">知识库检索「${escapeHtml(card.ref?.query || "")}」· ${items.length} 条</p><ul class="refs">` +
      items
        .map(
          (item) =>
            `<li><strong>${link(refUrl(item, ctx.aidocsBase), item.title)}</strong>` +
            (item.platform ? ` ${chip(item.platform)}` : "") +
            (item.snippet ? `<p class="dim">${escapeHtml(item.snippet)}</p>` : "") +
            `</li>`,
        )
        .join("") +
      `</ul>`
    );
  },
};
