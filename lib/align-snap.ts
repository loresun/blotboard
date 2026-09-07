/**
 * 拖动 / 缩放时的**对齐吸附**：把正在动的卡片吸到*附近卡片*的边线 / 中线 / 等间距上，
 * 并给出该画在哪儿的参考线。
 *
 * 两个入口共用同一套解法：
 *   - `computeAlignSnap`：拖动。整个矩形平移，六条线一起动。
 *   - `computeResizeSnap`：缩放。只有**手上拉的那条边**在动，对面那条边钉死不动。
 *
 * 跟「吸附网格」是两件事，别混：
 *   - 网格吸附（React Flow 自带的 `snapToGrid`）是把绝对坐标**量化**到 22 的倍数上。
 *     它不认识邻居——两张宽度不同的卡并排放，右边缘永远差着 `w % 22` 那点零头对不齐，
 *     因为卡片默认宽度（280 / 320 / 460 …）没有一个是 22 的倍数。
 *   - 对齐吸附认识邻居：它比的是「这条边跟那条边」，所以左右上下六条线、边贴边、
 *     以及「跟前两张保持同样的间隙」都能吸得准，且与卡片尺寸无关。
 *
 * 这里是纯计算（无 React / 无浏览器 API），坐标一律是**画布绝对坐标**；
 * 吸附半径由调用方按当前缩放换算好传进来（屏幕 6px ÷ zoom），
 * 这样放大时不会变得难以摆脱、缩小时也不会吸不到。
 */

import { SNAP_GRID } from "./constants";

export interface SnapRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 框与内边距是参考线，不是参与等距排列的普通卡片。 */
  lineOnly?: boolean;
}

/**
 * 一条要画出来的参考线，端点已经是画布坐标，overlay 直接乘视口变换就能画。
 *   - `kind`：`edge` 边对边 / `center` 中线对中线 / `gap` 等间距的那两段间隙
 *   - `axis`：`x` = 竖线（或横向的间隙条），`y` = 横线（或纵向的间隙条）
 */
