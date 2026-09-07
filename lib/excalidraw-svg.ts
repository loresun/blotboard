/**
 * Excalidraw 场景 → SVG，**纯 Node，不碰浏览器**。
 *
 * 为什么要有这条路：卡片里存的是场景 JSON（`excalidraw.source`），缩略图只是「在编辑器里
 * 存过一次」才会有的缓存。agent 批量建的卡从来没进过编辑器，于是一块 76 张手绘卡的板
 * 导出成 HTML 只有一张图——其余全是「还没存过缩略图」。画布上明明都看得见，因为那边是
 * 浏览器现场用官方 exportToBlob 渲的；而服务端没有 DOM，官方那条路走不了。
 *
 * 所以自己画一遍，和 mermaid 同一个套路（见 lib/mermaid-flow.ts）：读场景、吐 SVG。
 * 这里比 mermaid 简单得多——Excalidraw 的元素自带绝对坐标和尺寸，不需要排版。
 *
 * 手绘毛边不是仿的：roughjs 就是 Excalidraw 底下那支笔，同一个 seed、同一套参数，
 * 画出来的抖动就是原图那份。只用它 DOM 无关的 `generator()`（`rough.svg()` 要真 DOM）。
 *
 * 两处刻意的不还原：
 *  · 字体不内嵌。手写体 woff2 一份上百 KB，每份导出都背着它不值——退到系统手写体栈，
 *    字形会变，位置不变（文字的坐标与字号都是场景里算好的）。
 *  · 图片元素（image）画不了：它的字节在 files 里按 fileId 索引，卡片没存那份数据。
 */
import rough from "roughjs";
import type { Options } from "roughjs/bin/core";
import type { RoughGenerator } from "roughjs/bin/generator";

export interface ExcalidrawRender {
  /** 渲染好的 SVG；null = 解析不了或场景是空的 */
  svg: string | null;
  /** 图的自然尺寸（含留白）。排版靠它决定要不要占满一行 */
  width: number;
  height: number;
  /** 没渲染出来时说清楚为什么（直接印进导出里给人看） */
  reason?: string;
}

type Point = [number, number];

/** 场景元素是外来 JSON，字段一律当「可能没有」处理 */
interface Element {
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  roundness?: { type?: number } | null;
  seed?: number;
  points?: Point[];
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  lineHeight?: number;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  isDeleted?: boolean;
}

/** 和客户端 exportToBlob 的 exportPadding 对齐，图不会贴着边框 */
const PADDING = 12;
/** 一张图再大也别把产物撑爆：超过就等比缩到这个长边（viewBox 不动，只改显示尺寸） */
const MAX_SIDE = 1600;

/**
 * 字体栈。Excalidraw 的 fontFamily：1 手写体（Excalifont/Virgil）、2 无衬线、3 等宽，
 * 后面几个是它新版加的。手写体退化到系统里可能有的那几支，最后兜到 cursive。
 */
const FONTS: Record<number, string> = {
  1: "Excalifont,Virgil,'Segoe Print','Bradley Hand','Comic Sans MS',cursive",
  2: "Helvetica,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
  3: "Cascadia,'SF Mono',Consolas,monospace",
  5: "Nunito,Helvetica,sans-serif",
  6: "'Lilita One',Helvetica,sans-serif",
  7: "Cascadia,Consolas,monospace",
  8: "Helvetica,'PingFang SC',sans-serif",
};

