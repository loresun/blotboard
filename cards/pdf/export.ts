/** PDF 卡的排版导出（自 lib/export-html.ts 机械拆入）：附件说明 + 回画板打开的链接。 */
import { body, escapeHtml, link } from "@/lib/export-helpers";
import { formatSize } from "@/lib/constants";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card, ctx) {
    return (
      `<p class="note">PDF 附件：${escapeHtml(card.file?.name || "未命名")}` +
      (card.file?.size ? ` · ${formatSize(card.file.size)}` : "") +
      (card.file?.uploadId && ctx.origin
        ? ` · ${link(`${ctx.origin}/api/boards/uploads/${encodeURIComponent(card.file.uploadId)}`, "在画板服务里打开")}`
        : "") +
      `</p>${body(card.content)}`
    );
  },
};
