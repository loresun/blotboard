import { expect, test } from '@playwright/test';
import { GAP_X, GAP_Y, groupBoard, gridBoard, type LayoutResult } from '../lib/layout';
import { layoutBoard, clusterBoard } from '../lib/layout-dagre';
import { SNAP_GRID } from '../lib/constants';
import type { BoardCard, BoardEdge } from '../lib/types';

const card = (id: string, w: number, h: number, type: BoardCard['type'] = 'text'): BoardCard =>
  ({ id, type, x: -153, y: 217, w, h } as BoardCard);
const edge = (from: string, to: string, weight?: number): BoardEdge => ({ id: `${from}-${to}-${weight}`, from, to, weight } as BoardEdge);
const modes = {
  LR: (cards: BoardCard[], edges: BoardEdge[]) => layoutBoard(cards, edges, 'LR'),
  TB: (cards: BoardCard[], edges: BoardEdge[]) => layoutBoard(cards, edges, 'TB'),
  cluster: clusterBoard,
  group: (cards: BoardCard[]) => groupBoard(cards),
  grid: (cards: BoardCard[]) => gridBoard(cards),
};
function validate(cards: BoardCard[], places: LayoutResult[], label = '') {
  expect(places.map((p) => p.id).sort(), label).toEqual(cards.map((c) => c.id).sort());
  expect(new Set(places.map((p) => p.id)).size, label).toBe(cards.length);
  const after = places.map((p) => ({ ...cards.find((c) => c.id === p.id)!, ...p }));
  for (const p of places) expect(Number.isFinite(p.x) && Number.isFinite(p.y), `${label} ${p.id}: finite`).toBe(true);
  for (let i = 0; i < after.length; i++) for (let j = i + 1; j < after.length; j++) {
    const a = after[i], b = after[j];
    const overlap = a.x < b.x + b.w - 1e-7 && a.x + a.w > b.x + 1e-7 && a.y < b.y + b.h - 1e-7 && a.y + a.h > b.y + 1e-7;
    expect(overlap, `${label}: overlap ${a.id}/${b.id}`).toBe(false);
  }
}
function after(cards: BoardCard[], places: LayoutResult[]) {
  return cards.map((c) => ({ ...c, ...places.find((p) => p.id === c.id) }));
}

test('graph and packing layouts handle empty and oversize singleton inputs', () => {
  for (const [mode, layout] of Object.entries(modes)) {
    expect(layout([], [])).toEqual([]);
    const cards = [card('oversize', 9000, 7000)];
    validate(cards, layout(cards, []), mode);
    expect(layout(cards, [])).toEqual(layout(after(cards, layout(cards, [])), []));
  }
});

test('fixed-seed heterogeneous layouts preserve inputs, remain finite, avoid overlap and are idempotent', () => {
  let seed = 0x45a78bc1;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  for (let round = 0; round < 28; round++) {
    const cards = Array.from({ length: 4 + Math.floor(random() * 26) }, (_, i) => card(`r${round}c${i}`, 100 + Math.floor(random() * 2300), 80 + Math.floor(random() * 1500), (['text', 'link', 'quote'] as const)[i % 3]));
    const edges: BoardEdge[] = [];
    for (let i = 0; i < cards.length * 1.3; i++) {
      const from = cards[Math.floor(random() * cards.length)].id;
      const to = cards[Math.floor(random() * cards.length)].id;
      edges.push(edge(from, to, 1 + Math.floor(random() * 5)));
    }
    edges.push(edge('missing', cards[0].id), edge(cards[0].id, 'missing'));
    const before = JSON.stringify({ cards, edges });
    for (const [mode, layout] of Object.entries(modes)) {
      const positions = layout(cards, edges);
      validate(cards, positions, `${mode} seed 0x45a78bc1 round ${round}`);
      expect(layout(after(cards, positions), edges), `${mode} idempotent`).toEqual(positions);
      expect(JSON.stringify({ cards, edges }), `${mode} mutated input`).toBe(before);
    }
  }
});

