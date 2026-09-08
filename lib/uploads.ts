/**
 * 上传文件（image / media / pdf 卡片的正文）。
 *
 * 从 goal-agent `src/main/task-attachments.js` + `task-images.js` 移植必要部分：
 * 扩展名 / MIME / 真实文件签名三重校验，claimed 标记，孤儿回收，受控预览。
 *
 * **允许哪些格式不在这个文件里**——真源是 lib/upload-accept.ts 的 UPLOAD_FORMATS
 * （客户端的 `<input accept>` 也从那张表派生，两处不会漂移）。这里只做三件事：
 *  ① 按 kind 分档的大小上限；② 字节签名校验（不信任何请求头）；③ 落盘与回收。
 *
 * **音视频是流式落盘的**：一个视频动辄几百 MB，`await request.arrayBuffer()` 会把
 * 整份文件读进内存再写出去（峰值 = 文件大小）。storeUploadStream 边收边写、
 * 超限当场掐断，内存占用与文件大小无关。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MEDIA_MAX_BYTES, UPLOADS_DIR } from "./config";
import { ApiError, badRequest } from "./http";
import {
  UPLOAD_ACCEPT,
  UPLOAD_FORMATS,
  normalizeMediaType,
  uploadFormatFor,
  uploadFormatOfId,
  type UploadFormat,
  type UploadKind,
} from "./upload-accept";

export { UPLOAD_ACCEPT };
export type { UploadKind };

export const UPLOAD_ID_RE = /^web-\d{13}-[a-f0-9]{12}\.[a-z0-9]+$/;
/** 受控预览（`/api/uploads/:id/preview`）只服务图片：id 的后缀必须是图片格式之一。 */
export const CONTROLLED_IMAGE_ID_RE = new RegExp(
  `^web-\\d{13}-[a-f0-9]{12}\\.(?:${UPLOAD_FORMATS.filter((f) => f.kind === "image")
    .flatMap((f) => f.extensions)
    .join("|")})$`,
);

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_MAX_BYTES = 20 * 1024 * 1024;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 半成品（流式上传写到一半断了）的前缀：不是合法 upload id，孤儿回收按超期清。 */
const TMP_PREFIX = ".part-";

/** 按 kind 分档的单文件上限：图 10 MB / PDF 20 MB / 音视频看 BLOTBOARD_MEDIA_MAX_MB（默认 200 MB）。 */
export function maxBytesFor(kind: UploadKind): number {
  if (kind === "image") return IMAGE_MAX_BYTES;
  if (kind === "audio" || kind === "video") return MEDIA_MAX_BYTES;
  return FILE_MAX_BYTES;
}

export function sanitizeUploadName(input: unknown, fallback = "附件"): string {
  let name = String(input || "");
  try {
    name = decodeURIComponent(name);
  } catch {
    /* 已是明文 */
  }
  name = path.basename(name).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 160);
  return name && name !== "." && name !== ".." ? name : fallback;
}

const ascii = (bytes: Buffer, start: number, end: number) => bytes.subarray(start, end).toString("ascii");

/**
 * 字节签名校验：**只看内容，不看任何请求头**。改个扩展名混别的东西进来在这里被拦下。
 *
 * 容器族说明：mp4 / m4a / m4v / mov 都是 ISO-BMFF，第 5-8 字节是 `ftyp`；
 * webm 是 Matroska 的 EBML 头（0x1A45DFA3）；ogg/opus 是 `OggS`。
 * 只认容器不认编码——里面的视频编码浏览器放不放得动是另一回事（放不动是黑屏，不是安全问题）。
 */
