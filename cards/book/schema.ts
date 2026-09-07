/** 图书卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import type { BookField } from "@/lib/types";
import { MAX_TITLE, cleanText } from "@/lib/normalize-base";
import { ApiError } from "@/lib/http";
import { libraryProvider } from "@/lib/integrations/library-provider";
import type { CardPackSchema } from "@/lib/card-pack-types";

/**
 * 图书卡：只存书库里的 bookId + 一份摆得出卡面的元信息快照。
 * 正文 / PDF / 封面都不复制进画板（跟资料卡同一条红线），要看就回书库取。
 */
export function normalizeBookField(input: Partial<BookField> = {}, { required = false } = {}): BookField {
  const bookId = cleanText(input?.bookId, 120).toLowerCase();
  // 书库自己就限定 id 只能是小写字母/数字/下划线/短横线，这里同口径挡一次：
  // 这个 id 会直接拼进封面与阅读入口的 URL
  if (!/^[a-z0-9_-]+$/.test(bookId)) {
    if (required) throw new ApiError("图书卡需要一个合法的 bookId（书库里的书 id）", 400);
    return { bookId: "", name: "", fetchedAt: Date.now() };
  }
  const rawFiles = (input?.files || {}) as Record<string, unknown>;
  const files: BookField["files"] = {};
  for (const key of ["html", "pdf", "md"] as const) {
    const value = cleanText(rawFiles[key], 300);
    // 产物文件名会拼进 /books/{id}/{file}，别让 ../ 溜进去
    if (value && !value.includes("/") && !value.includes("\\")) files[key] = value;
  }
  return {
    bookId,
    name: cleanText(input?.name, MAX_TITLE, { fallback: bookId }),
    subtitle: cleanText(input?.subtitle, MAX_TITLE),
    author: cleanText(input?.author, 120),
    desc: cleanText(input?.desc, 2000),
    files,
    model: cleanText(input?.model, 160),
    created: cleanText(input?.created, 40),
    updated: cleanText(input?.updated, 40),
    fetchedAt: Number.isFinite(Number(input?.fetchedAt)) ? Number(input?.fetchedAt) : Date.now(),
  };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.book = normalizeBookField(input.book, { required: true });
  },
  onConvert(card, patch) {
    card.book = normalizeBookField({ ...(card.book || {}), ...(patch.book || {}) });
  },
  onPatch(card, patch) {
    if (patch.book !== undefined) card.book = normalizeBookField({ ...(card.book || {}), ...patch.book });
  },
  markdownLines(card) {
    if (!card.book?.bookId) return [];
    const book = card.book;
    const lines = [`- 图书：《${book.name}》（书库 \`${book.bookId}\`）`];
    if (book.subtitle) lines.push(`- 副标题：${book.subtitle}`);
    if (book.author) lines.push(`- 作者：${book.author}`);
    // 书库未配置时 fileUrl 回空串：对应行就地消失，卡片快照本身照常导出
    const readUrl = libraryProvider.fileUrl(book.bookId, book.files?.html);
    const pdfUrl = libraryProvider.fileUrl(book.bookId, book.files?.pdf);
    if (readUrl) lines.push(`- 在线读：${readUrl}`);
    if (pdfUrl) lines.push(`- PDF：${pdfUrl}`);
    if (book.desc) lines.push("", book.desc);
    return lines;
  },
};
