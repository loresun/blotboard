"use client";

/**
 * 浮动连线：连线端点不钉死在某个 handle 上，而是按两张卡片的相对位置动态选边
 * （右↔左 / 上↔下），与 goal-agent 版画板的 pickSides + bezierBetween 完全同一套几何。
 */
import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type EdgeProps } from "@xyflow/react";
import { EDGE_COLORS, EDGE_KIND_META, EDGE_STYLE_META, EDGE_WIDTHS } from "@/lib/constants";
import type { CardColor, EdgeKind, EdgeStyle } from "@/lib/types";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Side = "top" | "bottom" | "left" | "right";

const NORMAL: Record<Side, [number, number]> = {
  top: [0, -1],
  bottom: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

function anchorPoint(box: Box, side: Side) {
  switch (side) {
    case "top":
      return { x: box.x + box.w / 2, y: box.y };
    case "bottom":
      return { x: box.x + box.w / 2, y: box.y + box.h };
    case "left":
      return { x: box.x, y: box.y + box.h / 2 };
    default:
      return { x: box.x + box.w, y: box.y + box.h / 2 };
  }
}

function pickSides(from: Box, to: Box): [Side, Side] {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ["right", "left"] : ["left", "right"];
  return dy > 0 ? ["bottom", "top"] : ["top", "bottom"];
}

/** 三次贝塞尔上 t 处的点 */
function cubicAt(p1: Point, c1: Point, c2: Point, p2: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
    y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
  };
}