test('DAG edges advance in their advertised direction and isolated cards follow connected content', () => {
  const cards = [card('a', 3000, 127), card('b', 143, 2100), card('c', 601, 801), card('d', 157, 211), card('island', 1300, 3700)];
  const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];
  for (const dir of ['LR', 'TB'] as const) {
    const positions = layoutBoard(cards, edges, dir);
    validate(cards, positions, dir);
    const positioned = new Map(after(cards, positions).map((c) => [c.id, c]));
    for (const e of edges) {
      const from = positioned.get(e.from)!, to = positioned.get(e.to)!;
      expect(dir === 'LR' ? to.x - from.x - from.w : to.y - from.y - from.h).toBeGreaterThanOrEqual(100);
    }
    expect(positioned.get('island')!.y).toBeGreaterThan(Math.max(...cards.filter((c) => c.id !== 'island').map((c) => positioned.get(c.id)!.y + c.h)));
  }
});

test('clusters keep disconnected graphs in disjoint blocks and collect islands last', () => {
  const cards = [card('a', 3300, 101), card('b', 301, 901), card('c', 703, 1201), card('d', 501, 105), card('island1', 2800, 151), card('island2', 211, 2101)];
  const positions = clusterBoard(cards, [edge('a', 'b'), edge('c', 'd'), edge('d', 'c'), edge('island1', 'island1'), edge('c', 'missing')]);
  validate(cards, positions);
  const positioned = after(cards, positions);
  const blocks = [['a', 'b'], ['c', 'd'], ['island1', 'island2']].map((ids) => {
    const members = positioned.filter((c) => ids.includes(c.id));
    const x = Math.min(...members.map((c) => c.x)), y = Math.min(...members.map((c) => c.y));
    return { x, y, w: Math.max(...members.map((c) => c.x + c.w)) - x, h: Math.max(...members.map((c) => c.y + c.h)) - y };
  });
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
    const a = blocks[i], b = blocks[j];
    expect(a.x + a.w + 200 <= b.x || b.x + b.w + 200 <= a.x || a.y + a.h + 200 <= b.y || b.y + b.h + 200 <= a.y).toBe(true);
  }
});

test('grid uses one uniform grid-aligned cell pitch with odd card sizes', () => {
  const cards = Array.from({ length: 36 }, (_, i) => card(`c${i}`, 151 + i % 3, 101 + i % 2));
  const positions = gridBoard(cards);
  const xs = [...new Set(positions.map((p) => p.x))].sort((a, b) => a - b);
  const ys = [...new Set(positions.map((p) => p.y))].sort((a, b) => a - b);
  for (const values of [xs, ys]) {
    expect(values.length).toBeGreaterThan(2);
    const pitches = values.slice(1).map((v, i) => v - values[i]);
    expect(new Set(pitches).size).toBe(1);
    for (const value of values) expect(value % SNAP_GRID).toBe(0);
  }
});

test('duplicate directed relations use strongest weight independently of insertion order', () => {
  const cards = Array.from({ length: 6 }, (_, i) => card(`c${i}`, 280, 170));
  const edges = [[0, 2], [1, 2], [0, 3], [1, 3], [2, 4], [3, 5], [0, 5]].map(([a, b]) => edge(`c${a}`, `c${b}`));
  const strong = edge('c0', 'c5', 5), weak = edge('c0', 'c5', 1);
  for (const layout of [modes.LR, modes.TB, modes.cluster]) {
    expect(layout(cards, [...edges, strong, weak])).toEqual(layout(cards, [...edges, weak, strong]));
  }
});

test('duplicate relation normalization survives seeded alternative rank constraints', () => {
  let seed = 9128;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  for (let round = 0; round < 70; round++) {
    const cards = Array.from({ length: 8 }, (_, i) => card(`c${i}`, 170 + Math.floor(random() * 400), 100 + Math.floor(random() * 300)));
    const edges: BoardEdge[] = [];
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
      if (random() < 0.35) edges.push(edge(`c${i}`, `c${j}`, 1 + Math.floor(random() * 5)));
    }
    if (!edges.length) continue;
    const duplicate = edges[Math.floor(random() * edges.length)];
    const strong = { ...duplicate, weight: 5 }, weak = { ...duplicate, weight: 1 };
    const baseline = layoutBoard(cards, [...edges, weak, strong], 'LR');
    expect(layoutBoard(cards, [...edges, strong, weak], 'LR'), `duplicate seed 9128 round ${round}`).toEqual(baseline);
  }
});