function num(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : "0";
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 宽进：既吃完整的 .excalidraw 文件，也吃只有 elements 数组的裸粘贴——
 * 与卡面那条路（lib/excalidraw-scene.ts 的 parseScene）口径一致，
 * 否则会出现「画布上画得出、导出里说解析不了」。
 */
function parseScene(source: string): { elements: Element[]; background: string } | null {
  const raw = source.trim();
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const holder = data as { elements?: unknown; appState?: { viewBackgroundColor?: string } };
  const list = Array.isArray(data) ? data : Array.isArray(holder?.elements) ? holder.elements : null;
  if (!list) return null;
  const elements = (list as Element[]).filter((element) => element && typeof element === "object" && !element.isDeleted);
  return { elements, background: holder?.appState?.viewBackgroundColor || "#ffffff" };
}

/** 元素的四角（转过角度的话就是转完的四角），用来算整张图的包围盒 */
function corners(element: Element): Point[] {
  const x = element.x ?? 0;
  const y = element.y ?? 0;
  const w = element.width ?? 0;
  const h = element.height ?? 0;
  const box: Point[] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const angle = element.angle || 0;
  if (!angle) return box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return box.map(([px, py]) => [cx + (px - cx) * cos - (py - cy) * sin, cy + (px - cx) * sin + (py - cy) * cos]);
}

/** 元素属性 → roughjs 参数。对齐 Excalidraw 自己的 generateRoughOptions */
function roughOptions(element: Element, continuous = false): Options {
  const strokeWidth = element.strokeWidth ?? 1;
  const options: Options = {
    seed: element.seed || 1,
    stroke: element.strokeColor || "#1e1e1e",
    strokeWidth,
    roughness: element.roughness ?? 1,
    // 虚线 / 点线只画一笔：叠第二笔会把虚线糊成实线
    disableMultiStroke: (element.strokeStyle || "solid") !== "solid",
  };
  if (continuous) options.preserveVertices = true;
  if (element.strokeStyle === "dashed") options.strokeLineDash = [8, 8 + strokeWidth];
  if (element.strokeStyle === "dotted") options.strokeLineDash = [1.5, 6 + strokeWidth];
  const background = element.backgroundColor || "transparent";
  if (background !== "transparent") {
    options.fill = background;
    options.fillStyle = element.fillStyle || "hachure";
    options.fillWeight = strokeWidth / 2;
    options.hachureGap = strokeWidth * 4;
  }
  return options;
}

/** 圆角矩形的 path：Excalidraw 的自适应圆角，短边的四分之一，最多 32 */
function roundedRectPath(x: number, y: number, w: number, h: number, radius: number): string {
  const r = Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2);
  return (
    `M ${num(x + r)} ${num(y)} L ${num(x + w - r)} ${num(y)} Q ${num(x + w)} ${num(y)}, ${num(x + w)} ${num(y + r)} ` +
    `L ${num(x + w)} ${num(y + h - r)} Q ${num(x + w)} ${num(y + h)}, ${num(x + w - r)} ${num(y + h)} ` +
    `L ${num(x + r)} ${num(y + h)} Q ${num(x)} ${num(y + h)}, ${num(x)} ${num(y + h - r)} ` +
    `L ${num(x)} ${num(y + r)} Q ${num(x)} ${num(y)}, ${num(x + r)} ${num(y)}`
  );
}

/**
 * roughjs 的 Drawable → 一串 <path>。
 * 自己走一遍 sets 而不是用 generator.toPaths：那个不收小数位，
 * 一张图上千条 bezier，全精度写出来产物能大一倍。
 */
function paths(generator: RoughGenerator, drawable: ReturnType<RoughGenerator["rectangle"]>): string {
  const options = drawable.options;
  // 虚线 / 点线是画笔属性，roughjs 只把它放在 options 里（canvas 那边靠 setLineDash），
  // 出 SVG 得自己写成 stroke-dasharray——漏了这行，画布上的虚线到导出里全成了实线
  const dash = options.strokeLineDash?.length ? ` stroke-dasharray="${options.strokeLineDash.join(" ")}"` : "";
  let out = "";
  for (const set of drawable.sets || []) {
    const d = generator.opsToPath(set, 1);
    if (!d) continue;
    if (set.type === "path") {
      out += `<path d="${d}" stroke="${options.stroke}" stroke-width="${num(options.strokeWidth)}" fill="none"${dash}/>`;
    } else if (set.type === "fillPath") {
      // 闭合曲线 / 多边形 / 自绘 path 用 evenodd，与 roughjs 自己的渲染器一致
      const rule = drawable.shape === "curve" || drawable.shape === "polygon" || drawable.shape === "path" ? ` fill-rule="evenodd"` : "";
      out += `<path d="${d}" stroke="none" stroke-width="0" fill="${options.fill || "none"}"${rule}/>`;
    } else if (set.type === "fillSketch") {
      const weight = options.fillWeight < 0 ? options.strokeWidth / 2 : options.fillWeight;
      const fillDash = options.fillLineDash?.length ? ` stroke-dasharray="${options.fillLineDash.join(" ")}"` : "";
      out += `<path d="${d}" stroke="${options.fill || "none"}" stroke-width="${num(weight)}" fill="none"${fillDash}/>`;
    }
  }
  return out;
}