/** 同一处的切线方向（导数），用来把标签推到线**旁边**而不是压在线上 */
function cubicTangent(p1: Point, c1: Point, c2: Point, p2: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: 3 * u * u * (c1.x - p1.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (p2.x - c2.x),
    y: 3 * u * u * (c1.y - p1.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (p2.y - c2.y),
  };
}

interface Point {
  x: number;
  y: number;
}

/** 标签离曲线多远（画布单位）。够躲开线本身，又不至于飘到看不出属于哪条线 */
const LABEL_GAP = 11;
/** 同一对卡片之间多条线时，相邻两条的标签**往上叠**多少（画布单位，约一行的高度） */
export const LABEL_LANE = 22;

/**
 * @param labelT 标签取在曲线的哪一处（0-1，默认中点）。
 * @param labelLane 同一对卡片的第几条线：往上叠这么多（画布单位，0 = 不叠）。
 *
 * 为什么叠的方向是**竖直向上**，而不是「垂直于线」：标签有多宽取决于写了几个字，
 * 谁也不知道；但它只有一行高，是个**已知量**。往上叠一行，两条线的标签必然分得开；
 * 往侧面推的话，两条竖线之间推开四十像素，遇到一条十来个字的标签照样压在一起
 *（第一版就是这么写的，实测两个标签仍然叠着）。
 * 无论怎么叠，**只挪标签，线的走向一点没动**（槽位由 components/BoardCanvas.tsx 一次 O(E) 算好）。
 */
export function floatingPath(from: Box, to: Box, labelT = 0.5, labelLane = 0) {
  const [fromSide, toSide] = pickSides(from, to);
  const p1 = anchorPoint(from, fromSide);
  const p2 = anchorPoint(to, toSide);
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const offset = Math.min(140, Math.max(36, dist * 0.38));
  const c1 = { x: p1.x + NORMAL[fromSide][0] * offset, y: p1.y + NORMAL[fromSide][1] * offset };
  const c2 = { x: p2.x + NORMAL[toSide][0] * offset, y: p2.y + NORMAL[toSide][1] * offset };
  const t = Math.min(0.86, Math.max(0.14, labelT));
  const at = cubicAt(p1, c1, c2, p2, t);
  const tangent = cubicTangent(p1, c1, c2, p2, t);
  const length = Math.hypot(tangent.x, tangent.y) || 1;
  /**
   * 法线方向永远取「朝上那一侧」（ny ≤ 0）：标签的排版原点在它自己的下沿，
   * 往上推才是离开线；随切线方向翻来翻去的话，同一条线拖动时标签会突然跳到另一边。
   */
  const nx = -tangent.y / length;
  const ny = tangent.x / length;
  const flip = ny > 0 ? -1 : 1;
  return {
    d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`,
    mid: { x: at.x + nx * flip * LABEL_GAP, y: at.y + ny * flip * LABEL_GAP - labelLane },
    endAngle: Math.atan2(p2.y - c2.y, p2.x - c2.x),
    end: p2,
  };
}

function arrowPath(end: { x: number; y: number }, angle: number, size = 7) {
  const ax = end.x - Math.cos(angle) * 2;
  const ay = end.y - Math.sin(angle) * 2;
  const left = {
    x: ax - Math.cos(angle - 0.42) * size - Math.sin(angle) * size * 0.6,
    y: ay - Math.sin(angle - 0.42) * size + Math.cos(angle) * size * 0.6,
  };
  const right = {
    x: ax - Math.cos(angle + 0.42) * size + Math.sin(angle) * size * 0.6,
    y: ay - Math.sin(angle + 0.42) * size - Math.cos(angle) * size * 0.6,
  };
  return `M ${ax} ${ay} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`;
}

function boxOf(node: ReturnType<typeof useInternalNode>): Box | null {
  if (!node) return null;
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    w: node.measured?.width ?? (node.width as number) ?? 280,
    h: node.measured?.height ?? (node.height as number) ?? 170,
  };
}

function FloatingEdgeInner({ id, source, target, label, selected, markerEnd, data }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const from = boxOf(sourceNode);
  const to = boxOf(targetNode);
  if (!from || !to) return null;

  const look = (data || {}) as {
    kind?: EdgeKind;
    color?: CardColor | null;
    style?: EdgeStyle | null;
    width?: number | null;
    dimmed?: boolean;
    labelSlot?: number;
    labelSlots?: number;
  };
  /**
   * 同一对卡片之间有好几条线时，把标签**沿曲线 + 垂直于曲线**同时错开（一条线就还是正中点、不错位）。
   * 这是**可读性**的改善，不是真正的避障：它不知道第三张卡在哪儿，也不认识
   * 别的连线的标签。真要做避障得先有折线路由（见文件尾的后续方案）。
   */
  const slots = Math.max(1, look.labelSlots || 1);
  const slot = Math.min(slots - 1, Math.max(0, look.labelSlot || 0));
  const labelT = slots === 1 ? 0.5 : 0.5 + (slot - (slots - 1) / 2) * (0.52 / slots);
  /**
   * 叠的次序是「原地 → 下一行 → 上一行 → 下两行 → 上两行」，围着线中段展开。
   * 一路往同一个方向叠的话，两张挨得很近的卡之间只有一百来像素的空当，
   * 第二条的标签就被顶到上面那张卡的底下去了（实测如此）。
   */
  const lane = slot === 0 ? 0 : Math.ceil(slot / 2) * LABEL_LANE * (slot % 2 === 1 ? -1 : 1);
  const geo = floatingPath(from, to, labelT, lane);
  const kind = (look.kind || "rel") as EdgeKind;
  const meta = EDGE_KIND_META[kind] || EDGE_KIND_META.rel;
  // 外观优先级：连线自己设的 > 语义默认
  const baseColor = (look.color && EDGE_COLORS[look.color]) || meta.color;
  const stroke = selected ? "var(--accent)" : baseColor;
  const dash = look.style ? EDGE_STYLE_META[look.style]?.dash : meta.dashed ? "6 5" : undefined;
  const strokeWidth = EDGE_WIDTHS[(look.width || 2) - 1] ?? EDGE_WIDTHS[1];
  const dimmed = look.dimmed === true;

  return (
    <g className={dimmed ? "edge-dimmed" : undefined}>
      <BaseEdge
        id={id}
        path={geo.d}
        markerEnd={markerEnd}
        // 线只有 1.7px，点中太难；给一条 26px 的透明命中带（右键改语义全靠它）
        interactionWidth={26}
        style={{ stroke, strokeWidth, strokeDasharray: dash }}
      />
      <path className="react-flow__edge-arrow" d={arrowPath(geo.end, geo.endAngle, 6 + strokeWidth)} fill={stroke} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -100%) translate(${geo.mid.x}px, ${geo.mid.y}px)` }}
            className={`edge-label-text nodrag nopan${selected ? " on" : ""}`}
            title={typeof label === "string" ? label : undefined}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}

export const FloatingEdge = memo(FloatingEdgeInner);

/**
 * 后续：**真正的避障**要什么。
 *
 * 现在这条线只看起终两张卡：它不知道中间还压着第三张卡，也不知道别的标签在哪儿。
 * 一次性做完的话要三样东西，且都得先有：
 * ① 折线（正交）路由 —— 曲线绕不开障碍，只有折线能沿着空隙走；
 * ② 一张画布的占位图（卡片 + 已放好的标签）—— 路由与标签都要问它「这儿有人吗」；
 * ③ 标签沿路径找空位的摆放（找不到就贴着线端、或只在选中时显示）。
 *
 * 三样一起上等于换掉整套连线渲染，而画板上现有连线的走向会全部改变——
 * 那是一次独立的改动，不该混在「让标签看得清」里。所以这一轮只做了：
 * 标签离开线身（法线方向推开）、同一对卡片之间的多条线把标签沿曲线错开并往上叠、
 * 以及长标签截断 + 选中时完整显示（样式在 app/globals.css 的 .edge-label-text）。
 */
