/**
 * 上传件的格式表——**唯一真源**（客户端可安全 import：零依赖、不碰 node:fs）。
 *
 * 以前这张表存在两处：lib/uploads.ts 的 SPECS（服务端校验）与本文件里手写的
 * 一串 `.png,.jpg,…`（`<input accept>`）。两处各改各的必然漂移——服务端收了新格式、
 * 文件选择器却还是灰的，或者反过来「能选中、传上去 415」。现在只有这一张表，
 * 服务端的 SPECS 与选择器的 accept 都从它派生。
 *
 * 四类 kind（决定落进哪种卡片、多大算超、卡面怎么渲染）：
 *   image → 图片卡（<img>）· audio / video → 音视频卡（<audio>/<video>）· file → PDF 卡
 *
 * **为什么 mediaType 要收别名**：浏览器给的 `File.type` 各家不一样——同一个 .m4a，
 * Safari 报 `audio/x-m4a`、Chrome 报 `audio/mp4`、有些系统干脆给空串。
 * 老的「MIME 与扩展名必须精确对上」在图片上没问题（image/png 全世界一个写法），
 * 到音视频就会把正常文件挡在门外。所以这里按**扩展名**定型，MIME 只做兼容性核对，
 * 真正的把关是服务端的**文件签名校验**（lib/uploads.ts signatureMatches）——
 * 那一层不看任何请求头，只看字节。
 */

/** 上传件的四种用途分类；FileField.kind 落库的就是它。 */
export type UploadKind = "image" | "audio" | "video" | "file";

export interface UploadFormat {
  kind: UploadKind;
  /** 落库与下载响应用的规范 MIME（不用请求头里那个，请求头可以是任意别名） */
  mediaType: string;
  /** 浏览器 / 系统可能报出的别名 MIME */
  aliases?: string[];
  /** 扩展名，第一个是规范名——上传件的 id 用它，所以同一格式只落一种后缀 */
  extensions: string[];
}

/**
 * 允许的格式。加一行就等于「服务端收 + 选择器可选 + 卡片能建」三件事一起生效，
 * 但**签名校验要跟着加一支**（lib/uploads.ts signatureMatches），否则新格式会被一律拒。
 */
export const UPLOAD_FORMATS: readonly UploadFormat[] = [
  /* 图片 */
  { kind: "image", mediaType: "image/png", extensions: ["png"] },
  { kind: "image", mediaType: "image/jpeg", aliases: ["image/jpg"], extensions: ["jpg", "jpeg"] },
  { kind: "image", mediaType: "image/webp", extensions: ["webp"] },
  { kind: "image", mediaType: "image/gif", extensions: ["gif"] },
  // avif：iPhone / 新版 Chrome 截图与导出的默认格式之一，浏览器普遍能渲
  { kind: "image", mediaType: "image/avif", extensions: ["avif"] },
  { kind: "image", mediaType: "image/bmp", aliases: ["image/x-ms-bmp"], extensions: ["bmp"] },
  /* 音频 */
  { kind: "audio", mediaType: "audio/mpeg", aliases: ["audio/mp3", "audio/mpeg3", "audio/x-mpeg-3"], extensions: ["mp3"] },
  { kind: "audio", mediaType: "audio/mp4", aliases: ["audio/x-m4a", "audio/m4a", "audio/aac"], extensions: ["m4a"] },
  { kind: "audio", mediaType: "audio/aac", aliases: ["audio/aacp", "audio/x-aac", "audio/x-hx-aac-adts"], extensions: ["aac"] },
  { kind: "audio", mediaType: "audio/wav", aliases: ["audio/x-wav", "audio/wave", "audio/vnd.wave"], extensions: ["wav"] },
  { kind: "audio", mediaType: "audio/ogg", aliases: ["application/ogg", "audio/vorbis"], extensions: ["ogg", "oga"] },
  { kind: "audio", mediaType: "audio/ogg", aliases: ["audio/opus"], extensions: ["opus"] },
  { kind: "audio", mediaType: "audio/flac", aliases: ["audio/x-flac"], extensions: ["flac"] },
  /* 视频 */
  { kind: "video", mediaType: "video/mp4", extensions: ["mp4"] },
  { kind: "video", mediaType: "video/mp4", aliases: ["video/x-m4v"], extensions: ["m4v"] },
  { kind: "video", mediaType: "video/webm", extensions: ["webm"] },
  // .mov：Mac / iPhone 录屏与相机的默认容器，现在的 .mov 也是 ftyp 盒子（与 mp4 同族）
  { kind: "video", mediaType: "video/quicktime", extensions: ["mov"] },
  { kind: "video", mediaType: "video/ogg", extensions: ["ogv"] },
  /* 文档 */
  { kind: "file", mediaType: "application/pdf", extensions: ["pdf"] },
];

