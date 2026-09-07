/** 图书卡的排版导出（自 lib/export-html.ts 机械拆入）。 */
import { body, chip, escapeHtml, followHost, link } from "@/lib/export-helpers";
import { libraryProvider } from "@/lib/integrations/library-provider";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card, ctx) {
    const book = card.book;
    if (!book?.bookId) return `<p class="empty">这张图书卡还没挑书</p>`;
    const cover = ctx.assets.get(`book:${book.bookId}`);
    // 书库未配置时 fileUrl 回空串 → 三个阅读入口整组消失，快照（书名/作者/简介）照常导出
    const bookBase = (file?: string) => followHost(libraryProvider.fileUrl(book.bookId, file), ctx.origin);
    const entries: [string, string][] = [
      [bookBase(book.files?.html), "在线读"],
      [bookBase(book.files?.pdf), "PDF"],
      [bookBase(book.files?.md), "Markdown 原稿"],
    ];
    return (
      `<div class="book">` +
      (cover ? `<img class="book-cover" src="${cover}" alt="${escapeHtml(book.name)}封面" />` : "") +
      `<div class="book-main"><h4>${escapeHtml(book.name)}</h4>` +
      (book.subtitle ? `<p class="dim">${escapeHtml(book.subtitle)}</p>` : "") +
      `<p class="meta">${[book.author, book.model, book.created].filter(Boolean).map((item) => chip(String(item))).join("")}</p>` +
      (book.desc ? body(book.desc) : "") +
      `<p class="meta">${entries.filter(([url]) => url).map(([url, label]) => link(url, label)).join(" · ")}</p>` +
      `</div></div>`
    );
  },
};
