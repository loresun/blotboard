/**
 * 分层重排（dagre）与子图分簇。
 *
 * 单独成文件是为了让 dagre 能被按需加载：十一种整理模式里只有这两种用得到它，
 * 而日常用的是整齐化。入口见 lib/layout.ts 的 runLayout。
 */
import dagre from "@dagrejs/dagre";
import {
  GAP_X,
  GAP_Y,
  ISLAND_GAP,
  connectedComponents,
  type LayoutDirection,
  type LayoutResult,
} from "./layout";
import type { BoardCard, BoardEdge } from "./types";

/**
 * 连线的「关系强弱」喂给 dagre 的 weight。
 *
 * dagre 的 weight 语义是「这条边被拉直、两端被拉近的力度」，跟 BoardEdge.weight 的
 * 「这个关系有多强」正好同向——所以直接用，不做映射。缺省（null）按 1 算，
 * 也就是老行为一个字不变。
 *
 * **不动 minlen**：minlen 是「两端至少隔几层」，把强关系的 minlen 调大会把它们推得更远，
 * 与语义相反；调小又会把强关系压进同一层、反而看不出方向。
 */
function dagreWeight(edge: BoardEdge): number {
  const weight = Number(edge.weight);
  return Number.isFinite(weight) && weight >= 1 && weight <= 5 ? weight : 1;
}

/**
 * A simple dagre graph stores one edge per ordered endpoint pair. Feeding duplicate
 * board relations directly makes the last relation silently overwrite its weight.
 * Preserve the strongest relation instead: repeated imports must not dilute it.
 * Sorting also keeps rank tie-breaking independent of the board edge array order.
 * This normalizes only the temporary graph; the board and its relation records stay intact.
 */
function graphEdges(cards: BoardCard[], edges: BoardEdge[]): BoardEdge[] {
  const ids = new Set(cards.map((card) => card.id));
  const unique = new Map<string, BoardEdge>();
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    const key = JSON.stringify([edge.from, edge.to]);
    const previous = unique.get(key);
    const weight = dagreWeight(edge);
    if (!previous) unique.set(key, { ...edge, weight });
    else previous.weight = Math.max(previous.weight || 1, weight);
  }
  return [...unique.values()].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );
}

/**
 * 「有连线的卡片」按连线方向分层排布（横向 = 想法在左、任务在右）；
 * 「孤立卡片」不参与分层，另起一片按网格摆在下方——否则 dagre 会把它们堆成一竖列，比不整理还乱。
 */
export function layoutBoard(
  cards: BoardCard[],
  edges: BoardEdge[],
  direction: LayoutDirection = "LR",
): LayoutResult[] {
  if (!cards.length) return [];

  const validEdges = graphEdges(cards, edges);
  const connected = new Set<string>();
  for (const edge of validEdges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: direction,
    nodesep: direction === "LR" ? GAP_Y : GAP_X,
    ranksep: direction === "LR" ? GAP_X + 60 : GAP_Y + 60,
    marginx: 40,
    marginy: 40,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const card of cards) {
    if (!connected.has(card.id)) continue;
    graph.setNode(card.id, { width: card.w, height: card.h });
  }
  // 关系强的线优先被拉直、两端被拉近（见 dagreWeight 抬头）
  for (const edge of validEdges) graph.setEdge(edge.from, edge.to, { weight: dagreWeight(edge) });

  const result: LayoutResult[] = [];
  let maxY = 0;
  let minX = Infinity;

  if (connected.size) {
    dagre.layout(graph);
    for (const card of cards) {
      if (!connected.has(card.id)) continue;
      const node = graph.node(card.id);
      if (!node) continue;
      // dagre 给的是中心点，画板存左上角
      const x = Math.round(node.x - card.w / 2);
      const y = Math.round(node.y - card.h / 2);
      result.push({ id: card.id, x, y });
      maxY = Math.max(maxY, y + card.h);
      minX = Math.min(minX, x);
    }
  }

  // 孤立卡片：按网格铺在已排布内容下方，一行放到 ~1800px 宽为止
  const islands = cards.filter((card) => !connected.has(card.id));
  if (islands.length) {
    const startX = Number.isFinite(minX) ? minX : 40;
    const startY = connected.size ? maxY + ISLAND_GAP : 40;
    let cursorX = startX;
    let cursorY = startY;
    let rowHeight = 0;
    for (const card of islands) {
      if (cursorX > startX && cursorX + card.w > startX + 1800) {
        cursorX = startX;
        cursorY += rowHeight + GAP_Y;
        rowHeight = 0;
      }
      result.push({ id: card.id, x: Math.round(cursorX), y: Math.round(cursorY) });
      cursorX += card.w + GAP_X;
      rowHeight = Math.max(rowHeight, card.h);
    }
  }

  return result;
}

