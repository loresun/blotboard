import { test, expect } from "@playwright/test";
import { connectedComponents, flowBoard, tidyBoard, type LayoutResult } from "../lib/layout";
import { SNAP_GRID } from "../lib/constants";
import type { BoardCard, BoardEdge } from "../lib/types";

const card = (id: string, x: number, y: number, w = 280, h = 170): BoardCard => ({ id, type: "text", title: id, x, y, w, h } as BoardCard);
const edges = (pairs: string[][]): BoardEdge[] => pairs.map(([from, to], i) => ({ id: `e${i}`, from, to } as BoardEdge));
function apply(cards: BoardCard[], positions: LayoutResult[]) {
  expect(positions).toHaveLength(cards.length);
  expect(new Set(positions.map((p) => p.id))).toEqual(new Set(cards.map((c) => c.id)));
  return cards.map((c) => ({ ...c, ...positions.find((p) => p.id === c.id)! }));
}
function noOverlap(cards: BoardCard[], gap = 0) {
  for (const c of cards) expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true);
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    expect(a.x < b.x + b.w + gap - 1e-6 && a.x + a.w + gap - 1e-6 > b.x && a.y < b.y + b.h + gap - 1e-6 && a.y + a.h + gap - 1e-6 > b.y, `${a.id} overlaps ${b.id}`).toBe(false);
  }
}
function seeded(seed: number) {
  return () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 0x100000000);
}

