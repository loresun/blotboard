/** Excalidraw 卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import type { ExcalidrawField } from "@/lib/types";
import { MAX_DIAGRAM_SOURCE, jsonSourceText } from "@/lib/normalize-base";
import { MAX_EXCALIDRAW_SOURCE, MAX_EXCALIDRAW_THUMBNAIL } from "@/lib/constants";
import { badRequest } from "@/lib/http";
import { excalidrawText } from "@/lib/excalidraw-text";
import type { CardPackSchema } from "@/lib/card-pack-types";

/** 一眼能看出是「点开就执行」的协议；元素上的 link / url 只允许普通链接。 */
const DANGEROUS_URL_RE = /^\s*(javascript|vbscript|data:text\/html)/i;

/**
 * 递归剥掉元素里的危险链接。
 *
 * Excalidraw 元素是纯数据（矩形的坐标、文字内容…），本身不带可执行内容；
 * 唯一能「点一下就跑」的入口是 element.link 和 embeddable 的 url，
 * 所以只针对这两类键做剥离，别的字段原样保留——乱改会把画毁掉。
 */
function stripDangerousLinks(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => stripDangerousLinks(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && /^(link|url|href)$/i.test(key) && DANGEROUS_URL_RE.test(item)) {
      out[key] = null;
      continue;
    }
    out[key] = stripDangerousLinks(item, depth + 1);
  }
  return out;
}

/** appState 里只留「这张画长什么样」的字段：选中态 / 协作者 / 滚动位置这些是会话状态，不落库。 */
function pickExcalidrawAppState(input: unknown): Record<string, unknown> {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of ["viewBackgroundColor", "theme", "name"]) {
    if (typeof source[key] === "string") out[key] = String(source[key]).slice(0, 200);
  }
  for (const key of ["gridSize", "gridStep", "exportScale"]) {
    if (Number.isFinite(Number(source[key]))) out[key] = Number(source[key]);
  }
  for (const key of ["gridModeEnabled", "exportBackground", "exportWithDarkMode", "exportEmbedScene", "objectsSnapModeEnabled"]) {
    if (typeof source[key] === "boolean") out[key] = source[key];
  }
  return out;
}

/** files 是「图片元素的图源」表：{ [fileId]: { mimeType, dataURL, ... } }，只放行图片 dataURL。 */
function pickExcalidrawFiles(input: unknown): Record<string, unknown> {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(source)) {
    const file = entry as { dataURL?: unknown; mimeType?: unknown } | null;
    const dataUrl = String(file?.dataURL ?? "");
    if (!/^data:image\//i.test(dataUrl)) continue;
    if (file?.mimeType && !/^image\//i.test(String(file.mimeType))) continue;
    out[id] = entry;
  }
  return out;
}

/**
 * Excalidraw 字段：source 是 .excalidraw JSON 字符串，thumbnail 是卡面 PNG dataURL。
 *
 * 归一化按「先当 JSON 解析」走：解析得开就按白名单重新拼一份
 * （只留 elements / appState 的外观字段 / 图片 files），解析不开才退回按文本剥标签。
 * 为什么不像 SVG 那样直接对整串跑正则——那些正则是按标签写的，
 * 打在 JSON 上会误伤正文（比如画里写了「a on b = c」就被吃掉一段），
 * 结果是存进去的 JSON 再也解析不出来，卡面直接空白。
 *
 * 超上限不截断而是报错：截一半的 JSON 就是一张永远打不开的画，
 * 与其静默存坏数据，不如让用户当场知道这张画太大了。
 *
 * source 允许**直接给对象**：`.excalidraw` 文件 JSON.parse 之后就是一个对象，
 * agent 顺手把它塞进来是最自然的写法。老写法 `String(对象)` 会落一个
 * `"[object Object]"` 进库、整张卡报废，所以统一走 jsonSourceText 先序列化回字符串。
 */
export function normalizeExcalidrawField(input: Partial<ExcalidrawField> = {}): ExcalidrawField {
  const raw = jsonSourceText(input.source, "excalidraw.source");
  let source = "";
  if (raw) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const elements = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.elements) ? parsed.elements : null;
    if (elements) {
      source = JSON.stringify({
        type: "excalidraw",
        version: Number.isFinite(Number(parsed?.version)) ? Number(parsed.version) : 2,
        source: "blotboard",
        elements: stripDangerousLinks(elements.filter((element: unknown) => element && typeof element === "object")),
        appState: pickExcalidrawAppState(Array.isArray(parsed) ? {} : parsed?.appState),
        files: pickExcalidrawFiles(Array.isArray(parsed) ? {} : parsed?.files),
      });
    } else {
      // 不是画布 JSON（用户可能粘了别的东西）：按老路子当文本剥一层再截断，别丢数据
      source = raw
        .slice(0, MAX_DIAGRAM_SOURCE)
        .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
        .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
        .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
        .replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "")
        .trim();
    }
  }
  if (source.length > MAX_EXCALIDRAW_SOURCE) {
    throw badRequest(
      `Excalidraw 画布过大（${Math.round(source.length / 1024)}KB，上限 ${Math.round(MAX_EXCALIDRAW_SOURCE / 1024)}KB）：删掉几张插图或拆成两张卡`,
    );
  }
  const thumb = String(input.thumbnail ?? "").trim();
  const thumbnail =
    thumb && /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(thumb) && thumb.length <= MAX_EXCALIDRAW_THUMBNAIL
      ? thumb
      : undefined;
  const updatedAt = Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : undefined;
  return {
    source,
    ...(thumbnail ? { thumbnail } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.excalidraw = normalizeExcalidrawField(input.excalidraw);
  },
  onConvert(card, patch) {
    card.excalidraw = normalizeExcalidrawField(patch.excalidraw || card.excalidraw || {});
  },
  onPatch(card, patch) {
    if (patch.excalidraw === undefined) return;
    // 缩略图不再随整板下发（几百 KB base64，卡面改从 /drawing 取图），前端手上没有那一份：
    // 补丁里没带就保留已存的，否则一次普通保存就把它抹了。要清空写 thumbnail: null。
    const incoming: Partial<ExcalidrawField> & { thumbnail?: string | null } = { ...(patch.excalidraw || {}) };
    if (incoming.thumbnail === undefined || incoming.thumbnail === "") {
      incoming.thumbnail = card.excalidraw?.thumbnail;
    } else if (incoming.thumbnail === null) {
      incoming.thumbnail = undefined;
    }
    card.excalidraw = normalizeExcalidrawField(incoming as Partial<ExcalidrawField>);
  },
  markdownLines(card) {
    if (!card.excalidraw?.source) return [];
    // .excalidraw JSON 体积大，直接灌会让导出的 md 很臃肿——只带画上的文字 + 大小
    const drawn = excalidrawText(card.excalidraw.source).replace(/\s+/g, " ").slice(0, 300);
    return [`- Excalidraw 自由画（${card.excalidraw.source.length} 字符）${drawn ? `：${drawn}` : ""}`];
  },
};
