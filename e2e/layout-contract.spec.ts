import { expect, test } from "@playwright/test";
import { runLayout, TIDY_MODES, type LayoutResult } from "../lib/layout";
import type { BoardCard, BoardEdge } from "../lib/types";

const card = (id: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  id, type: "text", title: id, x: 0, y: 0, w: 281, h: 171,
  createdAt: Date.UTC(2026, 8, 1), ...extra,
} as BoardCard);
const links = (pairs: string[][]): BoardEdge[] => pairs.map(([from, to], index) => ({ id: `e${index}`, from, to } as BoardEdge));
const overlap = (a: BoardCard, b: BoardCard) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
function apply(cards: BoardCard[], positions: LayoutResult[]) {
  const changes = new Map(positions.map((p) => [p.id, p]));
  return cards.map((c) => ({ ...c, ...changes.get(c.id) }));
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

for (const mode of TIDY_MODES) test(`layout contract ${mode}: fixed regions, orphan references, complete immutable output and idempotence`, async () => {
  const fixed = [
    card("frame", { type: "frame", x: -200, y: -200, w: 1600, h: 1600, frame: { collapsed: false } }),
    card("child", { frameId: "frame", x: 1600, y: 100, w: 509, h: 391 }),
  ];
  const free = [
    card("a", { x: 10, y: 10, w: 151, h: 83, frameId: "missing-frame" }),
    card("b", { x: 160, y: 260, w: 643, h: 511, frameId: "a" }),
    card("c", { x: 260, y: 380, w: 997, h: 251, createdAt: Date.UTC(2026, 8, 3) }),
    card("d", { x: 420, y: 640, w: 283, h: 173 }),
  ];
  const cards = freeze([...fixed, ...free]);
  // Fixed→free and dangling edges must not invent result nodes or empty ranks.
  const edges = freeze(links([["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"], ["child", "a"], ["missing", "d"]]));
  const beforeCards = structuredClone(cards), beforeEdges = structuredClone(edges);
  const result = await runLayout(cards, edges, mode);
  expect(result).toHaveLength(free.length);
  expect(new Set(result.map((p) => p.id))).toEqual(new Set(free.map((c) => c.id)));
  expect(result.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 100000 && Math.abs(p.y) <= 100000)).toBe(true);
  expect(cards).toEqual(beforeCards);
  expect(edges).toEqual(beforeEdges);
  const after = apply(cards, result);
  for (const original of fixed) expect(after.find((c) => c.id === original.id)).toEqual(original);
  for (const moved of after.filter((c) => free.some((f) => f.id === c.id))) {
    for (const obstacle of fixed) expect(overlap(moved, obstacle), `${mode}: ${moved.id} overlaps fixed ${obstacle.id}`).toBe(false);
  }
  const moved = after.filter((c) => free.some((f) => f.id === c.id));
  for (let i = 0; i < moved.length; i++) for (let j = i + 1; j < moved.length; j++) {
    expect(overlap(moved[i], moved[j]), `${mode}: free cards overlap`).toBe(false);
  }
  expect(await runLayout(after, edges, mode)).toEqual(result);
});

test("all layouts treat an all-fixed or empty board as a no-op", async () => {
  const fixed = freeze([card("f", { type: "frame" }), card("c", { frameId: "f" })]);
  for (const mode of TIDY_MODES) {
    expect(await runLayout([], [], mode)).toEqual([]);
    expect(await runLayout(fixed, [], mode)).toEqual([]);
  }
});

test("flow rejects a chain beyond the persisted coordinate domain instead of clamping and overlapping", async () => {
  const cards = freeze(Array.from({ length: 90 }, (_, i) => card(`c${i}`, { w: 1600 })));
  const edges = freeze(links(cards.slice(1).map((c, i) => [cards[i].id, c.id])));
  const before = structuredClone(cards);
  await expect(runLayout(cards, edges, "flow")).rejects.toThrow(RangeError);
  await expect(runLayout(cards, edges, "flow")).rejects.toThrow(/坐标/);
  expect(cards).toEqual(before);
});

test("fixed-region translation chooses an in-range alternative near the positive coordinate limit", async () => {
  const cards = [
    card("f", { type: "frame", x: 99100, y: 99100, w: 1600, h: 1600 }),
    card("a", { x: 99500, y: 99500, w: 151, h: 83 }),
    card("b", { x: 99700, y: 99700, w: 151, h: 83 }),
  ];
  const result = await runLayout(cards, [], "tidy");
  const after = apply(cards, result);
  expect(result.every((p) => Math.abs(p.x) <= 100000 && Math.abs(p.y) <= 100000)).toBe(true);
  for (const c of after.slice(1)) expect(overlap(c, cards[0])).toBe(false);
  expect(await runLayout(after, [], "tidy")).toEqual(result);
});

test("invalid geometry and unknown layout modes fail atomically", async () => {
  await expect(runLayout([card("a", { w: Number.NaN })], [], "grid")).rejects.toThrow(RangeError);
  await expect(runLayout([card("a"), card("a")], [], "grid")).rejects.toThrow(RangeError);
  await expect(runLayout([card("a")], [], "unknown" as typeof TIDY_MODES[number])).rejects.toThrow(RangeError);
});

test("distant fixed frames do not falsely block a small local avoidance move", async () => {
  const fixed = [
    card("left", { type: "frame", x: -100000, y: 0, w: 1600, h: 1600 }),
    card("right", { type: "frame", x: 99000, y: 0, w: 1600, h: 1600 }),
    card("top", { type: "frame", x: 0, y: -100000, w: 1600, h: 1600 }),
    card("bottom", { type: "frame", x: 0, y: 99000, w: 1600, h: 1600 }),
    card("center", { type: "frame", x: 0, y: 0, w: 400, h: 400 }),
  ];
  const cards = freeze([...fixed, card("a", { x: 50, y: 50, w: 151, h: 83 }), card("b", { x: 300, y: 100, w: 151, h: 83 })]);
  const result = await runLayout(cards, [], "tidy");
  const moved = apply(cards, result).slice(fixed.length);
  for (const c of moved) {
    expect(Math.abs(c.x)).toBeLessThan(2000);
    expect(Math.abs(c.y)).toBeLessThan(2000);
    for (const obstacle of fixed) expect(overlap(c, obstacle)).toBe(false);
  }
  expect(await runLayout(apply(cards, result), [], "tidy")).toEqual(result);
});

test("local avoidance candidates are checked against other initially non-overlapping frames", async () => {
  const fixed = [
    card("center", { type: "frame", x: 0, y: 0, w: 400, h: 400 }),
    card("above", { type: "frame", x: 0, y: -300, w: 400, h: 250 }),
  ];
  const cards = [...fixed, card("a", { x: 50, y: 50, w: 151, h: 83 })];
  const result = await runLayout(cards, [], "grid");
  const moved = apply(cards, result)[2];
  for (const obstacle of fixed) expect(overlap(moved, obstacle)).toBe(false);
  expect(moved.x).toBeLessThan(0);
  expect(await runLayout(apply(cards, result), [], "grid")).toEqual(result);
});