function signatureMatches(mediaType: string, bytes: Buffer): boolean {
  switch (mediaType) {
    /* 图片 */
    case "image/png":
      return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6));
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
    case "image/avif":
      // avif 也是 ISO-BMFF 盒子：ftyp + brand avif / avis
      return ascii(bytes, 4, 8) === "ftyp" && ["avif", "avis", "mif1", "msf1"].includes(ascii(bytes, 8, 12));
    case "image/bmp":
      return ascii(bytes, 0, 2) === "BM";
    /* 音频 */
    case "audio/mpeg":
      // ID3 标签开头，或者直接是帧同步（0xFF 后三位全 1）
      return ascii(bytes, 0, 3) === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case "audio/aac":
      // 裸 ADTS：同样是帧同步；有些导出工具会先塞个 ID3
      return ascii(bytes, 0, 3) === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0);
    case "audio/wav":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE";
    case "audio/ogg":
    case "video/ogg":
      return ascii(bytes, 0, 4) === "OggS";
    case "audio/flac":
      return ascii(bytes, 0, 4) === "fLaC" || ascii(bytes, 0, 3) === "ID3";
    /* 视频 */
    case "audio/mp4":
    case "video/mp4":
    case "video/quicktime":
      return ascii(bytes, 4, 8) === "ftyp";
    case "video/webm":
      return bytes.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"));
    /* 文档 */
    case "application/pdf":
      return ascii(bytes, 0, 5) === "%PDF-";
    default:
      return false;
  }
}

/** 签名校验要看的头部字节数（ISO-BMFF 的 brand 在第 12 字节，留足余量）。 */
const SIGNATURE_PEEK_BYTES = 32;
export function claimMarker(file: string): string {
  return `${file}.claimed`;
}

export function isClaimed(id: string): boolean {
  return fs.existsSync(claimMarker(path.join(UPLOADS_DIR, id)));
}

/** 只回收超期且未被任何卡片引用（无 .claimed）的暂存上传，以及断掉的流式半成品。 */
export function cleanupOrphanUploads(
  { now = Date.now(), maxAgeMs = ORPHAN_MAX_AGE_MS }: { now?: number; maxAgeMs?: number } = {},
): number {
  let removed = 0;
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  } catch {
    return removed;
  }
  for (const entry of fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const isPart = entry.name.startsWith(TMP_PREFIX);
    if (!isPart && !UPLOAD_ID_RE.test(entry.name)) continue;
    const file = path.join(UPLOADS_DIR, entry.name);
    if (!isPart && fs.existsSync(claimMarker(file))) continue;
    try {
      if (now - fs.statSync(file).mtimeMs < maxAgeMs) continue;
      fs.unlinkSync(file);
      removed += 1;
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  return removed;
}

export interface StoredUpload {
  id: string;
  kind: UploadKind;
  name: string;
  mediaType: string;
  size: number;
  previewUrl?: string;
}

/** 上传前的共同准备：定型 + 建目录 + 顺手回收孤儿 + 起一个新 id。 */
function prepareUpload(rawName: string, rawMediaType: string): { name: string; format: UploadFormat; id: string } {
  const name = sanitizeUploadName(rawName, "附件");
  if (!rawName || rawName !== name || /[\\/]/.test(rawName)) throw badRequest("文件名无效");
  const format = uploadFormatFor(name, normalizeMediaType(rawMediaType));
  if (!format) throw new ApiError(`文件扩展名或 MIME 不在允许列表（允许：${UPLOAD_ACCEPT}）`, 415);
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  cleanupOrphanUploads();
  const id = `web-${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}.${format.extensions[0]}`;
  return { name, format, id };
}

function storedUpload(id: string, name: string, format: UploadFormat, size: number): StoredUpload {
  return {
    id,
    kind: format.kind,
    name,
    mediaType: format.mediaType,
    size,
    ...(format.kind === "image" ? { previewUrl: `/api/uploads/${encodeURIComponent(id)}/preview` } : {}),
  };
}

function oversizeMessage(kind: UploadKind, maxBytes: number): string {
  const mb = Math.round(maxBytes / (1024 * 1024));
  const hint = kind === "audio" || kind === "video" ? "（改 BLOTBOARD_MEDIA_MAX_MB 可以放宽）" : "";
  return `附件超过单文件大小上限（${kind} 最大 ${mb} MB）${hint}`;
}

/**
 * 流式落盘：边收边写，超限当场掐断，内存占用与文件大小无关。
 *
 * 顺序讲究——先写半成品 `.part-<id>`，全部收完、签名与大小都过了才 rename 成正式 id。
 * 这样「传到一半断线」不会在 uploads 目录里留下一个能被卡片引用的残缺文件
 * （rename 在同一个目录里是原子的）。半成品由孤儿回收按超期清。
 */
export async function storeUploadStream(
  rawName: string,
  rawMediaType: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<StoredUpload> {
  if (!body) throw badRequest("请求体是空的：上传要把文件字节放在 body 里");
  const { name, format, id } = prepareUpload(rawName, rawMediaType);
  const maxBytes = maxBytesFor(format.kind);
  const partFile = path.join(UPLOADS_DIR, `${TMP_PREFIX}${id}`);
  const handle = fs.openSync(partFile, "wx");

  const head: Buffer[] = [];
  let headBytes = 0;
  let size = 0;
  let checked = false;
  const checkHead = () => {
    if (!signatureMatches(format.mediaType, Buffer.concat(head))) {
      throw new ApiError("文件内容与名称或 MIME 不一致", 415);
    }
    checked = true;
  };

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) throw new ApiError(oversizeMessage(format.kind, maxBytes), 413);
      if (!checked && headBytes < SIGNATURE_PEEK_BYTES) {
        head.push(chunk);
        headBytes += chunk.length;
        if (headBytes >= SIGNATURE_PEEK_BYTES) checkHead();
      }
      fs.writeSync(handle, chunk);
    }
    // 文件比 32 字节还短：收完了再校验（空文件同样在这里被拒）
    if (!checked) checkHead();
    fs.closeSync(handle);
    fs.renameSync(partFile, path.join(UPLOADS_DIR, id));
  } catch (err) {
    try {
      fs.closeSync(handle);
    } catch {
      /* 已关 */
    }
    try {
      fs.unlinkSync(partFile);
    } catch {
      /* 已清 */
    }
    // 客户端可能还在发：主动取消，别让连接吊着
    try {
      await reader.cancel();
    } catch {
      /* 对端已断 */
    }
    throw err;
  }
  return storedUpload(id, name, format, size);
}

