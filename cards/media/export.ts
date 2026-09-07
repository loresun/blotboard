/**
 * 音视频卡的排版导出：说明 + 回画板打开的链接（照 PDF 卡那条路）。
 *
 * **刻意不内联**：导出的单文件 HTML 是「零外链、离线可开」的，图片因此内联成 data URI；
 * 但一段视频 base64 之后是原文件的 4/3，一张板上两三个视频就能把导出文件顶到几百 MB，
 * 打不开也发不出去。所以音视频只留指回画板服务的链接——画板在，就点得开。
 */
import { body, escapeHtml, link } from "@/lib/export-helpers";
import { formatSize } from "@/lib/constants";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card, ctx) {
    const kind = card.file?.kind === "audio" ? "音频" : "视频";
    return (
      `<p class="note">${kind}：${escapeHtml(card.file?.name || "未命名")}` +
      (card.file?.size ? ` · ${formatSize(card.file.size)}` : "") +
      (card.file?.uploadId && ctx.origin
        ? ` · ${link(`${ctx.origin}/api/boards/uploads/${encodeURIComponent(card.file.uploadId)}`, "在画板服务里播放")}`
        : "") +
      `</p>${body(card.content)}`
    );
  },
};
