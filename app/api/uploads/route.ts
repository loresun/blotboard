import { assertCanWrite } from "@/lib/auth";
import { ApiError, ok, route } from "@/lib/http";
import { maxBytesFor, storeUploadStream } from "@/lib/uploads";
import { normalizeMediaType, uploadFormatFor } from "@/lib/upload-accept";

export const dynamic = "force-dynamic";

/**
 * 二进制直传：body 是文件字节，文件名走 x-file-name 头（与 goal-agent 的上传口同形状）。
 *
 * **流式落盘**，不再 `arrayBuffer()`：视频动辄几百 MB，先整份读进内存再写出去
 * 会让一次上传的内存峰值等于文件大小。content-length 只是**提前拒**（省得白传半天），
 * 真正的上限在 storeUploadStream 里边收边数——头是可以撒谎的。
 */
export const POST = route(async (request: Request) => {
  assertCanWrite(request);
  const mediaType = normalizeMediaType(request.headers.get("content-type"));
  let rawName = String(request.headers.get("x-file-name") || "");
  try {
    rawName = decodeURIComponent(rawName);
  } catch {
    throw new ApiError("文件名编码无效", 400);
  }
  // 定型先于收字节：格式不收就没必要让对方把 500 MB 传完再说不行
  const format = uploadFormatFor(rawName, mediaType);
  const declared = Number(request.headers.get("content-length") || 0);
  if (format && declared > maxBytesFor(format.kind)) throw new ApiError("附件超过单文件大小上限", 413);
  return ok({ upload: await storeUploadStream(rawName, mediaType, request.body) }, 201);
});
