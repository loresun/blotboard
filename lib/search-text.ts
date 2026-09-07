/**
 * 卡片全文检索的共享工具（前后端同一份）：
 * 画布搜索、左栏卡片列表、跨画板搜索接口都用这里的 haystack，
 * 保证同一个词在哪儿搜都命中同一批卡。
 *
 * 专属字段的贡献来自卡片包注册表（cards/&lt;type&gt;/meta.ts 的 searchParts）——
 * 对所有包跑一遍而不只按 card.type 分派：类型互转会留下旧类型的残留字段，
 * 那些字段原实现就参与搜索，机械迁移不改这个行为。
 */
import { CARD_METAS, cardMetaOf } from "./card-metas";
import { excalidrawText } from "./excalidraw-text";
import type { BoardCard } from "./types";

export { excalidrawText };

/** 未知类型（本机没有对应卡片包）的专属字段也要搜得到：把标量值原样进 haystack。 */
const COMMON_CARD_KEYS = new Set([
  "id", "type", "createdAt", "updatedAt", "createdBy", "x", "y", "w", "h", "z",
  "color", "title", "content", "agentPrompt", "frameId",
]);

function unknownParts(card: BoardCard): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(card as unknown as Record<string, unknown>)) {
    if (COMMON_CARD_KEYS.has(key)) continue;
    if (typeof value === "string") parts.push(value);
    else if (value && typeof value === "object") {
      for (const item of Object.values(value)) if (typeof item === "string") parts.push(item);
    }
  }
  return parts;
}

/** 一张卡所有人能读到的文本；svg 源码是标签噪音，不参与搜索 */
export function cardSearchParts(card: BoardCard): string[] {
  const parts: (string | null | undefined)[] = [card.title, card.content];
  for (const meta of CARD_METAS) {
    if (meta.searchParts) parts.push(...meta.searchParts(card));
  }
  if (!cardMetaOf(card.type)) parts.push(...unknownParts(card));
  parts.push(card.agentPrompt);
  return parts.filter((part): part is string => Boolean(part));
}

export function cardSearchText(card: BoardCard): string {
  return cardSearchParts(card).join(" ").toLowerCase();
}

/**
 * 命中摘要：优先取「第一个包含关键词的字段」，在命中处前后各截一段；
 * 没截到（比如命中在拼接缝上）就退回标题/正文开头。
 */
export function cardSnippet(card: BoardCard, keyword: string, radius = 24): string {
  const key = keyword.trim().toLowerCase();
  const parts = cardSearchParts(card);
  if (key) {
    for (const part of parts) {
      const at = part.toLowerCase().indexOf(key);
      if (at < 0) continue;
      const from = Math.max(0, at - radius);
      const to = Math.min(part.length, at + key.length + radius);
      const clipped = part.slice(from, to).replace(/\s+/g, " ").trim();
      return `${from > 0 ? "…" : ""}${clipped}${to < part.length ? "…" : ""}`;
    }
  }
  const fallback = (parts[0] || "").replace(/\s+/g, " ").trim();
  return fallback.length > radius * 2 ? `${fallback.slice(0, radius * 2)}…` : fallback;
}