/**
 * 一次性落盘（字节已经在手上）：**画板包导入**用这条路把包里带的附件还原成本机上传件。
 *
 * 与流式那条的区别只有「字节从哪来」：校验（扩展名 / MIME / 真实签名 / 大小上限）
 * 一条不少，先写半成品再 rename 也一样——包是外面来的，不能因为「是我们自己的格式」
 * 就少检一道。回来的 id 是**本机新生成的**，导入侧要按它改写卡片里的 uploadId。
 */
export function storeUploadBytes(rawName: string, rawMediaType: string, bytes: Buffer): StoredUpload {
  const { name, format, id } = prepareUpload(rawName, rawMediaType);
  if (bytes.length > maxBytesFor(format.kind)) {
    throw new ApiError(oversizeMessage(format.kind, maxBytesFor(format.kind)), 413);
  }
  if (!signatureMatches(format.mediaType, bytes.subarray(0, SIGNATURE_PEEK_BYTES))) {
    throw new ApiError("文件内容与名称或 MIME 不一致", 415);
  }
  const partFile = path.join(UPLOADS_DIR, `${TMP_PREFIX}${id}`);
  try {
    fs.writeFileSync(partFile, bytes, { flag: "wx" });
    fs.renameSync(partFile, path.join(UPLOADS_DIR, id));
  } catch (err) {
    try {
      fs.unlinkSync(partFile);
    } catch {
      /* 已清 */
    }
    throw err;
  }
  return storedUpload(id, name, format, bytes.length);
}

export function resolveUploadFile(id: string): string {
  if (!UPLOAD_ID_RE.test(id) || path.basename(id) !== id) throw badRequest("上传 id 无效");
  const file = path.join(UPLOADS_DIR, id);
  if (!file.startsWith(`${UPLOADS_DIR}${path.sep}`)) throw badRequest("上传 id 无效");
  return file;
}

