import fs from "node:fs";
import { Readable } from "node:stream";
import { openControlledImage, statControlledImage } from "@/lib/uploads";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ uploadId: string }> };

/** 文件流直接交给 Response，Node 自己处理背压；openControlledImage 已验过头部签名。 */
const streamOf = (file: string): ReadableStream<Uint8Array> =>
  Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;

/**
 * 同源图片预览。所有拒绝路径统一 404，不泄露目录 / 文件是否存在。
 *
 * 带 ETag 走协商缓存：卡面上的图最大 10 MB，没命中缓存才走流式读盘。
 * （max-age 之外还要有 ETag —— 刷新页面时浏览器会带 If-None-Match 来问，
 * 没有 ETag 就只能整张重传。）
 *
 * 读盘走流式而不是 readFileSync：一块板上十张 2 MB 图进画布时是并发进来的，
 * 同步整读会把事件循环按住一份文件的时间（十次 ≈ 几十毫秒一次），期间所有
 * 其它请求（含侧栏 /api/boards）都得排队。openControlledImage 只同步读
 * 头部 32 字节做签名校验，正文由 createReadStream 异步吐。
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
    const image = openControlledImage(id);
    return new Response(streamOf(image.file), {
      status: 200,
      headers: { ...headers, "content-length": String(image.size) },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "图片预览不可用" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