/**
 * 箭头尖。Excalidraw 的默认样式是实心三角（triangle），老场景里还有两条短线的 arrow，
 * 认不出来的一律退回两条短线——宁可样式不对，也不要一个没有指向的箭头。
 */
function arrowhead(generator: RoughGenerator, element: Element, from: Point, to: Point, kind: string): string {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const distance = Math.hypot(dx, dy);
  if (!distance) return "";
  const angle = Math.atan2(dy, dx);
  const stroke = element.strokeColor || "#1e1e1e";
  const strokeWidth = element.strokeWidth ?? 1;
  const line: Options = { seed: element.seed || 1, stroke, strokeWidth, roughness: element.roughness ?? 1, preserveVertices: true };

  if (kind === "triangle" || kind === "triangle_outline" || kind === "diamond" || kind === "diamond_outline") {
    const length = Math.min(15 + strokeWidth * 2, distance / 2);
    const half = length * 0.45;
    const baseX = to[0] - length * Math.cos(angle);
    const baseY = to[1] - length * Math.sin(angle);
    const wing: Point = [-Math.sin(angle) * half, Math.cos(angle) * half];
    const solid = !kind.endsWith("_outline");
    return paths(
      generator,
      generator.polygon([to, [baseX + wing[0], baseY + wing[1]], [baseX - wing[0], baseY - wing[1]]], {
        ...line,
        ...(solid ? { fill: stroke, fillStyle: "solid" } : {}),
      }),
    );
  }

  if (kind === "dot" || kind === "circle" || kind === "circle_outline") {
    const size = Math.min(10 + strokeWidth * 2, distance / 2);
    return paths(generator, generator.circle(to[0], to[1], size, { ...line, ...(kind === "circle_outline" ? {} : { fill: stroke, fillStyle: "solid" }) }));
  }

  if (kind === "bar") {
    const half = Math.min(9 + strokeWidth, distance / 2);
    const wing: Point = [-Math.sin(angle) * half, Math.cos(angle) * half];
    return paths(generator, generator.linearPath([[to[0] + wing[0], to[1] + wing[1]], [to[0] - wing[0], to[1] - wing[1]]], line));
  }

  // arrow：末段方向上张开两条短线
  const size = Math.min(30, distance / 2);
  const spread = 0.35; // 约 20°
  let out = "";
  for (const side of [-1, 1]) {
    const tip: Point = [to[0] - size * Math.cos(angle + side * spread), to[1] - size * Math.sin(angle + side * spread)];
    out += paths(generator, generator.linearPath([to, tip], line));
  }
  return out;
}

/** 一个元素 → SVG 片段（不含旋转 / 透明度，那两样由外层包） */
function renderElement(generator: RoughGenerator, element: Element): string {
  const x = element.x ?? 0;
  const y = element.y ?? 0;
  const w = element.width ?? 0;
  const h = element.height ?? 0;

  switch (element.type) {
    case "rectangle": {
      const options = roughOptions(element);
      if (element.roundness) {
        const radius = Math.min(Math.min(Math.abs(w), Math.abs(h)) * 0.25, 32);
        return paths(generator, generator.path(roundedRectPath(x, y, w, h, radius), options));
      }
      return paths(generator, generator.rectangle(x, y, w, h, options));
    }

    case "ellipse":
      return paths(generator, generator.ellipse(x + w / 2, y + h / 2, w, h, roughOptions(element)));

    case "diamond":
      return paths(
        generator,
        generator.polygon(
          [
            [x + w / 2, y],
            [x + w, y + h / 2],
            [x + w / 2, y + h],
            [x, y + h / 2],
          ],
          roughOptions(element),
        ),
      );

    case "line":
    case "arrow":
    case "freedraw": {
      const relative = Array.isArray(element.points) && element.points.length > 1 ? element.points : null;
      if (!relative) return "";
      const points: Point[] = relative.map(([px, py]) => [x + (px || 0), y + (py || 0)]);
      const options = roughOptions(element, true);
      // 圆角的折线（roundness）走曲线，直角的走折线——和画布上看到的一致
      const line = element.roundness && points.length > 2 ? generator.curve(points, options) : generator.linearPath(points, options);
      let out = paths(generator, line);
      if (element.type === "arrow") {
        if (element.endArrowhead) {
          out += arrowhead(generator, element, points[points.length - 2], points[points.length - 1], element.endArrowhead);
        }
        if (element.startArrowhead) out += arrowhead(generator, element, points[1], points[0], element.startArrowhead);
      }
      return out;
    }

    case "text": {
      const text = String(element.text ?? "");
      if (!text) return "";
      const fontSize = element.fontSize ?? 20;
      const lineHeight = element.lineHeight ?? 1.25;
      const anchor = element.textAlign === "center" ? "middle" : element.textAlign === "right" ? "end" : "start";
      const anchorX = anchor === "middle" ? x + w / 2 : anchor === "end" ? x + w : x;
      const family = FONTS[element.fontFamily ?? 1] || FONTS[1];
      return text
        .split("\n")
        .map((line, index) => {
          // 每行按行高居中放：比算基线稳，字体换了也不会整体跑偏
          const centerY = y + fontSize * lineHeight * (index + 0.5);
          return (
            `<text x="${num(anchorX)}" y="${num(centerY)}" font-family="${family}" font-size="${num(fontSize)}" ` +
            `fill="${element.strokeColor || "#1e1e1e"}" text-anchor="${anchor}" dominant-baseline="central">${escapeXml(line)}</text>`
          );
        })
        .join("");
    }

    // image：字节在场景的 files 里按 fileId 索引，卡片没存那份数据，画不了
    default:
      return "";
  }
}

