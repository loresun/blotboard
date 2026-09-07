import { expect, test } from "@playwright/test";
import { kanbanBoard, matrixBoard, runLayout, swimlaneBoard, timelineBoard, type LayoutContext, type LayoutResult } from "../lib/layout";
import type { BoardCard, BoardEdge } from "../lib/types";

const c = (id: string, extra: Partial<BoardCard> = {}): BoardCard => ({ id, type: "text", x: 10, y: 20, w: 281, h: 151, createdAt: 0, ...extra } as BoardCard);
const data = (id: string, fields: Record<string, unknown>, specId = "spec") => c(id, { type: "data", data: { specId, fields } as BoardCard["data"] });
const task = (id: string, status: string, priority = "high") => c(id, { type: "task", task: { status, priority } as BoardCard["task"] });
const byId = (layout: LayoutResult[]) => Object.fromEntries(layout.map((p) => [p.id, p]));
const numeric: LayoutContext = { specs: { spec: { fields: [{ key: "x", type: "number" }, { key: "y", type: "number" }] } } };
const enumContext: LayoutContext = { specs: { spec: { fields: [{ key: "status", type: "enum", options: [{ value: "low", label: "high" }, { value: "high", label: "High label" }] }, { key: "importance", type: "enum", options: [{ value: "low" }, { value: "high" }] }] } } };

function checkLayout(cards: BoardCard[], positions: LayoutResult[]) {
  expect(positions.length).toBe(cards.length);
  expect(new Set(positions.map((p) => p.id)).size).toBe(cards.length);
  const placed = cards.map((card) => ({ ...card, ...positions.find((p) => p.id === card.id)! }));
  const collisions: string[] = [];
  for (const a of placed) {
    expect(Number.isFinite(a.x) && Number.isFinite(a.y), a.id).toBe(true);
    for (const b of placed) if (a.id < b.id) {
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlap) collisions.push(`${a.id} overlaps ${b.id}`);
    }
  }
  expect(collisions).toEqual([]);
}

// Numerical tests use isolated Playwright output only; no server or user data is involved.
test("timeline validates date range and rejects non-date coercions before falling back", () => {
  const ctx = { specs: { spec: { fields: [{ key: "date", type: "date" }] } } };
  const today = Date.UTC(2026, 8, 5, 12);
  const cards = [c("reference", { createdAt: today }), ...[Infinity, 9e20, true, "  ", null].map((date, i) => ({ ...data(`bad${i}`, { date }), createdAt: today }))];
  const p = byId(timelineBoard(cards, ctx));
  for (const card of cards) expect(p[card.id].x).toBe(p.reference.x);
  const noDate = byId(timelineBoard([c("dated", { createdAt: today }), data("invalid", { date: 9e20 })], ctx));
  expect(noDate.invalid.x).toBeGreaterThan(noDate.dated.x);
});