/** 扩展名（不带点，小写）→ 格式。同一格式多个后缀都指向同一条。 */
const BY_EXTENSION = new Map<string, UploadFormat>();
for (const format of UPLOAD_FORMATS) {
  for (const ext of format.extensions) if (!BY_EXTENSION.has(ext)) BY_EXTENSION.set(ext, format);
}

/** 上传控件的 accept（`<input type="file">`）。 */
export const UPLOAD_ACCEPT = [...BY_EXTENSION.keys()].map((ext) => `.${ext}`).join(",");

/** 人看的格式清单，按 kind 归拢——报错文案与 README 都用它，省得再手抄一遍。 */
export function describeUploadFormats(kind: UploadKind): string {
  return UPLOAD_FORMATS.filter((format) => format.kind === kind)
    .flatMap((format) => format.extensions)
    .join(" / ");
}

/** 文件名 → 扩展名（不带点，小写）。 */
export function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  return match ? match[1].toLowerCase() : "";
}

/** 去掉参数与大小写的 MIME（`image/png; charset=…` → `image/png`）。 */
export function normalizeMediaType(raw: unknown): string {
  return String(raw || "").split(";", 1)[0].trim().toLowerCase();
}

/**
 * 声明的 MIME 与这个格式是否兼容。宽在三处，都不影响安全（真正把关的是字节签名）：
 *  · 空 / `application/octet-stream`：浏览器认不出扩展名时就是这两个；
 *  · 别名表里的写法；
 *  · 同一大类（`audio/*` 对 `audio/*`）——别名列不全是常态，同类就放行。
 */
export function mediaTypeCompatible(format: UploadFormat, mediaType: string): boolean {
  const normalized = normalizeMediaType(mediaType);
  if (!normalized || normalized === "application/octet-stream") return true;
  if (normalized === format.mediaType) return true;
  if (format.aliases?.includes(normalized)) return true;
  const family = format.mediaType.split("/", 1)[0];
  return family !== "application" && normalized.startsWith(`${family}/`);
}

/**
 * 按「文件名 + 声明 MIME」定型。认不出扩展名、或 MIME 与扩展名对不上（.png 说自己是视频）
 * 一律 null —— 调用方据此回 415。
 */
export function uploadFormatFor(name: string, mediaType: string): UploadFormat | null {
  const format = BY_EXTENSION.get(extensionOf(name));
  if (!format) return null;
  return mediaTypeCompatible(format, mediaType) ? format : null;
}

/** 上传件 id（永远带规范扩展名）→ 格式。下载响应的 content-type 由它决定。 */
export function uploadFormatOfId(id: string): UploadFormat | null {
  return BY_EXTENSION.get(extensionOf(id)) || null;
}

/**
 * 没有 `File.type` 时按扩展名兜一个（浏览器对 .m4a / .mov / .flac 经常给空串，
 * 而上传口是拿 content-type 头定型的，空串会被判 415）。
 */
export function mediaTypeForName(name: string): string {
  return BY_EXTENSION.get(extensionOf(name))?.mediaType || "application/octet-stream";
}

/** 这种上传件该建成哪种卡：图片 → image，音视频 → media，其余（PDF）→ pdf。 */
export function cardTypeForUploadKind(kind: string): "image" | "media" | "pdf" {
  if (kind === "image") return "image";
  if (kind === "audio" || kind === "video") return "media";
  return "pdf";
}