export interface AlignGuide {
  kind: "edge" | "center" | "gap";
  axis: "x" | "y";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface AlignSnapResult {
  dx: number;
  dy: number;
  guides: AlignGuide[];
}

/**
 * 吸附半径（**屏幕**像素，调用方除以 zoom 换成画布坐标）。
 *
 * 6 是试出来的：再小要凑很久才吸得上，再大就开始「抢」——想放在旁边一点点的时候
 * 老是被拽回去对齐，那种感觉比不吸附更糟。
 */
export const ALIGN_SNAP_TOLERANCE = 6;

/** 一维投影：主轴看「吸哪条线」，副轴只用来决定参考线画多长 */
interface Span {
  start: number;
  size: number;
}

interface Projected {
  id: string;
  main: Span;
  cross: Span;
  lineOnly?: boolean;
}

const spanX = (rect: SnapRect): Span => ({ start: rect.x, size: rect.w });
const spanY = (rect: SnapRect): Span => ({ start: rect.y, size: rect.h });
const end = (span: Span): number => span.start + span.size;
const mid = (span: Span): number => span.start + span.size / 2;

/** 主轴上的三条线：起边 / 中线 / 止边 */
function linesOf(span: Span): [number, number, number] {
  return [span.start, mid(span), end(span)];
}

/**
 * 一条动线能配上目标的哪几条线：边配边（起-起 / 起-止 / 止-起 / 止-止）、中线只配中线。
 *
 * 少的那四对（起-中、中-起 …）是故意不配的：「我的左边对上你的中线」在画布上
 * 看不出任何秩序，配上去只会让卡片被莫名其妙地拽走一点点。
 * 起-止 与 止-起 留着，因为那是**边贴边**——把两张卡拼成一排时最常用的一种。
 */
const pairsFor = (index: number): number[] => (index === 1 ? [1] : [0, 2]);

/**
 * 参与吸附的「动线」：主轴上哪条线在动，以及它相对于**手上那个把手**动得多快。
 *
 * `gain` 是这么来的：解出来的位移 `delta` 一律指「把手要挪多远」，
 * 而一条线自己挪多远 = `delta × gain`。拖动时整个矩形跟着手走，三条线 gain 都是 1；
 * 拉边时被拉的那条边 gain 是 1，中线只跟着走一半（另一边钉着不动），所以 gain 是 0.5——
 * 要让中线对上目标中线，手上这条边得挪两倍的距离。
 *
 * 容差因此永远量在**把手**上：中线差 3px 才吸得动，正好对应手上 6px 的位移，
 * 不会出现「看着只差一点点，卡片却猛地缩掉十几像素」。
 */
interface MovingLine {
  index: 0 | 1 | 2;
  gain: number;
}

/** 拖动：整个矩形平移 */
const WHOLE_RECT: MovingLine[] = [
  { index: 0, gain: 1 },
  { index: 1, gain: 1 },
  { index: 2, gain: 1 },
];
/** 拉起边（左 / 上）：起边跟手，中线走一半 */
const START_EDGE: MovingLine[] = [
  { index: 0, gain: 1 },
  { index: 1, gain: 0.5 },
];
/** 拉止边（右 / 下）：止边跟手，中线走一半 */
const END_EDGE: MovingLine[] = [
  { index: 2, gain: 1 },
  { index: 1, gain: 0.5 },
];

const EPS = 1e-6;

interface AxisSolution {
  delta: number;
  /** 边线 / 中线吸附：吸中了哪几条线，以及每条线上参照物的副轴范围（决定线画多长） */
  lines: { at: number; kind: "edge" | "center"; cross: Span[] }[];
  /** 等距吸附：应当画出来的那两段等长间隙（主轴上的 [起, 止]） */
  gaps: [number, number][];
}

/** 两个区间是否真的有重叠（碰到边不算）——用来挑出「跟我同一排」的卡片 */
function overlaps(a: Span, b: Span): boolean {
  return a.start < end(b) && end(a) > b.start;
}

/** 边线 / 中线吸附：在容差内挑绝对值最小的位移，同分时边线优先于中线。 */
function solveLines(
  moving: Span,
  targets: Projected[],
  tolerance: number,
  lines: MovingLine[] = WHOLE_RECT,
): AxisSolution | null {
  const movingLines = linesOf(moving);
  const candidates: { delta: number; at: number; kind: "edge" | "center"; cross: Span }[] = [];

  for (const target of targets) {
    const targetLines = linesOf(target.main);
    for (const { index, gain } of lines) {
      for (const ti of pairsFor(index)) {
        // delta 是「把手挪多远」：中线走得慢（gain 0.5），要对上就得让把手多挪一倍
        const delta = (targetLines[ti] - movingLines[index]) / gain;
        if (Math.abs(delta) > tolerance) continue;
        candidates.push({
          delta,
          at: targetLines[ti],
          kind: index === 1 ? "center" : "edge",
          cross: target.cross,
        });
      }
    }
  }
  if (!candidates.length) return null;

  let best = candidates[0];
  for (const candidate of candidates) {
    const closer = Math.abs(candidate.delta) < Math.abs(best.delta) - EPS;
    const tie = Math.abs(Math.abs(candidate.delta) - Math.abs(best.delta)) <= EPS;
    if (closer || (tie && candidate.kind === "edge" && best.kind === "center")) best = candidate;
  }

  // 同一个位移可能同时对上好几条线（比如左边贴着 A、右边又正好齐 B），几条都要画出来
  const winners = candidates.filter((candidate) => Math.abs(candidate.delta - best.delta) <= EPS);
  const byLine = new Map<number, { at: number; kind: "edge" | "center"; cross: Span[] }>();
  for (const winner of winners) {
    const existing = byLine.get(winner.at);
    if (existing) {
      existing.cross.push(winner.cross);
      if (winner.kind === "center") existing.kind = "center";
    } else {
      byLine.set(winner.at, { at: winner.at, kind: winner.kind, cross: [winner.cross] });
    }
  }
  return { delta: best.delta, lines: [...byLine.values()], gaps: [] };
}

/**
 * 等距吸附：跟同一排的卡片保持**一样的间隙**。
 *
 * 两种候选，都只看「跟我在同一排」（副轴有重叠）的卡片：
 *   ① 延续：已经存在一段间隙 g（A｜g｜B），把我放到 B 的右边、同样留 g；左边同理。
 *   ② 插入：A 与 B 之间的空当塞得下我，就摆在正中间，让左右两段间隙相等。
 * 这是「三张卡看起来是一组」的真正来源——只对齐不等距，一排卡还是会显得松紧不一。
 */
function solveGaps(moving: Span, movingCross: Span, targets: Projected[], tolerance: number): AxisSolution | null {
  const mates = targets
    .filter((target) => !target.lineOnly && overlaps(target.cross, movingCross))
    .sort((a, b) => a.main.start - b.main.start);
  if (mates.length < 2) return null;

  const candidates: { delta: number; gaps: [number, number][] }[] = [];
  const consider = (start: number, gaps: [number, number][]) => {
    const delta = start - moving.start;
    if (Math.abs(delta) <= tolerance && !mates.some((mate) => overlaps({ start, size: moving.size }, mate.main))) {
      candidates.push({ delta, gaps });
    }
  };

  for (let i = 0; i + 1 < mates.length; i += 1) {
    const a = mates[i].main;
    const b = mates[i + 1].main;
    if (!overlaps(mates[i].cross, mates[i + 1].cross)) continue;
    const space = b.start - end(a);
    if (space <= 0) continue; // 这两张本来就叠着，谈不上间隙

    // ① 延续同样的间隙（往右接在 B 后面 / 往左接在 A 前面）
    consider(end(b) + space, [
      [end(a), b.start],
      [end(b), end(b) + space],
    ]);
    consider(a.start - space - moving.size, [
      [a.start - space, a.start],
      [end(a), b.start],
    ]);

    // ② 插进 A 与 B 中间，两侧留一样宽
    if (space >= moving.size) {
      const start = end(a) + (space - moving.size) / 2;
      consider(start, [
        [end(a), start],
        [start + moving.size, b.start],
      ]);
    }
  }
  if (!candidates.length) return null;

  let best = candidates[0];
  for (const candidate of candidates) {
    if (Math.abs(candidate.delta) < Math.abs(best.delta) - EPS) best = candidate;
  }
  return { delta: best.delta, lines: [], gaps: best.gaps };
}

/** 一条轴上的最终决定：边线 / 中线优先，同分或更近才让给等距。 */
function solveAxis(moving: Span, movingCross: Span, targets: Projected[], tolerance: number): AxisSolution | null {
  const lines = solveLines(moving, targets, tolerance);
  const gaps = solveGaps(moving, movingCross, targets, tolerance);
  if (!lines) return gaps;
  if (!gaps) return lines;
  return Math.abs(gaps.delta) < Math.abs(lines.delta) - EPS ? gaps : lines;
}

/** 把一条轴的解翻译成可以直接画的线段（副轴范围取「被吸的卡 + 所有参照物」的并集）。 */
function guidesOf(solution: AxisSolution, movingCross: Span, axis: "x" | "y"): AlignGuide[] {
  const guides: AlignGuide[] = [];
  const point = (main: number, cross: number) =>
    axis === "x" ? { x: main, y: cross } : { x: cross, y: main };

  for (const line of solution.lines) {
    const from = Math.min(movingCross.start, ...line.cross.map((span) => span.start));
    const to = Math.max(end(movingCross), ...line.cross.map(end));
    const a = point(line.at, from);
    const b = point(line.at, to);
    guides.push({ kind: line.kind, axis, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  for (const [from, to] of solution.gaps) {
    const at = mid(movingCross);
    const a = point(from, at);
    const b = point(to, at);
    guides.push({ kind: "gap", axis, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return guides;
}

/**
 * 算出这一帧该把拖动中的包围盒挪多少、以及该画哪些参考线。
 *
 * `moving` 是**整体包围盒**：多选拖动时它是这几张卡的并集，于是一次位移整组一起对齐，
 * 不会出现「组里某张自己吸走了、队形散掉」。
 */
export function computeAlignSnap(moving: SnapRect, targets: SnapRect[], tolerance: number): AlignSnapResult {
  if (!targets.length || !(tolerance > 0)) return { dx: 0, dy: 0, guides: [] };

  targets = targets.filter((target) => target.id !== moving.id);
  const alongX = targets.map((rect) => ({ id: rect.id, main: spanX(rect), cross: spanY(rect), lineOnly: rect.lineOnly }));
  const alongY = targets.map((rect) => ({ id: rect.id, main: spanY(rect), cross: spanX(rect), lineOnly: rect.lineOnly }));
  const x = solveAxis(spanX(moving), spanY(moving), alongX, tolerance);
  const y = solveAxis(spanY(moving), spanX(moving), alongY, tolerance);

  const dx = x?.delta ?? 0;
  const dy = y?.delta ?? 0;
  // 参考线画在**吸附之后**的位置上：先定位再画，线才真的穿过卡片的那条边
  const snapped: SnapRect = { ...moving, x: moving.x + dx, y: moving.y + dy };
  return {
    dx,
    dy,
    guides: [
      ...(x ? guidesOf(x, spanY(snapped), "x") : []),
      ...(y ? guidesOf(y, spanX(snapped), "y") : []),
    ],
  };
}

/** 正在被拉的是哪几条边（一个把手最多带一条竖边 + 一条横边）。 */
export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

/** 卡片尺寸的上下限：吸附不能把卡片推出手柄本身允许的范围。 */
export interface ResizeLimits {
  minW?: number;
  maxW?: number;
  minH?: number;
  maxH?: number;
}

export interface ResizeSnapResult {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  guides: AlignGuide[];
}

const NO_RESIZE_SNAP: ResizeSnapResult = { dx: 0, dy: 0, dw: 0, dh: 0, guides: [] };

const withinLimits = (value: number, min?: number, max?: number): boolean =>
  (min == null || value >= min - EPS) && (max == null || value <= max + EPS);

/**
 * 算出这一帧该把**正在缩放**的矩形改多少、以及该画哪些参考线。
 *
 * 与拖动的区别只有一处：动的不是整个矩形，而是手上那条边。所以
 *   - 拉右边：只有止边（和走一半的中线）参与吸附，`dw` 是唯一的产出；
 *   - 拉左边：起边参与吸附，坐标与尺寸要一起改（`dx` 与 `-dx`），右边缘纹丝不动。
 * 等距吸附不参与：它解的是「整块摆在哪」，对「这条边拉到哪」没有意义。
 *
 * 两条轴各解各的，斜角把手于是能一次同时贴上竖线和横线。
 * `limits` 落空的那条轴整轴放弃——宁可不吸，也不能把卡片推过手柄的上下限。
 */
export function computeResizeSnap(
  moving: SnapRect,
  edges: ResizeEdges,
  targets: SnapRect[],
  tolerance: number,
  limits: ResizeLimits = {},
): ResizeSnapResult {
  if (!targets.length || !(tolerance > 0)) return NO_RESIZE_SNAP;
  const linesX = edges.left ? START_EDGE : edges.right ? END_EDGE : null;
  const linesY = edges.top ? START_EDGE : edges.bottom ? END_EDGE : null;
  if (!linesX && !linesY) return NO_RESIZE_SNAP;

  targets = targets.filter((target) => target.id !== moving.id);
  const alongX = targets.map((rect) => ({ id: rect.id, main: spanX(rect), cross: spanY(rect), lineOnly: rect.lineOnly }));
  const alongY = targets.map((rect) => ({ id: rect.id, main: spanY(rect), cross: spanX(rect), lineOnly: rect.lineOnly }));
  let x = linesX ? solveLines(spanX(moving), alongX, tolerance, linesX) : null;
  let y = linesY ? solveLines(spanY(moving), alongY, tolerance, linesY) : null;

  let dx = x && edges.left ? x.delta : 0;
  let dw = x ? (edges.left ? -x.delta : x.delta) : 0;
  let dy = y && edges.top ? y.delta : 0;
  let dh = y ? (edges.top ? -y.delta : y.delta) : 0;
  if (!withinLimits(moving.w + dw, limits.minW, limits.maxW)) {
    x = null;
    dx = 0;
    dw = 0;
  }
  if (!withinLimits(moving.h + dh, limits.minH, limits.maxH)) {
    y = null;
    dy = 0;
    dh = 0;
  }

  // 参考线画在**吸附之后**的矩形上，跟拖动一样：先定位再画线
  const snapped: SnapRect = { ...moving, x: moving.x + dx, y: moving.y + dy, w: moving.w + dw, h: moving.h + dh };
  return {
    dx,
    dy,
    dw,
    dh,
    guides: [
      ...(x ? guidesOf(x, spanY(snapped), "x") : []),
      ...(y ? guidesOf(y, spanX(snapped), "y") : []),
    ],
  };
}

/** 参考线是否有实质变化——拖动每一帧都会重算，没变就别惊动 React。 */
export function sameGuides(a: AlignGuide[], b: AlignGuide[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((guide, index) => {
    const other = b[index];
    return (
      guide.kind === other.kind &&
      guide.axis === other.axis &&
      Math.abs(guide.x1 - other.x1) < 0.5 &&
      Math.abs(guide.y1 - other.y1) < 0.5 &&
      Math.abs(guide.x2 - other.x2) < 0.5 &&
      Math.abs(guide.y2 - other.y2) < 0.5
    );
  });
}

/** 框内留一格边距、两格标题区；只有容得下当前卡片时才提供内部参考线。 */
export function frameSnapTargets(frame: SnapRect, moving: SnapRect, collapsed = false): SnapRect[] {
  const targets = [{ ...frame, lineOnly: true }];
  const inner = {
    id: `${frame.id}:inset`,
    x: frame.x + SNAP_GRID,
    y: frame.y + SNAP_GRID * 2,
    w: frame.w - SNAP_GRID * 2,
    h: frame.h - SNAP_GRID * 3,
    lineOnly: true,
  };
  if (!collapsed && moving.w <= inner.w && moving.h <= inner.h &&
      overlaps(spanX(frame), spanX(moving)) && overlaps(spanY(frame), spanY(moving))) targets.push(inner);
  return targets;
}