/* ── 子图分簇 ─────────────────────────────────────
   「分层重排」把整块板当**一张图**排：两撮毫无关系的卡片会被塞进同一套层里，
   看上去像有关系，其实没有。分簇反过来先问「这块板到底是几张图」——
   一个连通分量 = 一簇，簇内用 dagre 排出方向，簇与簇之间隔开一大段。

   连通分量的口径与导出分节（lib/export-html.ts 的 sectionize）同源：
   连线不分方向，A→B 与 B→A 算同一片。 */

/** 簇与簇之间的空白：明显大于簇内的 GAP_X / GAP_Y，肉眼才分得出这是两张图 */
const CLUSTER_GAP_X = 260;
const CLUSTER_GAP_Y = 220;
/** 一行铺到这个宽度就换行 */
const CLUSTER_ROW_MAX = 3200;
/** 孤立卡那一簇内部一行摆几张 */
const CLUSTER_ISLAND_COLS = 4;

interface ClusterBlock {
  /** 相对簇左上角（0,0）的位置 */
  places: { id: string; x: number; y: number; w: number; h: number }[];
  w: number;
  h: number;
}

/** 一簇内部用 dagre 排一次，结果平移到以 (0,0) 为左上角。 */
function layoutCluster(members: BoardCard[], edges: BoardEdge[]): ClusterBlock {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: GAP_Y, ranksep: GAP_X + 60, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const card of members) graph.setNode(card.id, { width: card.w, height: card.h });
  for (const edge of edges) graph.setEdge(edge.from, edge.to, { weight: dagreWeight(edge) });
  dagre.layout(graph);

  const places = members.map((card) => {
    const node = graph.node(card.id);
    // dagre 给中心点，画板存左上角
    return {
      id: card.id,
      x: node ? node.x - card.w / 2 : 0,
      y: node ? node.y - card.h / 2 : 0,
      w: card.w,
      h: card.h,
    };
  });
  const minX = Math.min(...places.map((place) => place.x));
  const minY = Math.min(...places.map((place) => place.y));
  for (const place of places) {
    place.x -= minX;
    place.y -= minY;
  }
  return {
    places,
    w: Math.max(...places.map((place) => place.x + place.w)),
    h: Math.max(...places.map((place) => place.y + place.h)),
  };
}

/** 孤立卡（一条线都没连）攒成最后一簇：网格摆开，不各占一簇（否则 40 张孤卡 = 40 簇）。 */
function islandCluster(islands: BoardCard[]): ClusterBlock {
  const cellW = Math.max(...islands.map((card) => card.w)) + GAP_X;
  const cellH = Math.max(...islands.map((card) => card.h)) + GAP_Y;
  const cols = Math.min(CLUSTER_ISLAND_COLS, islands.length);
  const places = islands.map((card, index) => ({
    id: card.id,
    x: (index % cols) * cellW,
    y: Math.floor(index / cols) * cellH,
    w: card.w,
    h: card.h,
  }));
  return {
    places,
    w: Math.max(...places.map((place) => place.x + place.w)),
    h: Math.max(...places.map((place) => place.y + place.h)),
  };
}

export function clusterBoard(cards: BoardCard[], edges: BoardEdge[]): LayoutResult[] {
  if (!cards.length) return [];
  const byId = new Map(cards.map((card) => [card.id, card]));
  const validEdges = graphEdges(cards, edges);

  const groups = connectedComponents(cards, validEdges);
  const blocks: ClusterBlock[] = [];
  const islands: BoardCard[] = [];
  for (const group of groups) {
    if (group.length < 2) {
      islands.push(byId.get(group[0])!);
      continue;
    }
    const memberIds = new Set(group);
    blocks.push(
      layoutCluster(
        group.map((id) => byId.get(id)!),
        validEdges.filter((edge) => memberIds.has(edge.from) && memberIds.has(edge.to)),
      ),
    );
  }
  // 孤立卡永远是最后一簇：它们不是「一张小图」，摆在末尾才不会打断前面的阅读
  if (islands.length) blocks.push(islandCluster(islands));

  const result: LayoutResult[] = [];
  let cursorX = 40;
  let cursorY = 40;
  let rowHeight = 0;
  for (const block of blocks) {
    if (cursorX > 40 && cursorX + block.w > CLUSTER_ROW_MAX) {
      cursorX = 40;
      cursorY += rowHeight + CLUSTER_GAP_Y;
      rowHeight = 0;
    }
    for (const place of block.places) {
      result.push({ id: place.id, x: Math.round(cursorX + place.x), y: Math.round(cursorY + place.y) });
    }
    cursorX += block.w + CLUSTER_GAP_X;
    rowHeight = Math.max(rowHeight, block.h);
  }
  return result;
}