test('type groups preserve horizontal, wrapped-row and inter-group minimum whitespace after snapping', () => {
  const cards = [card('a', 160, 101), card('b', 160, 101), card('wide', 1750, 101), card('next', 160, 101), card('quote', 160, 101, 'quote')];
  const positioned = new Map(after(cards, groupBoard(cards)).map((c) => [c.id, c]));
  const a = positioned.get('a')!, b = positioned.get('b')!, wide = positioned.get('wide')!, next = positioned.get('next')!, quote = positioned.get('quote')!;
  expect(b.x - a.x - a.w).toBeGreaterThanOrEqual(GAP_X);
  expect(wide.y - Math.max(a.y + a.h, b.y + b.h)).toBeGreaterThanOrEqual(GAP_Y);
  expect(next.y - wide.y - wide.h).toBeGreaterThanOrEqual(GAP_Y);
  const textTop = Math.min(a.y, b.y, wide.y, next.y), textBottom = Math.max(a.y + a.h, b.y + b.h, wide.y + wide.h, next.y + next.h);
  expect(quote.y >= textBottom + 200 || quote.y + quote.h + 200 <= textTop).toBe(true);
});

test('graph layouts ignore self/dangling relations and edge list order without dropping isolated cards', () => {
  const cards = [card('a', 1501, 303), card('b', 701, 909), card('c', 403, 205), card('d', 189, 777), card('island', 4201, 1101)];
  const edges = [edge('a', 'b', 3), edge('a', 'c', 4), edge('c', 'd', 2), edge('b', 'd', 1)];
  const noisy = [...edges.slice().reverse(), edge('a', 'a', 5), edge('island', 'island', 5), edge('missing', 'b'), edge('c', 'missing'), edge('a', 'b', 1)];
  for (const layout of [modes.LR, modes.TB, modes.cluster]) {
    expect(layout(cards, noisy)).toEqual(layout(cards, edges));
    validate(cards, layout(cards, noisy));
  }
});

test('18 mixed cards form a readable landscape grid instead of a fixed-width vertical strip', () => {
  const sizes = [[280,180],[370,200],[220,260],[440,180],[300,250],[550,200],[260,320],[310,190],[700,180],[300,260],[230,170],[410,280],[300,260],[380,180],[320,240],[300,260],[270,210],[460,190]];
  const cards = sizes.map(([w, h], i) => card(`c${i}`, w, h));
  const places = gridBoard(cards);
  validate(cards, places);
  const xs = new Set(places.map((p) => p.x)), ys = new Set(places.map((p) => p.y));
  expect(xs.size).toBeGreaterThanOrEqual(4);
  expect(ys.size).toBeLessThanOrEqual(5);
  const positioned = after(cards, places);
  const width = Math.max(...positioned.map((c) => c.x + c.w)) - Math.min(...places.map((p) => p.x));
  const height = Math.max(...positioned.map((c) => c.y + c.h)) - Math.min(...places.map((p) => p.y));
  expect(width / height).toBeGreaterThan(1);
  expect(width / height).toBeLessThan(2.4);
  expect(gridBoard(positioned)).toEqual(places);
});

test('1000 maximum-size cards stay in a balanced finite canvas region with exact grid pitches', () => {
  const cards = Array.from({ length: 1000 }, (_, i) => card(`c${i}`, 1600 - i % 7, 2400 - i % 11));
  const places = gridBoard(cards);
  expect(places).toHaveLength(cards.length);
  const xs = [...new Set(places.map((p) => p.x))].sort((a,b) => a-b);
  const ys = [...new Set(places.map((p) => p.y))].sort((a,b) => a-b);
  expect(xs.length).toBeGreaterThan(20);
  expect(ys.length).toBeLessThan(40);
  expect(Math.max(...places.map((p) => p.x)) + 1600).toBeLessThan(100000);
  expect(Math.max(...places.map((p) => p.y)) + 2400).toBeLessThan(100000);
  for (const [values, minimum] of [[xs, 1600 + GAP_X], [ys, 2400 + GAP_Y]] as const) {
    const pitches = values.slice(1).map((v, i) => v - values[i]);
    expect(new Set(pitches).size).toBe(1);
    expect(pitches[0]).toBeGreaterThanOrEqual(minimum);
    expect(pitches[0] % SNAP_GRID).toBe(0);
  }
  expect(gridBoard(after(cards, places))).toEqual(places);
});
