/**
 * 书库 Provider：图书卡的三个诉求——书目、封面字节、指回书库的阅读地址。
 *
 * 现在只有一个实现（见 lib/book-library.ts）；
 * 未配置（env `BOOK_LIBRARY_URL` 为空）时换成 null 实现：接口抛 503，
 * fileUrl 回空串（导出 / Markdown 里对应行就地消失，已有图书卡照常渲染快照）。
 */
import { fetchCover, listBooks, bookFileUrl, type BookSummary } from "../book-library";
import { FEATURES } from "../features";
import { ApiError } from "../http";

export type { BookSummary };

export interface LibraryProvider {
  /** 全量书目（画板侧自己筛，见 app/api/books/route.ts 的理由）。 */
  listBooks(): Promise<BookSummary[]>;
  /** 封面字节（同源代理转发用）。 */
  fetchCover(bookId: string): Promise<{ body: ArrayBuffer; type: string }>;
  /** 书库里某个产物文件的绝对地址；未配置 / 参数不全时回空串。 */
  fileUrl(bookId: string, file: string | undefined): string;
}

const bookLibraryProvider: LibraryProvider = { listBooks, fetchCover, fileUrl: bookFileUrl };

function disabled(): never {
  throw new ApiError("本机书库未配置（设置 BOOK_LIBRARY_URL 环境变量后启用图书卡）", 503);
}

const disabledProvider: LibraryProvider = {
  listBooks: disabled,
  fetchCover: disabled,
  fileUrl: () => "",
};

export const libraryProvider: LibraryProvider = FEATURES.library ? bookLibraryProvider : disabledProvider;