/** 旋转与透明度统一在外层包一个 <g>，省得每种元素各写一遍 */
function wrap(element: Element, inner: string): string {
  if (!inner) return "";
  const opacity = (element.opacity ?? 100) / 100;
  const angle = element.angle || 0;
  if (!angle && opacity >= 1) return inner;
  const cx = (element.x ?? 0) + (element.width ?? 0) / 2;
  const cy = (element.y ?? 0) + (element.height ?? 0) / 2;
  const transform = angle ? ` transform="rotate(${num((angle * 180) / Math.PI)} ${num(cx)} ${num(cy)})"` : "";
  const alpha = opacity < 1 ? ` opacity="${num(opacity)}"` : "";
  return `<g${transform}${alpha}>${inner}</g>`;
}

/** 场景 JSON → SVG。渲染不出来就说清楚为什么，由调用方决定怎么兜底。 */
export function renderExcalidrawSvg(source: string, title = ""): ExcalidrawRender {
  const scene = parseScene(source);
  if (!scene) return { svg: null, width: 0, height: 0, reason: "不是合法的 .excalidraw JSON" };
  if (!scene.elements.length) return { svg: null, width: 0, height: 0, reason: "这张画还是空的" };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of scene.elements) {
    for (const [px, py] of corners(element)) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { svg: null, width: 0, height: 0, reason: "这张画的坐标是坏的" };
  }

  const viewX = minX - PADDING;
  const viewY = minY - PADDING;
  const viewWidth = Math.max(1, maxX - minX + PADDING * 2);
  const viewHeight = Math.max(1, maxY - minY + PADDING * 2);
  const shrink = Math.min(1, MAX_SIDE / Math.max(viewWidth, viewHeight));
  const width = Math.round(viewWidth * shrink);
  const height = Math.round(viewHeight * shrink);

  const generator = rough.generator();
  let body = "";
  for (const element of scene.elements) {
    // 场景是外来 JSON，什么畸形值都可能有（NaN 尺寸、点数组里塞 null…）。
    // 一个元素画崩了就跳过它，不能让整份导出跟着 500
    try {
      body += wrap(element, renderElement(generator, element));
    } catch {
      continue;
    }
  }
  if (!body) return { svg: null, width: 0, height: 0, reason: "这张画里没有画得出来的元素" };

  const background =
    scene.background && scene.background !== "transparent"
      ? `<rect x="${num(viewX)}" y="${num(viewY)}" width="${num(viewWidth)}" height="${num(viewHeight)}" fill="${scene.background}"/>`
      : "";

  const label = title ? ` role="img" aria-label="${escapeXml(title)}"` : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${num(viewX)} ${num(viewY)} ${num(viewWidth)} ${num(viewHeight)}"${label}>${background}${body}</svg>`;

  return { svg, width, height };
}
