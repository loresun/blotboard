/**
 * 本地书库桥（地址由 `BOOK_LIBRARY_URL` 给；**实现层**：只被 lib/integrations/library-provider.ts
 * 引用，业务代码一律走 libraryProvider 接口——未配置时那边换成 503 的 null 实现）。
 *
 * 跟知识库那条桥同一个道理：**不复制别人的数据**。画板上的图书卡只留 bookId 与一份
 * 摆得出卡面的元信息，正文 / PDF / 封面统统回书库取。
 *
 * 走服务端代理而不是浏览器直连书库：
 *  - 地址集中在 config，前端不用知道书库在哪台机器的哪个端口；
 *  - 封面同源了才在 Tailscale / 局域网访问画板时也能显示（书库配的回环地址在别人机器上不存在）。
 */
import { BOOK_LIBRARY_URL } from "./config";
import { ApiError } from "./http";
import type { BookField } from "./types";

const TIMEOUT_MS = 10_000;

/** 书库列表里的一本（就是画板图书卡要存的那份快照，另加一个封面地址）。 */
export interface BookSummary extends Omit<BookField, "fetchedAt"> {
  /** 本服务上的封面地址（同源代理，见 app/api/books/[bookId]/cover） */
  cover: string;
}

const ID_RE = /^[a-z0-9_-]+$/;

export function isBookId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120 && ID_RE.test(value);
}

async function callLibrary(path: string, accept: "json" | "raw"): Promise<Response> {
  try {
    const response = await fetch(`${BOOK_LIBRARY_URL}${path}`, {
      headers: accept === "json" ? { accept: "application/json" } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new ApiError(`书库返回 ${response.status}`, 502);
    return response;
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    const message =
      err?.name === "TimeoutError" || err?.name === "AbortError"
        ? "书库请求超时"
        : "连不上书库，请检查书库地址、网络与服务状态";
    throw new ApiError(message, 502);
  }
}

function toSummary(raw: Record<string, any>): BookSummary | null {
  const bookId = String(raw?.id || "").toLowerCase();
  if (!isBookId(bookId)) return null;
  const rawFiles = raw?.files && typeof raw.files === "object" ? raw.files : {};
  const files: BookSummary["files"] = {};
  for (const key of ["html", "pdf", "md"] as const) {
    const value = typeof rawFiles[key] === "string" ? rawFiles[key].trim() : "";
    // 文件名会拼进 /books/{id}/{file}，带路径分隔符的一律不要
    if (value && !value.includes("/") && !value.includes("\\")) files[key] = value;
  }
  return {
    bookId,
    name: String(raw?.name || bookId).slice(0, 300),
    subtitle: String(raw?.subtitle || "").slice(0, 300),
    author: String(raw?.author || "").slice(0, 120),
    desc: String(raw?.desc || "").slice(0, 2000),
    files,
    model: String(raw?.model || "").slice(0, 160),
    created: String(raw?.created || "").slice(0, 40),
    updated: String(raw?.updated || "").slice(0, 40),
    cover: `/api/books/${bookId}/cover`,
  };
}

/**
 * 全量书目。书库一共几十本，没有分页也没有搜索接口——一次拉完在这边过滤，
 * 比给书库加一个只有画板会用的检索口划算。
 */
export async function listBooks(): Promise<BookSummary[]> {
  const response = await callLibrary("/api/books?full=1", "json");
  const data = await response.json().catch(() => null);
  const raw: Record<string, any>[] = Array.isArray(data?.books) ? data.books : [];
  const books = raw.map(toSummary).filter((item): item is BookSummary => Boolean(item));
  // 最近更新的排前面：书库自己的首页也是这个顺序，挑书时符合直觉
  return books.sort((a, b) => (b.updated || b.created || "").localeCompare(a.updated || a.created || ""));
}

/** 封面 SVG 原样转发；书库没有这本书的封面时给 404，卡面自己降级成占位。 */
export async function fetchCover(bookId: string): Promise<{ body: ArrayBuffer; type: string }> {
  if (!isBookId(bookId)) throw new ApiError("bookId 不合法", 400);
  const response = await callLibrary(`/covers/${bookId}.svg`, "raw");
  return {
    body: await response.arrayBuffer(),
    type: response.headers.get("content-type") || "image/svg+xml",
  };
}

/** 书库里这本书的三个阅读入口（绝对地址，给导出 / 新窗口打开用）。 */
export function bookFileUrl(bookId: string, file: string | undefined): string {
  if (!isBookId(bookId) || !file) return "";
  return `${BOOK_LIBRARY_URL}/books/${bookId}/${encodeURIComponent(file)}`;
}
