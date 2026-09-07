import { cookies } from "next/headers";
import { notFound, ok, route } from "@/lib/http";
import { getDoc, listDocs } from "@/lib/docs";
import { LOCALE_COOKIE, parseLocale, type Locale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/**
 * 帮助文档（只读，免鉴权，与其它读口一致）。真源是 `docs/guide/*.md`，见 lib/docs.ts 抬头。
 *
 *  - `GET /api/docs` —— 目录（分组 + 每页的标题 / 摘要），不含正文；
 *  - `GET /api/docs?slug=quickstart` —— 那一页的 Markdown 正文（JSON 裹一层）；
 *  - `GET /api/docs?slug=quickstart&format=md` —— 同一份正文的裸 Markdown，
 *    给 agent 直接读（人看的同一份在 `/docs` 页）。
 *
 * 语言跟着**浏览器选的那份**（locale cookie），所以 /docs 页一行代码都不用改；
 * agent 那边没有 cookie，用 `?lang=en` 显式指定——两边都不用猜。
 * 某一页还没译就按页退回中文（见 lib/docs.ts）。
 */
export const GET = route(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const locale: Locale = params.has("lang")
    ? parseLocale(params.get("lang"))
    : parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const slug = params.get("slug");
  if (!slug) return ok({ ...listDocs(locale) });

  const doc = getDoc(slug, locale);
  if (!doc) throw notFound(`没有这一页帮助：${slug}`);
  if (params.get("format") === "md") {
    return new Response(doc.body, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return ok({ doc: { ...doc } });
});