test.describe("structure layouts", () => {
  test("empty and single-card inputs are total and do not mutate input", () => {
    for (const layout of [tidyBoard, flowBoard]) {
      expect(layout([], [])).toEqual([]);
      const cards = [card("a", 37, -11, 151, 83)];
      const original = structuredClone(cards);
      const once = layout(cards, []);
      expect(cards).toEqual(original);
      expect(layout(apply(cards, once), [])).toEqual(once);
    }
  });

  test("tidy does not turn a long staircase of locally-close centers into one column", () => {
    const cards = Array.from({ length: 10 }, (_, i) => card(`c${i}`, i * 65, i * 500));
    const once = tidyBoard(cards, []);
    expect(new Set(once.map((p) => p.x)).size).toBe(5);
    expect(once[9].x - once[0].x).toBeGreaterThan(450);
    for (let i = 0; i < cards.length; i++) expect(Math.abs(once[i].x - cards[i].x)).toBeLessThanOrEqual(72);
    expect(tidyBoard(apply(cards, once), [])).toEqual(once);
  });

  test("tidy retains distinct established grid-center columns", () => {
    const cards = [card("a", 22 - 75.5, 0, 151, 81), card("b", 44 - 75.5, 400, 151, 81)];
    const after = apply(cards, tidyBoard(cards, []));
    expect(after[0].x).toBe(cards[0].x);
    expect(after[1].x).toBe(cards[1].x);
  });

  test("tidy resolves crossing columns once instead of swapping both sides forever", () => {
    const cards = [card("a", 0, 0), card("b", 0, 500), card("c", 600, 0), card("d", 600, 500)];
    const links = edges([["a", "d"], ["b", "c"]]);
    const once = tidyBoard(cards, links);
    let after = apply(cards, once);
    expect(after.find((c) => c.id === "a")!.y).toBe(after.find((c) => c.id === "d")!.y);
    expect(after.find((c) => c.id === "b")!.y).toBe(after.find((c) => c.id === "c")!.y);
    for (let repeat = 0; repeat < 5; repeat++) {
      expect(tidyBoard(after, links)).toEqual(once);
      after = apply(after, tidyBoard(after, links));
    }
  });

  test("tidy preserves far-apart islands with mixed card dimensions", () => {
    const cards = [card("a", 0, 0, 281, 171), card("b", 10, 400, 261, 149), card("c", 5010, 30, 281, 151), card("d", 5000, 480, 301, 193)];
    const after = apply(cards, tidyBoard(cards, edges([["a", "b"], ["c", "d"]])));
    noOverlap(after, 28);
    expect(after[2].x - after[0].x).toBeGreaterThan(4900);
    expect(after[0].x + after[0].w / 2).toBe(after[1].x + after[1].w / 2);
    expect(after[2].x + after[2].w / 2).toBe(after[3].x + after[3].w / 2);
  });

  for (const linked of [false, true]) test(`tidy dense mixed sizes are separated and repeat-stable; linked=${linked}`, () => {
    const random = seeded(4912);
    for (let round = 0; round < 50; round++) {
      const cards = Array.from({ length: 12 }, (_, i) => card(`c${i}`, Math.floor(random() * 1200), Math.floor(random() * 1000), 140 + Math.floor(random() * 1460), 80 + Math.floor(random() * 2320)));
      const links = linked ? edges(Array.from({ length: 18 }, () => [`c${Math.floor(random() * 12)}`, `c${Math.floor(random() * 12)}`])) : [];
      const once = tidyBoard(cards, links);
      const after = apply(cards, once);
      noOverlap(after, 28);
      expect(tidyBoard(after, links)).toEqual(once);
      for (const c of after) {
        expect(Math.abs((c.x + c.w / 2) / SNAP_GRID - Math.round((c.x + c.w / 2) / SNAP_GRID))).toBeLessThan(1e-8);
        expect(Math.abs((c.y + c.h / 2) / SNAP_GRID - Math.round((c.y + c.h / 2) / SNAP_GRID))).toBeLessThan(1e-8);
      }
    }
  });

  test("flow respects both short and long branches at a shared join", () => {
    const cards = [..."abcdef"].map((id, i) => card(id, i * 57, i * 37, [1600, 151, 809, 280, 1439, 367][i], 81 + i * 411));
    const links = edges([["a", "b"], ["b", "d"], ["a", "c"], ["c", "e"], ["e", "f"], ["f", "d"]]);
    const positions = flowBoard(cards, links);
    const after = apply(cards, positions);
    for (const edge of links) {
      const from = after.find((c) => c.id === edge.from)!, to = after.find((c) => c.id === edge.to)!;
      expect(to.x - from.x - from.w).toBeGreaterThanOrEqual(120);
    }
    noOverlap(after);
    expect(flowBoard(after, links)).toEqual(positions);
  });

  test("flow handles cycles, self-links, duplicate links, and dangling endpoints once each", () => {
    const cards = [..."abcdefg"].map((id, i) => card(id, 0, 0, 140 + i * 137, 80 + i * 247));
    const links = edges([["a", "b"], ["b", "c"], ["c", "a"], ["c", "d"], ["d", "e"], ["f", "g"]]);
    const noisy = [...links, ...edges([["a", "a"], ["a", "b"], ["ghost", "e"], ["g", "missing"]])];
    const positions = flowBoard(cards, links);
    expect(flowBoard(cards, noisy)).toEqual(positions);
    const after = apply(cards, positions);
    noOverlap(after);
    expect(after.find((c) => c.id === "d")!.x).toBeGreaterThan(after.find((c) => c.id === "c")!.x);
    expect(after.find((c) => c.id === "e")!.x).toBeGreaterThan(after.find((c) => c.id === "d")!.x);
    expect(connectedComponents(cards, noisy).map((part) => part.length)).toEqual([5, 2]);
    expect(flowBoard(after, noisy)).toEqual(positions);
  });

  test("flow random DAGs preserve every predecessor constraint and disconnected island spacing", () => {
    const random = seeded(82531);
    for (let round = 0; round < 30; round++) {
      const cards = Array.from({ length: 24 }, (_, i) => card(`c${i}`, Math.floor(random() * 100), Math.floor(random() * 100), 140 + Math.floor(random() * 1460), 80 + Math.floor(random() * 2320)));
      const pairs: string[][] = [];
      for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) if (random() < 0.12) pairs.push([cards[i].id, cards[j].id]);
      const links = edges(pairs), once = flowBoard(cards, links), after = apply(cards, once);
      noOverlap(after);
      for (const edge of links) {
        const from = after.find((c) => c.id === edge.from)!, to = after.find((c) => c.id === edge.to)!;
        expect(to.x).toBeGreaterThanOrEqual(from.x + from.w + 120);
      }
      expect(flowBoard(after, links)).toEqual(once);
    }
  });

  test("flow's graph traversal handles a long cycle without recursive stack overflow", () => {
    const cards = Array.from({ length: 1200 }, (_, i) => card(`c${i}`, 0, 0, 140, 80));
    const links = edges(cards.map((c, i) => [c.id, cards[(i + 1) % cards.length].id]));
    const result = flowBoard(cards, links);
    expect(result).toHaveLength(cards.length);
    expect(new Set(result.map((p) => p.id)).size).toBe(cards.length);
    expect(result.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(result[1199].x).toBeGreaterThan(result[0].x);
  });
});
