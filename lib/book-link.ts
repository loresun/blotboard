"use client";

/**
 * 图书卡的几个出口。
 *
 * 封面走本服务的同源代理（能打开画板就能看见封面）；
 * 正文 / PDF / Markdown 是整本书带一堆相对资源的静态站点，代理不划算，直接指回书库，
 * host 跟着「用户是怎么进来的」走（见 origins.ts 的 sameHostAs）。
 */
import { sameHostAs } from "./origins";
import type { BookField } from "./types";

/**
 * 书库地址只认 body dataset（服务端按 env 下发，见 app/layout.tsx）：
 * 未配置时返回空串，下面几个出口跟着回空串——链接就地不渲染，封面走同源代理不受影响。
 */
export function bookLibraryOrigin(): string {
  const configured = (typeof document !== "undefined" && document.body.dataset.bookLibrary) || "";
  return configured ? sameHostAs(configured) : "";
}

/** 封面：同源代理，相对地址即可 */
export function bookCoverUrl(bookId: string): string {
  return bookId ? `/api/books/${encodeURIComponent(bookId)}/cover` : "";
}

function fileUrl(book: BookField | undefined, key: "html" | "pdf" | "md"): string {
  const file = book?.files?.[key];
  const origin = bookLibraryOrigin();
  if (!book?.bookId || !file || !origin) return "";
  return `${origin}/books/${encodeURIComponent(book.bookId)}/${encodeURIComponent(file)}`;
}

/** 在线读（书库给每本书注了审阅模块，读的就是那一份） */
export const bookReadUrl = (book?: BookField): string => fileUrl(book, "html");
export const bookPdfUrl = (book?: BookField): string => fileUrl(book, "pdf");
export const bookMdUrl = (book?: BookField): string => fileUrl(book, "md");

/** 书库首页里这本书所在的位置（没有产物文件时的兜底出口） */
export function bookLibraryHome(): string {
  return bookLibraryOrigin();
}
