"use client";

/**
 * 对齐参考线的画层：拖动时那几条「你现在跟谁齐了」的线。
 *
 * 为什么是**屏幕坐标**的一层 SVG，而不是塞进 `<ViewportPortal>`：
 * 视口那层带着 CSS transform，放进去线宽会跟着缩放一起变——放大到 2x 参考线就有两像素粗，
 * 缩到 0.5x 又细得看不见。参考线是「量具」，它的粗细该跟屏幕走，不跟画布走。
 * 所以这里自己乘一次视口变换，把画布坐标换成屏幕坐标再画。
 */

import { useStore } from "@xyflow/react";

import type { AlignGuide } from "@/lib/align-snap";

/** 等距间隙条两端的小横杠有多长（屏幕像素） */
const TICK = 5;

export default function AlignGuides({ guides }: { guides: AlignGuide[] }) {
  const transform = useStore((state) => state.transform);
  if (!guides.length) return null;

  const [tx, ty, zoom] = transform;
  const at = (x: number, y: number) => ({ x: x * zoom + tx, y: y * zoom + ty });

  return (
    <svg className="align-guides" aria-hidden>
      {guides.map((guide, index) => {
        const a = at(guide.x1, guide.y1);
        const b = at(guide.x2, guide.y2);
        if (guide.kind !== "gap") {
          return (
            <line
              key={index}
              className={`ag-line ag-${guide.kind}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
            />
          );
        }
        // 间隙条：一条横杠加两头的小竖杠，读起来就是「这段和那段一样长」
        const vertical = guide.axis === "y";
        const tick = (point: { x: number; y: number }) =>
          vertical
            ? { x1: point.x - TICK, y1: point.y, x2: point.x + TICK, y2: point.y }
            : { x1: point.x, y1: point.y - TICK, x2: point.x, y2: point.y + TICK };
        return (
          <g key={index} className="ag-gap">
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            <line {...tick(a)} />
            <line {...tick(b)} />
          </g>
        );
      })}
    </svg>
  );
}
