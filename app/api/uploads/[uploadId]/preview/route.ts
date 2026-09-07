import { readControlledImage, statControlledImage } from "@/lib/uploads";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ uploadId: string }> };

/**
 * 同源图片预览。所有拒绝路径统一 404，不泄露目录 / 文件是否存在。
 *
 * 带 ETag 走协商缓存：卡面上的图最大 10 MB，没命中缓存才把文件读进内存。
 * （max-age 之外还要有 ETag —— 刷新页面时浏览器会带 If-None-Match 来问，
 * 没有 ETag 就只能整张重传。）
 */
export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const { uploadId } = await ctx.params;
    const id = decodeURIComponent(uploadId);
    const meta = statControlledImage(id);
    const headers: Record<string, string> = {
      "content-type": meta.mediaType,
      "cache-control": "private, max-age=86400",
      etag: meta.etag,
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    };
    if (request.headers.get("if-none-match") === meta.etag) {
      return new Response(null, { status: 304, headers: { etag: meta.etag, "cache-control": headers["cache-control"] } });
    }
    const image = readControlledImage(id);
    return new Response(new Uint8Array(image.bytes), {
      status: 200,
      headers: { ...headers, "content-length": String(image.bytes.length) },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "图片预览不可用" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
