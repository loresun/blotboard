/**
 * 大纲：把一块二维画板压成**一棵可缩进的树**。
 *
 * 阅读模式（ReaderModal）已经把画板压成一维序列了，靠的是 `readingOrder`——
 * 从上到下、同排从左到右，也就是「作者摆版面时心里的先后」。大纲沿用同一条顺序，
 * 但多做一件事：**把层级显出来**。
 *
 * 层级怎么来的（只有这一条规则，故意做窄）：
 *
 *   一张卡的父 = 它**唯一**的上游，且那张上游在阅读顺序里排在它**前面**。
 *
 * 三个「不」值得写下来：
 * · 不按子画板嵌套推层级——board 卡指向的是另一块板，它的内容根本不在本板上，
 *   拿它当父节点会凭空造出一层空壳；
 * · 上游多于一条就当顶层：两个父亲的节点在大纲里只能挂一处，挑哪一个都是瞎猜，
 *   摊平比猜错好（它在画布上照样连着，信息没丢）；
 * · 要求父在阅读顺序里更靠前，是为了**天然无环**——沿父链往上走一定终止，
 *   而且大纲的行序还能保持「父在子之前」，不用另做一次拓扑排序。
 *
 * 纯计算、无 DOM，前后端都能用（跟 lib/layout.ts 一个待遇）。
 */
import { readingOrder } from "./layout";
import type { BoardCard, BoardEdge } from "./types";

/** 缩进上限：再深就只剩下一条细缝，读起来还不如摊平 */
export const OUTLINE_MAX_DEPTH = 6;

export interface OutlineRow {
  card: BoardCard;
  /** 缩进层级，0 = 顶层 */
  depth: number;
  /** 有几个直接子节点（大纲里显示「+n」，让人知道这行下面还挂着东西） */
  childCount: number;
}

export function outlineRows(cards: BoardCard[], edges: BoardEdge[]): OutlineRow[] {
  if (!cards.length) return [];
  const order = readingOrder(cards);
  const rank = new Map(order.map((card, index) => [card.id, index]));
  const byId = new Map(cards.map((card) => [card.id, card]));

  /** id → 它的上游们（只算两端都在册的连线） */
  const upstream = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue;
    if (!upstream.has(edge.to)) upstream.set(edge.to, []);
    // 同一对卡片可能被连了两次（不同语义），去重后才算得准「上游是不是唯一」
    const list = upstream.get(edge.to)!;
    if (!list.includes(edge.from)) list.push(edge.from);
  }

  const parentOf = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const card of order) {
    // 子画板卡不认父子：它的内容在另一块板上（见抬头）
    const ups = card.type === "board" ? [] : upstream.get(card.id) || [];
    if (ups.length !== 1) continue;
    const parent = ups[0];
    if ((rank.get(parent) ?? Infinity) >= (rank.get(card.id) ?? 0)) continue;
    parentOf.set(card.id, parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(card.id);
  }

  const rows: OutlineRow[] = [];
  const walk = (id: string, depth: number) => {
    const card = byId.get(id);
    if (!card) return;
    const kids = children.get(id) || [];
    rows.push({ card, depth, childCount: kids.length });
    // 撞到缩进上限就摊平（还是照样列出来，只是不再往里缩）
    const nextDepth = Math.min(depth + 1, OUTLINE_MAX_DEPTH);
    for (const kid of kids) walk(kid, nextDepth);
  };
  for (const card of order) {
    if (parentOf.has(card.id)) continue;
    walk(card.id, 0);
  }
  return rows;
}