/** 这个上传件在本机存不存在（画板包导入判断「这份附件要不要还原」用）。 */
export function uploadExists(id: string): boolean {
  try {
    return fs.statSync(resolveUploadFile(id)).isFile();
  } catch {
    return false;
  }
}

/**
 * 按 id 读回上传件的字节与大小（导出打包用）。
 * 读不到就回 null——缺一个附件不该让整份导出失败，调用方记一条说明即可。
 */
export function readUploadBytes(id: string): { bytes: Buffer; mediaType: string } | null {
  try {
    const file = resolveUploadFile(id);
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return { bytes: fs.readFileSync(file), mediaType: mediaTypeForId(id) };
  } catch {
    return null;
  }
}

/** 上传件的大小（不读内容）：打包前先按上限挑，别把 200 MB 的视频读进内存再放弃。 */
export function uploadSize(id: string): number | null {
  try {
    const stat = fs.statSync(resolveUploadFile(id));
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/**
 * 受控图片的定位与校验（不读内容）：调用方只能传本服务生成的 id，不能传路径；
 * 这里复检 realpath、软链与大小。拆出来是为了能先算 ETag——
 * 命中协商缓存时就不必把整个文件读进内存了（卡面上的图最大 10 MB）。
 */
export function statControlledImage(rawId: string): { id: string; mediaType: string; file: string; size: number; etag: string } {
  const id = String(rawId || "");
  if (!CONTROLLED_IMAGE_ID_RE.test(id) || path.basename(id) !== id) throw new Error("受控图片 id 无效");
  const mediaType = uploadFormatOfId(id)?.mediaType || "";
  if (!mediaType) throw new Error("受控图片 id 无效");

  let root: string;
  try {
    root = fs.realpathSync(UPLOADS_DIR);
  } catch {
    throw new Error("受控图片不存在");
  }
  const candidate = path.join(root, id);
  let linkStat: fs.Stats;
  try {
    linkStat = fs.lstatSync(candidate);
  } catch {
    throw new Error("受控图片不存在");
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw new Error("受控图片不可预览");
  const resolved = fs.realpathSync(candidate);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("受控图片不可预览");
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || !stat.size || stat.size > IMAGE_MAX_BYTES) throw new Error("受控图片不可预览");
  // 上传文件是一次性写入、永不就地修改的，mtime + 大小足以当版本号
  return { id, mediaType, file: resolved, size: stat.size, etag: `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"` };
}

/** 受控图片预览：在 statControlledImage 的基础上再复检一次真实图片签名。 */
export function readControlledImage(rawId: string): { id: string; mediaType: string; bytes: Buffer; etag: string } {
  const found = statControlledImage(rawId);
  const bytes = fs.readFileSync(found.file);
  if (!signatureMatches(found.mediaType, bytes)) throw new Error("受控图片不可预览");
  return { id: found.id, mediaType: found.mediaType, bytes, etag: found.etag };
}

/**
 * 受控图片的流式准备：与 readControlledImage 同一套校验（stat + realpath + 大小上限 + 真实签名），
 * 但**不把整个文件读进内存**——只读头部 SIGNATURE_PEEK_BYTES 验签名，把路径交给调用方走
 * createReadStream。一屏十几张 2 MB 图并发进预览口时，readFileSync 的同步整读会一次次把
 * 事件循环按住；流式后单请求的同步开销只剩头部那一次几十字节的 readSync。
 */
export function openControlledImage(rawId: string): { id: string; mediaType: string; file: string; size: number; etag: string } {
  const found = statControlledImage(rawId);
  const handle = fs.openSync(found.file, "r");
  try {
    const head = Buffer.alloc(SIGNATURE_PEEK_BYTES);
    const read = fs.readSync(handle, head, 0, SIGNATURE_PEEK_BYTES, 0);
    if (!signatureMatches(found.mediaType, head.subarray(0, read))) throw new Error("受控图片不可预览");
  } finally {
    fs.closeSync(handle);
  }
  return found;
}

export function mediaTypeForId(id: string): string {
  return uploadFormatOfId(id)?.mediaType || "application/octet-stream";
}

