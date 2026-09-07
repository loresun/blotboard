/**
 * 卡片剪贴板：⌘C 把选中的卡片（连同它们之间的连线）序列化成一段 JSON 文本，
 * ⌘V 在任意画板上把它落下来。
 *
 * 为什么走系统剪贴板而不是只存在内存里：跨窗口、跨机器都能粘——
 * 左边窗口开着 A 板复制，右边窗口开着 B 板粘贴，是这功能最常见的用法。
 * 但 `navigator.clipboard` 只在安全上下文里有（localhost 算，走 Tailscale 的
 * http://100.x.x.x 不算），所以 store 里同时留一份内存副本兜底。
 *
 * 与「卡片信封」（lib/card-ingest）的分工：信封是**交换格式**，给 agent / 别的机器用，
 * 字段是白名单、会按 externalKey 去重；剪贴板要的是**原样复制**，
 * 所以整张卡直接带走（缩略图除外，那是派生数据，几百 KB 塞进剪贴板没意义）。
 */
import type { BoardCard, BoardEdge } from "./types";

export const CARD_CLIPBOARD_FORMAT = "blotboard/cards";
/** 旧格式名：goal-board 时代复制的卡片还能粘（复制侧永远写新名） */
const LEGACY_CLIPBOARD_FORMATS = ["goal-board/cards"];
export const CARD_CLIPBOARD_VERSION = 1;

export interface CardClipboard {
  format: string;
  version: number;
  from?: { boardId: string; name: string };
  cards: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}

/** 选中的卡片 + 两端都在选中范围内的连线 */
export function buildCardClipboard(
  cards: BoardCard[],
  edges: BoardEdge[],
  from?: { boardId: string; name: string },
): CardClipboard {
  const ids = new Set(cards.map((card) => card.id));
  return {
    format: CARD_CLIPBOARD_FORMAT,
    version: CARD_CLIPBOARD_VERSION,
    ...(from ? { from } : {}),
    cards: cards.map((card) => {
      const copy: Record<string, unknown> = { ...card };
      if (card.excalidraw) {
        // 缩略图是派生数据（几百 KB 的 base64），场景 JSON 才是真身
        copy.excalidraw = { source: card.excalidraw.source };
      }
      return copy;
    }),
    edges: edges
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label,
        kind: edge.kind,
        color: edge.color,
        style: edge.style,
        width: edge.width,
      })),
  };
}

/** 剪贴板文本 → 卡片；不是我们这份格式就返回 null（别人复制的普通文字照旧走原来的路） */
export function parseCardClipboard(text: string): CardClipboard | null {
  const raw = text.trim();
  // 先按开头挡一道：整块板的 JSON 也可能几百 KB，不该每次粘贴都 parse 一遍
  const accepted = [CARD_CLIPBOARD_FORMAT, ...LEGACY_CLIPBOARD_FORMATS];
  if (!raw.startsWith("{") || !accepted.some((format) => raw.includes(format))) return null;
  try {
    const data = JSON.parse(raw);
    if (!accepted.includes(data?.format)) return null;
    if (!Array.isArray(data.cards) || !data.cards.length) return null;
    return {
      format: CARD_CLIPBOARD_FORMAT,
      version: Number(data.version) || CARD_CLIPBOARD_VERSION,
      from: data.from && typeof data.from === "object" ? data.from : undefined,
      cards: data.cards.filter((card: unknown) => card && typeof card === "object"),
      edges: Array.isArray(data.edges) ? data.edges.filter((edge: unknown) => edge && typeof edge === "object") : [],
    };
  } catch {
    return null;
  }
}

/** 这批卡片占的画布范围——粘贴时用它把整批摆到鼠标位置的中心 */
export function cardClipboardBounds(data: CardClipboard): { width: number; height: number } {
  const xs = data.cards.map((card) => Number(card.x) || 0);
  const ys = data.cards.map((card) => Number(card.y) || 0);
  const rights = data.cards.map((card) => (Number(card.x) || 0) + (Number(card.w) || 0));
  const bottoms = data.cards.map((card) => (Number(card.y) || 0) + (Number(card.h) || 0));
  return {
    width: Math.max(0, Math.max(...rights) - Math.min(...xs)),
    height: Math.max(0, Math.max(...bottoms) - Math.min(...ys)),
  };
}
