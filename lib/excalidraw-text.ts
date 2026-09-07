/**
 * 从 .excalidraw JSON 里只捞出画上写的字（从 lib/search-text.ts 拆出，前后端同构）。
 *
 * 不把整份 JSON 丢进 haystack：那样搜「text」会命中每一个文本元素的字段名，
 * 而且没标题的卡片在列表/阅读目录里会拿 `{"type":"excalidraw"…` 当标题显示。
 * 单独成模块是为了让 cards/excalidraw/meta.ts 能零环引用它。
 */

/* Excalidraw 的 source 是一大坨 JSON；每次搜索都重新 parse 太亏，按 source 缓存解析结果。 */
const excalidrawTextCache = new Map<string, string>();
const MAX_EXCALIDRAW_TEXT_CACHE = 64;

export function excalidrawText(source?: string | null): string {
  const raw = String(source || "").trim();
  if (!raw) return "";
  const cached = excalidrawTextCache.get(raw);
  if (cached !== undefined) return cached;
  let text = "";
  try {
    const data = JSON.parse(raw);
    const elements = Array.isArray(data) ? data : data?.elements;
    if (Array.isArray(elements)) {
      text = elements
        .filter((element: any) => element && !element.isDeleted)
        .map((element: any) => String(element.originalText || element.text || "").trim())
        .filter(Boolean)
        .join(" ");
    }
  } catch {
    /* 解析不了就当没有文本，别把 JSON 噪音塞进搜索 */
  }
  if (excalidrawTextCache.size >= MAX_EXCALIDRAW_TEXT_CACHE) {
    const oldest = excalidrawTextCache.keys().next().value;
    if (oldest !== undefined) excalidrawTextCache.delete(oldest);
  }
  excalidrawTextCache.set(raw, text);
  return text;
}