test("timeline groups UTC calendar days identically in server and browser time zones", () => {
  const cards = [c("a", { createdAt: Date.parse("2026-09-05T00:30:00Z") }), c("b", { createdAt: Date.parse("2026-09-05T12:30:00Z") }), c("late", { createdAt: Date.parse("2026-09-05T20:30:00Z") }), c("c", { createdAt: Date.parse("2026-09-06T00:30:00Z") })];
  const saved = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const west = timelineBoard(cards);
    process.env.TZ = "Asia/Shanghai";
    const east = timelineBoard(cards);
    expect(west).toEqual(east);
    const p = byId(east);
    expect(p.a.x).toBe(p.b.x);
    expect(p.c.x).toBeGreaterThan(p.b.x);
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test("explicit historical business dates precede later dates instead of becoming undated", () => {
  const ctx = { specs: { spec: { fields: [{ key: "date", type: "date" }] } } };
  const p = byId(timelineBoard([data("epoch", { date: 0 }), data("historical", { date: Date.UTC(1960, 0, 1) }), data("current", { date: Date.UTC(2026, 0, 1) })], ctx));
  expect(p.historical.x).toBeLessThan(p.epoch.x);
  expect(p.epoch.x).toBeLessThan(p.current.x);
});

test("matrix missing and nonnumeric values stay unclassified and do not skew medians", () => {
  const cards = [data("low", { x: 10, y: 10 }), data("high", { x: 20, y: 20 }), ...[null, "", " ", false, true, undefined, [], {}, Infinity].map((x, i) => data(`missing${i}`, { x, y: 10 }))];
  const p = byId(matrixBoard(cards, [], numeric));
  expect(p.low.x).toBeLessThan(p.high.x);
  for (let i = 0; i < 9; i++) expect(p[`missing${i}`].x).toBeGreaterThan(p.high.x);
});

test("matrix medians remain finite for extreme finite numbers and numeric zero is data", () => {
  const cards = [data("low", { x: 1e308, y: 0 }), data("high", { x: 1.6e308, y: 10 })];
  const p = byId(matrixBoard(cards, [], numeric));
  expect(p.low.x).toBeLessThan(p.high.x);
  expect(p.low.y).toBeGreaterThan(p.high.y);
});

test("enum exact values take precedence over another option's display label", () => {
  const cards = [data("low", { status: "low", importance: "high" }), data("high", { status: "high", importance: "high" })];
  for (const layout of [kanbanBoard(cards, enumContext), swimlaneBoard(cards, enumContext), matrixBoard(cards, [], enumContext)]) {
    const p = byId(layout);
    expect(p.low.x).toBeLessThan(p.high.x);
  }
});

test("unknown task state and priority are not invented as known matrix values", () => {
  const cards = [task("known", "running"), task("bad-state", "unexpected"), task("bad-priority", "idea", "unexpected")];
  const p = byId(matrixBoard(cards, []));
  expect(p["bad-state"].x).toBeGreaterThan(p.known.x);
  expect(p["bad-priority"].x).toBeGreaterThan(p.known.x);
  const kb = byId(kanbanBoard([task("known", "running"), task("invalid", "unexpected"), c("ordinary")]));
  expect(kb.invalid.x).toBeGreaterThan(kb.ordinary.x);
});

test("matrix chooses one capable specification even when another unsupported spec has more cards", () => {
  const cards = [data("low", { x: 1, y: 1 }), data("high", { x: 9, y: 9 }), ...[0, 1, 2].map((i) => data(`unsupported${i}`, {}, "unsupported"))];
  const p = byId(matrixBoard(cards, [], numeric));
  expect(p.low.x).toBeLessThan(p.high.x);
  for (let i = 0; i < 3; i++) expect(p[`unsupported${i}`].x).toBeGreaterThan(p.high.x);
});

test("kanban keeps deterministic ordering within a column regardless of input permutation", () => {
  const cards = [task("z", "idea"), task("a", "idea"), task("m", "idea")];
  expect(byId(kanbanBoard(cards))).toEqual(byId(kanbanBoard([...cards].reverse())));
});

test("semantic modes exclude frames and their members from classification and geometry", async () => {
  const free = [c("free-a"), c("free-b")];
  const excluded = [c("frame", { type: "frame", w: 1600, h: 2400 }), { ...task("member", "running"), frameId: "frame" }];
  const edges = [{ id: "e", from: "member", to: "free-a" }] as BoardEdge[];
  for (const mode of ["timeline", "kanban", "matrix", "swimlane"] as const) {
    const actual = await runLayout([...excluded, ...free], edges, mode);
    const expected = await runLayout(free, [], mode);
    expect(actual.map(p => p.id).sort()).toEqual(expected.map(p => p.id).sort());
    // 固定区域避障允许统一平移，但不得改变分类产生的相对位置。
    const dx = actual[0].x - expected[0].x, dy = actual[0].y - expected[0].y;
    expect(actual).toEqual(expected.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })));
  }
});

