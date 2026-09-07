import { libraryProvider } from "@/lib/integrations/library-provider";
import { fail, route } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ bookId: string }> };

/**
 * 封面代理。为什么不让卡面直接 `<img src="http://<书库地址>/covers/x.svg">`：
 * 那个地址只在书库那台机器上成立，从 Tailscale / 局域网打开画板时是一张裂图。
 * 走同源代理后，能访问画板就能看见封面。
 *
 * 封面是书库按 books_meta 生成的静态 SVG，不常变，给 5 分钟浏览器缓存
 * ——一屏十几张图书卡，不缓存的话每次平移都要回源一遍。
 *
 * **上游的 content-type 不原样透传**：这条响应是**同源**的，上游只要回一个
 * `text/html`，直接访问 `/api/books/<id>/cover` 就成了画板域上的一段第三方 HTML；
 * 就算老实回 `image/svg+xml`，SVG 里也能塞 `<script>`——同源直开一样执行。
 * 书库是用户自己配的服务（`BOOK_LIBRARY_URL`），但「我信任这个服务」不等于
 * 「这个服务永远不会被人塞进一张脏封面」。所以：
 *  ① content-type 收敛到图片白名单，不认识的一律按 SVG 处理；
 *  ② 加一层只管这条响应的 CSP —— 图片该有的东西一样不缺，脚本 / 取数 / 套框全断；
 *  ③ `content-disposition: inline` + `sandbox`：直接访问时它是一张图，不是一个页面。
 * 卡面 `<img src>` 不受任何影响（图片上下文本来就不执行脚本）。
 */
const COVER_TYPES = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/** 只取 `;` 前的主类型：上游常带 `; charset=utf-8`。 */
function safeCoverType(raw: string): string {
  const type = String(raw || "").split(";")[0].trim().toLowerCase();
  return COVER_TYPES.has(type) ? type : "image/svg+xml";
}

export const GET = route(async (_request: Request, ctx: Ctx) => {
  const { bookId } = await ctx.params;
  try {
    // 书库未配置时这里 503：老板子上的图书卡还在，卡面 onError 自己降级成占位
    const { body, type } = await libraryProvider.fetchCover(decodeURIComponent(bookId));
    return new Response(body, {
      headers: {
        "content-type": safeCoverType(type),
        "cache-control": "public, max-age=300",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      },
    });
  } catch (err) {
    return fail(err);
  }
});
