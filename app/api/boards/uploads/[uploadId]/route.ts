import fs from "node:fs";
import { Readable } from "node:stream";
import { fail, notFound, route } from "@/lib/http";
import { mediaTypeForId, resolveUploadFile } from "@/lib/uploads";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ uploadId: string }> };

/** `bytes=start-end` 里能用的那一种：单段、闭区间可缺一头。多段（逗号分隔）不支持。 */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  // `bytes=-500` = 最后 500 字节
  const start = rawStart ? Number(rawStart) : Math.max(0, size - Number(rawEnd));
  const end = rawStart ? (rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

const streamOf = (file: string, start?: number, end?: number): ReadableStream<Uint8Array> =>
  Readable.toWeb(fs.createReadStream(file, start === undefined ? {} : { start, end })) as ReadableStream<Uint8Array>;

/**
 * 受控文件下载（image / media / pdf 卡片的正文）。
 *
 * 两件事是为音视频加的，缺一个视频就不能用：
 *  ① **Range 分段**（`accept-ranges` + 206）——`<video>` 拖进度条就是发 Range 请求，
 *     服务端只会整份 200 的话，拖动要么无效要么整段重下；Safari 更干脆，
 *     没有 `accept-ranges` 直接不播。
 *  ② **流式响应**（不再 `readFileSync`）——一份 500 MB 的视频整个读进内存才开始发，
 *     既慢又能把进程撑爆。
 *
 * 鉴权照旧**故意没有**（卡面 `<img src>`／`<video src>` 与导出的 HTML 都要能直接取）：
 * 拦住它的是不可枚举的 upload id 与 server.mjs 那道网络层闸门（见 AGENTS.md 红线 10）。
 */
export const GET = route(async (request: Request, ctx: Ctx) => {
  const { uploadId } = await ctx.params;
  const id = decodeURIComponent(uploadId);
  const file = resolveUploadFile(id);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return fail(notFound("文件不存在"));
  }
  if (!stat.isFile()) return fail(notFound("文件不存在"));

  const headers: Record<string, string> = {
    "content-type": mediaTypeForId(id),
    "cache-control": "private, max-age=86400",
    // 上传件一次写入永不就地修改，mtime + 大小足以当版本号（与图片预览口同一口径）
    etag: `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`,
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "accept-ranges": "bytes",
  };

  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    const range = parseRange(rangeHeader, stat.size);
    // 要得出界要回 416 并告诉对方总长，否则播放器会一直重试同一个坏区间
    if (!range) {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${stat.size}` } });
    }
    return new Response(streamOf(file, range.start, range.end), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${range.start}-${range.end}/${stat.size}`,
        "content-length": String(range.end - range.start + 1),
      },
    });
  }

  return new Response(streamOf(file), {
    status: 200,
    headers: { ...headers, "content-length": String(stat.size) },
  });
});