test("seeded semantic layouts preserve every card, avoid overlap, and are stable and idempotent", async () => {
  let seed = 0x51a7cafe;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let round = 0; round < 36; round++) {
    const cards = Array.from({ length: 5 + Math.floor(random() * 40) }, (_, i) => {
      const base = round % 3 === 0 && i % 4 === 0
        ? task(`c${i}`, ["idea", "issued", "running", "done"][Math.floor(random() * 4)], ["urgent", "high", "low", "none"][Math.floor(random() * 4)])
        : round % 3 !== 2 && i % 3 === 1
          ? data(`c${i}`, { x: Math.floor(random() * 10), y: Math.floor(random() * 10) })
          : c(`c${i}`, { type: i % 2 === 0 ? "todo" : "text" });
      return { ...base, w: 140 + Math.floor(random() * 1461), h: 80 + Math.floor(random() * 2321), x: random() * 1000, y: random() * 1000, createdAt: Date.UTC(2026, 8, 1 + i % 4) };
    });
    const edges = cards.flatMap((card, index) => [
      { id: `e${index}`, from: card.id, to: cards[Math.floor(random() * cards.length)].id },
      { id: `f${index}`, from: card.id, to: index % 5 === 0 ? "missing" : card.id },
    ]) as BoardEdge[];
    const input = JSON.stringify(cards);
    for (const mode of ["timeline", "kanban", "matrix", "swimlane"] as const) {
      const positions = await runLayout(cards, edges, mode, numeric);
      checkLayout(cards, positions);
      expect(byId(await runLayout([...cards].reverse(), [...edges].reverse(), mode, numeric))).toEqual(byId(positions));
      const placed = cards.map((card) => ({ ...card, ...positions.find((p) => p.id === card.id)! }));
      expect(await runLayout(placed, edges, mode, numeric)).toEqual(positions);
      expect(JSON.stringify(cards)).toBe(input);
    }
  }
});

test("odd enum splits, missing values, and empty display labels do not invent classifications", () => {
  const ctx: LayoutContext = { specs: { spec: { fields: [{ key: "status", type: "enum", options: [{ value: "low", label: "" }, { value: "middle" }, { value: "high" }] }, { key: "score", type: "number" }] } } };
  const cards = [data("a", { status: "low", score: 0 }), data("b", { status: "middle", score: 0 }), data("c", { status: "high", score: 0 }), data("missing", { score: 0 })];
  const p = byId(matrixBoard(cards, [], ctx));
  expect(p.a.x).toBeLessThan(p.c.x);
  expect(p.b.x).toBeLessThan(p.c.x);
  expect(p.missing.x).toBeGreaterThan(p.c.x);
  const kb = byId(kanbanBoard(cards, ctx));
  expect(kb.missing.x).toBeGreaterThan(kb.c.x);
});

test("specification ties are deterministic and incomplete dimensions remain explicitly unclassified", () => {
  const ctx: LayoutContext = { specs: { a: numeric.specs!.spec, b: numeric.specs!.spec } };
  const cards = [data("a-low", { x: 1, y: 1 }, "a"), data("a-high", { x: 2, y: 2 }, "a"), data("b-low", { x: 1, y: 1 }, "b"), data("b-high", { x: 2, y: 2 }, "b")];
  const p = byId(matrixBoard(cards, [], ctx));
  expect(p["a-low"].x).toBeLessThan(p["a-high"].x);
  expect(p["b-low"].x).toBeGreaterThan(p["a-high"].x);
  expect(byId(matrixBoard([...cards].reverse(), [], ctx))).toEqual(p);
  const missing = [data("empty1", { x: null, y: null }), data("empty2", {})];
  const loose = byId(matrixBoard(missing, [], numeric));
  expect(loose.empty1.x).toBe(loose.empty2.x);
  expect(loose.empty1.y).not.toBe(loose.empty2.y);
});
