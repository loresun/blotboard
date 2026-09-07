/** 图片卡的排版导出（自 lib/export-html.ts 机械拆入）：上传件内联成 data URI。 */
import { body, escapeHtml } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card, ctx) {
    const uri = card.file?.uploadId ? ctx.assets.get(`upload:${card.file.uploadId}`) : "";
    // data-asset 写的是上传件 id：产物里这份 data URI 同时也是「HTML 导回画板」时的图片来源
    // （见 lib/board-bundle.ts 的 extractBundleFromHtml），载荷里因此不必再存第二份字节
    if (uri) {
      return `<div class="figure"><img data-asset="${escapeHtml(card.file!.uploadId!)}" src="${uri}" alt="${escapeHtml(card.title || "图片")}" /></div>${body(card.content)}`;
    }
    return `<p class="note">图片 ${escapeHtml(card.file?.name || "未命名")} 没能内联（文件不在或过大）</p>${body(card.content)}`;
  },
};
