import { libraryProvider } from "@/lib/integrations/library-provider";
import { ok, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * 本机书库的书目代理（只读，不落库，所以不要 token——与画板其它读接口一致）。
 * `?q=` 在这边过滤：书库没有检索口，一共几十本，拉全量再筛比给书库加接口划算。
 * 书库未配置时统一 503（此时前端入口本来就不渲染）。
 */
export const GET = route(async (request: Request) => {
  const query = new URL(request.url).searchParams.get("q")?.trim().toLowerCase() || "";
  const books = await libraryProvider.listBooks();
  const hits = query
    ? books.filter((book) =>
        [book.bookId, book.name, book.subtitle, book.author, book.desc]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    : books;
  return ok({ total: books.length, query, books: hits });
});
