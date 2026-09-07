/** 网页嵌入卡的排版导出（自 lib/export-html.ts 机械拆入）：
    导出是**一份自包含的离线稿**（零外部请求），活的 iframe 进不来，
    也不该进——打印成 A4 的时候它只是一个白框。这里留地址与页面尺寸，
    想看活页回画板打开这张卡。 */
import { body, escapeHtml, link } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card) {
    const html = card.html;
    if (!html?.url) return `<p class="empty">这张网页卡还没填地址</p>${body(card.content)}`;
    const size = html.frameW && html.frameH ? `${html.frameW} × ${html.frameH}` : "铺满卡片";
    return (
      `<p class="note">嵌入网页：${link(html.url, html.host || html.url)} · 页面尺寸 ${escapeHtml(size)}</p>` +
      `<p class="dim">导出里放的是地址而不是页面本身——这份稿子是离线自包含的，不发任何外部请求。</p>` +
      body(card.content)
    );
  },
};
