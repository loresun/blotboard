/**
 * Mermaid 流程图 → SVG，**纯 Node，不碰浏览器**。
 *
 * 为什么要自己画：服务端导出的产物必须是「单文件、离线可开」。真 mermaid 那条路两头都堵——
 * 把 mermaid 打进产物要 8MB（dist/mermaid.js，没有 min 版；esm 那份 30KB 但会按图表类型
 * 现拉 chunks，离线就断了）；在服务端跑 mermaid 又要一整个 DOM，而它排版靠 `getBBox`
 * 量文字，jsdom 给的是 0，出来的图会叠成一团。
 *
 * 所以这里只做一件事：把**流程图**（graph / flowchart，占画板上图表的绝大多数）解析成
 * 点和边，用 dagre 排版（项目里本来就有，纯 JS），自己吐 SVG。文字宽度按字符估
 * （CJK 一个全角、ASCII 约 0.56 em）——估得准不准只影响留白，不会让图叠在一起。
 *
 * 不是流程图（时序图 / 甘特 / 饼图…）就明说渲染不了，由调用方退回源码块。
 * 装作能画然后画错，比老老实实给源码更糟。
 */
import dagre from "@dagrejs/dagre";

export interface MermaidRender {
  /** 渲染好的 SVG；null = 这段源码不是流程图，或没解析出任何节点 */
  svg: string | null;
  /** 没渲染成功时说清楚为什么（直接印进导出里给人看） */
  reason?: string;
  /** 图表种类（sequenceDiagram / gantt…），认得出来就带上 */
  kind?: string;
}

type Dir = "TB" | "BT" | "LR" | "RL";

type Shape =
  | "rect"
  | "round"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "circle"
  | "diamond"
  | "hexagon"
  | "lean-r"
  | "lean-l"
  | "flag";

interface FlowNode {
  id: string;
  lines: string[];
  shape: Shape;
  parent?: string;
}

interface FlowEdge {
  from: string;
  to: string;
  label: string;
  /** 线型：实线 / 点线 / 粗线 */
  stroke: "solid" | "dotted" | "thick";
  /** 终点有没有箭头（`---` 这种没有） */
  arrow: boolean;
}

interface Cluster {
  id: string;
  title: string;
}

/* ── 1. 词法：节点写法 ─────────────────────────────
   开括号按「长的排前面」试，否则 `[[` 会先被 `[` 吃掉。 */
const SHAPES: [open: string, close: string, shape: Shape][] = [
  ["([", "])", "stadium"],
  ["[[", "]]", "subroutine"],
  ["[(", ")]", "cylinder"],
  ["((", "))", "circle"],
  ["{{", "}}", "hexagon"],
  ["[/", "/]", "lean-r"],
  ["[\\", "\\]", "lean-l"],
  ["[", "]", "rect"],
  ["(", ")", "round"],
  ["{", "}", "diamond"],
  [">", "]", "flag"],
];

/**
 * 节点 id。`-` 与 `.` 只在**后面还接着字**时才算 id 的一部分——
 * 否则 `A-->B` 这种不带空格的写法会被读成 id `A--`，整条边就没了。
 */
const ID_RE = /^[A-Za-z0-9_一-龥]+(?:[-.][A-Za-z0-9_一-龥]+)*/;

/** 连线算子：`-->` `---` `-.->` `==>` `--o` `--x`，允许拉长（`---->`） */
const OP_RE = /^\s*(-\.{1,3}-|={2,}|-{2,})([->ox])?/;

/** 一条语句里紧跟算子的 `|标签|` */
const PIPE_LABEL_RE = /^\s*\|([^|]*)\|/;

/** 图表首行：认出是不是流程图，认不出也报出它是什么 */
const HEADER_RE = /^\s*(graph|flowchart)\s+(TB|TD|BT|LR|RL)?/i;

const KNOWN_KINDS = [
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram-v2",
  "stateDiagram",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "quadrantChart",
  "requirementDiagram",
  "gitGraph",
  "mindmap",
  "timeline",
  "sankey-beta",
  "xychart-beta",
  "block-beta",
  "packet-beta",
  "architecture-beta",
  "C4Context",
];

/** 跳过的装饰性语句：只管样式与交互，不影响图的结构 */
const SKIP_RE = /^\s*(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/i;

function stripComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      // %%{init: …}%% 指令整行丢掉；其余 %% 之后是注释
      if (/^\s*%%\{[\s\S]*\}%%\s*$/.test(line)) return "";
      const at = line.indexOf("%%");
      return at >= 0 ? line.slice(0, at) : line;
    })
    .join("\n");
}

/**
 * 把「行内标签」改写成管道写法，后面就只剩一种形态要认：
 *   `A -- 说明 --> B` → `A -->|说明| B`
 *   `A -. 说明 .-> B` → `A -.->|说明| B`
 *   `A == 说明 ==> B` → `A ==>|说明| B`
 */
function normalizeInlineLabels(text: string): string {
  return text
    .replace(/(\s)--\s+([^\n|]*?[^\s\-|])\s+(-{2,}[>ox]?)(\s|$)/g, "$1$3|$2|$4")
    .replace(/(\s)-\.\s+([^\n|]*?[^\s.|])\s+\.-(>?)(\s|$)/g, "$1-.-$3|$2|$4")
    .replace(/(\s)==\s+([^\n|]*?[^\s=|])\s+(={2,}>?)(\s|$)/g, "$1$3|$2|$4");
}

/** 标签里的 `<br>` 换行、引号、实体，摊成一组纯文本行 */
function labelLines(raw: string): string[] {
  const text = raw
    .trim()
    .replace(/^"([\s\S]*)"$/, "$1")
    .replace(/^'([\s\S]*)'$/, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/#quot;/g, '"');
  const lines = text
    .split(/<br\s*\/?>|\\n/i)
    // 标签里可能还夹着 <b> <i> 之类，剥掉标签只留字
    .map((line) => line.replace(/<[^>]*>/g, "").trim())
    .filter((line, index, all) => line || all.length === 1);
  return lines.length ? lines : [""];
}

interface ParsedNode {
  id: string;
  lines: string[] | null;
  shape: Shape | null;
  next: number;
}

function readNode(text: string, at: number): ParsedNode | null {
  let cursor = at;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  const rest = text.slice(cursor);
  const idMatch = ID_RE.exec(rest);
  if (!idMatch) return null;
  const id = idMatch[0];
  let after = cursor + id.length;
  for (const [open, close, shape] of SHAPES) {
    if (!text.startsWith(open, after)) continue;
    const end = text.indexOf(close, after + open.length);
    if (end < 0) continue;
    return { id, lines: labelLines(text.slice(after + open.length, end)), shape, next: end + close.length };
  }
  // 光一个 id：节点可能在别处定义过形状，这里只是引用
  return { id, lines: null, shape: null, next: after };
}

interface ParsedOp {
  stroke: FlowEdge["stroke"];
  arrow: boolean;
  label: string;
  next: number;
}

function readOp(text: string, at: number): ParsedOp | null {
  const match = OP_RE.exec(text.slice(at));
  if (!match) return null;
  const [whole, dashes, marker] = match;
  const stroke: FlowEdge["stroke"] = dashes.startsWith("=") ? "thick" : dashes.includes(".") ? "dotted" : "solid";
  let next = at + whole.length;
  let label = "";
  const pipe = PIPE_LABEL_RE.exec(text.slice(next));
  if (pipe) {
    label = labelLines(pipe[1]).join(" ");
    next += pipe[0].length;
  }
  return { stroke, arrow: Boolean(marker && marker !== "-"), label, next };
}

/* ── 2. 解析 ───────────────────────────────────── */

interface ParsedFlow {
  dir: Dir;
  nodes: Map<string, FlowNode>;
  edges: FlowEdge[];
  clusters: Map<string, Cluster>;
}

function parseFlow(source: string): ParsedFlow | { error: string; kind?: string } {
  const clean = stripComments(source);
  const lines = clean.split("\n");
  const firstAt = lines.findIndex((line) => line.trim());
  if (firstAt < 0) return { error: "图表是空的" };

  const header = HEADER_RE.exec(lines[firstAt]);
  if (!header) {
    const head = lines[firstAt].trim();
    const kind = KNOWN_KINDS.find((name) => head.toLowerCase().startsWith(name.toLowerCase()));
    return { error: "不是流程图", kind: kind || head.split(/\s+/)[0] };
  }
  const raw = (header[2] || "TB").toUpperCase();
  const dir: Dir = raw === "TD" ? "TB" : (raw as Dir);

  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const clusters = new Map<string, Cluster>();
  const stack: string[] = [];
  let anonymous = 0;

  const touch = (id: string, lines: string[] | null, shape: Shape | null): void => {
    const existing = nodes.get(id);
    if (existing) {
      if (lines) existing.lines = lines;
      if (shape) existing.shape = shape;
      return;
    }
    nodes.set(id, {
      id,
      lines: lines || [id],
      shape: shape || "rect",
      parent: stack.length ? stack[stack.length - 1] : undefined,
    });
  };

  // 首行的 `graph TB` 之后还可能直接跟语句，所以从 header 结束处继续
  const body = [lines[firstAt].slice(header[0].length), ...lines.slice(firstAt + 1)].join("\n");

  for (const rawStatement of normalizeInlineLabels(body).split(/[\n;]/)) {
    const statement = rawStatement.trim();
    if (!statement) continue;
    if (SKIP_RE.test(statement)) continue;

    if (/^end\b/i.test(statement)) {
      stack.pop();
      continue;
    }
    const sub = /^subgraph\s+(.*)$/i.exec(statement);
    if (sub) {
      const spec = sub[1].trim();
      // `subgraph id[标题]` / `subgraph 标题` 两种写法
      const withTitle = /^([A-Za-z0-9_一-龥.\-]+)\s*[[（(]([\s\S]*)[\])）]$/.exec(spec);
      anonymous += 1;
      const id = withTitle ? withTitle[1] : `__sub${anonymous}`;
      const title = labelLines(withTitle ? withTitle[2] : spec).join(" ");
      clusters.set(id, { id, title });
      stack.push(id);
      continue;
    }

    let cursor = 0;
    let guard = 0;
    while (cursor < statement.length && guard < 64) {
      guard += 1;
      const node = readNode(statement, cursor);
      if (!node) break;
      touch(node.id, node.lines, node.shape);
      const op = readOp(statement, node.next);
      if (!op) break;
      const target = readNode(statement, op.next);
      if (!target) break;
      touch(target.id, target.lines, target.shape);
      edges.push({ from: node.id, to: target.id, label: op.label, stroke: op.stroke, arrow: op.arrow });
      // 链式写法 `A --> B --> C`：下一轮从 B 接着读（touch 幂等，重复读一次没关系）
      cursor = op.next;
    }
  }

  if (!nodes.size) return { error: "没解析出任何节点" };
  return { dir, nodes, edges, clusters };
}

/* ── 3. 排版 + 出 SVG ──────────────────────────── */

const FONT = 13;
const LINE_H = 18;
const PAD_X = 12;
const PAD_Y = 9;
const MIN_W = 44;

/** 字符宽度估算：全角一个字宽，其余按 0.56 em。只影响留白，不影响不重叠 */
function textWidth(text: string, size = FONT): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    width += code > 0x2e80 ? size : size * 0.56;
  }
  return width;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function nodeSize(node: FlowNode): { w: number; h: number } {
  const textW = Math.max(...node.lines.map((line) => textWidth(line)), 0);
  const textH = node.lines.length * LINE_H;
  let w = Math.max(MIN_W, textW + PAD_X * 2);
  let h = textH + PAD_Y * 2;
  if (node.shape === "circle") {
    const side = Math.max(w, h) * 1.06;
    return { w: side, h: side };
  }
  if (node.shape === "diamond") return { w: w * 1.4, h: h * 1.7 };
  if (node.shape === "hexagon") return { w: w + 26, h };
  if (node.shape === "stadium") return { w: w + 14, h };
  if (node.shape === "cylinder") return { w, h: h + 14 };
  if (node.shape === "lean-r" || node.shape === "lean-l") return { w: w + 22, h };
  if (node.shape === "flag") return { w: w + 12, h };
  return { w, h };
}

/** 形状的 SVG。x/y 是左上角 */
function shapeSvg(node: FlowNode, x: number, y: number, w: number, h: number): string {
  const cls = 'class="mf-node"';
  switch (node.shape) {
    case "round":
      return `<rect ${cls} x="${x}" y="${y}" width="${w}" height="${h}" rx="12" />`;
    case "stadium":
      return `<rect ${cls} x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" />`;
    case "circle":
      return `<ellipse ${cls} cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" />`;
    case "diamond":
      return `<polygon ${cls} points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" />`;
    case "hexagon":
      return `<polygon ${cls} points="${x + 15},${y} ${x + w - 15},${y} ${x + w},${y + h / 2} ${x + w - 15},${y + h} ${x + 15},${y + h} ${x},${y + h / 2}" />`;
    case "lean-r":
      return `<polygon ${cls} points="${x + 18},${y} ${x + w},${y} ${x + w - 18},${y + h} ${x},${y + h}" />`;
    case "lean-l":
      return `<polygon ${cls} points="${x},${y} ${x + w - 18},${y} ${x + w},${y + h} ${x + 18},${y + h}" />`;
    case "flag":
      return `<polygon ${cls} points="${x},${y} ${x + w - 10},${y} ${x + w},${y + h / 2} ${x + w - 10},${y + h} ${x},${y + h}" />`;
    case "subroutine":
      return (
        `<rect ${cls} x="${x}" y="${y}" width="${w}" height="${h}" rx="3" />` +
        `<line class="mf-inner" x1="${x + 7}" y1="${y}" x2="${x + 7}" y2="${y + h}" />` +
        `<line class="mf-inner" x1="${x + w - 7}" y1="${y}" x2="${x + w - 7}" y2="${y + h}" />`
      );
    case "cylinder":
      return (
        `<path ${cls} d="M${x} ${y + 7} a${w / 2} 7 0 0 1 ${w} 0 v${h - 14} a${w / 2} 7 0 0 1 ${-w} 0 z" />` +
        `<path class="mf-inner" d="M${x} ${y + 7} a${w / 2} 7 0 0 0 ${w} 0" fill="none" />`
      );
    default:
      return `<rect ${cls} x="${x}" y="${y}" width="${w}" height="${h}" rx="4" />`;
  }
}

/** 折线过一遍圆角，看起来像 mermaid 的曲线，又不必引曲线库 */
function edgePath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return "";
  if (points.length === 2) return `M${points[0].x} ${points[0].y} L${points[1].x} ${points[1].y}`;
  const parts = [`M${points[0].x} ${points[0].y}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const next = points[i + 1];
    const r = 9;
    const inLen = Math.hypot(current.x - previous.x, current.y - previous.y) || 1;
    const outLen = Math.hypot(next.x - current.x, next.y - current.y) || 1;
    const t1 = Math.min(r, inLen / 2) / inLen;
    const t2 = Math.min(r, outLen / 2) / outLen;
    const a = { x: current.x - (current.x - previous.x) * t1, y: current.y - (current.y - previous.y) * t1 };
    const b = { x: current.x + (next.x - current.x) * t2, y: current.y + (next.y - current.y) * t2 };
    parts.push(`L${a.x.toFixed(1)} ${a.y.toFixed(1)}`, `Q${current.x.toFixed(1)} ${current.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
  }
  const last = points[points.length - 1];
  parts.push(`L${last.x} ${last.y}`);
  return parts.join(" ");
}

let uidSeq = 0;

export function renderMermaidFlowchart(source: string): MermaidRender {
  const text = String(source || "").trim();
  if (!text) return { svg: null, reason: "图表是空的" };

  let parsed: ParsedFlow;
  try {
    const result = parseFlow(text);
    if ("error" in result) return { svg: null, reason: result.error, kind: result.kind };
    parsed = result;
  } catch (err) {
    return { svg: null, reason: `解析失败：${(err as Error).message}` };
  }

  const graph = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  graph.setGraph({
    rankdir: parsed.dir,
    nodesep: 26,
    ranksep: 44,
    marginx: 8,
    marginy: 8,
    // 边标签占位，免得线穿过字
    edgesep: 16,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const sizes = new Map<string, { w: number; h: number }>();
  for (const node of parsed.nodes.values()) {
    const size = nodeSize(node);
    sizes.set(node.id, size);
    graph.setNode(node.id, { width: size.w, height: size.h });
  }
  for (const cluster of parsed.clusters.values()) {
    graph.setNode(cluster.id, { label: cluster.title });
  }
  for (const node of parsed.nodes.values()) {
    if (node.parent && parsed.clusters.has(node.parent)) graph.setParent(node.id, node.parent);
  }
  // 边名里带上序号：同一对节点之间可以有多条边，而且回头能按名字取回原始语义
  parsed.edges.forEach((edge, index) => {
    if (!parsed.nodes.has(edge.from) || !parsed.nodes.has(edge.to)) return;
    const width = edge.label ? textWidth(edge.label, 11) + 10 : 0;
    graph.setEdge(edge.from, edge.to, { label: edge.label, width, height: edge.label ? 16 : 0 }, `e${index}`);
  });

  try {
    dagre.layout(graph);
  } catch (err) {
    return { svg: null, reason: `排版失败：${(err as Error).message}` };
  }

  const info = graph.graph();
  const pad = 10;
  const width = Math.ceil((info.width || 0) + pad * 2);
  const height = Math.ceil((info.height || 0) + pad * 2);

  uidSeq += 1;
  const uid = `mf${uidSeq}`;
  const body: string[] = [];

  /* 子图框先画，压在节点底下 */
  for (const cluster of parsed.clusters.values()) {
    const box = graph.node(cluster.id) as { x: number; y: number; width: number; height: number } | undefined;
    if (!box || !Number.isFinite(box.x)) continue;
    const x = box.x - box.width / 2 + pad;
    const y = box.y - box.height / 2 + pad;
    body.push(
      `<g class="mf-cluster"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${box.width.toFixed(1)}" height="${box.height.toFixed(1)}" rx="8" />` +
        (cluster.title
          ? `<text x="${(x + 10).toFixed(1)}" y="${(y + 15).toFixed(1)}">${escapeXml(cluster.title)}</text>`
          : "") +
        `</g>`,
    );
  }

  for (const key of graph.edges()) {
    const data = graph.edge(key) as { points?: { x: number; y: number }[]; label?: string; x?: number; y?: number };
    const points = (data.points || []).map((point) => ({ x: point.x + pad, y: point.y + pad }));
    if (points.length < 2) continue;
    const meta = parsed.edges[Number((key.name || "e0").slice(1))] || { stroke: "solid" as const, arrow: true };
    const dash = meta.stroke === "dotted" ? ' stroke-dasharray="4 4"' : "";
    const thick = meta.stroke === "thick" ? ' stroke-width="2.6"' : "";
    const marker = meta.arrow ? ` marker-end="url(#${uid}-arrow)"` : "";
    body.push(`<path class="mf-edge" d="${edgePath(points)}"${dash}${thick}${marker} />`);
    if (data.label && Number.isFinite(data.x) && Number.isFinite(data.y)) {
      const lx = (data.x as number) + pad;
      const ly = (data.y as number) + pad;
      const w = textWidth(data.label, 11) + 8;
      body.push(
        `<g class="mf-elabel"><rect x="${(lx - w / 2).toFixed(1)}" y="${(ly - 8).toFixed(1)}" width="${w.toFixed(1)}" height="16" rx="3" />` +
          `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}">${escapeXml(data.label)}</text></g>`,
      );
    }
  }

  for (const node of parsed.nodes.values()) {
    const box = graph.node(node.id) as { x: number; y: number } | undefined;
    if (!box || !Number.isFinite(box.x)) continue;
    const size = sizes.get(node.id)!;
    const x = box.x - size.w / 2 + pad;
    const y = box.y - size.h / 2 + pad;
    const first = y + size.h / 2 - ((node.lines.length - 1) * LINE_H) / 2 + 4.5;
    const lines = node.lines
      .map((line, index) => `<tspan x="${(x + size.w / 2).toFixed(1)}" y="${(first + index * LINE_H).toFixed(1)}">${escapeXml(line)}</tspan>`)
      .join("");
    body.push(`<g>${shapeSvg(node, x, y, size.w, size.h)}<text class="mf-text">${lines}</text></g>`);
  }

  const svg =
    `<svg class="mf" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `<defs><marker id="${uid}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0 0 L10 5 L0 10 z" class="mf-arrow" /></marker></defs>` +
    body.join("") +
    `</svg>`;

  return { svg };
}

/** 导出里给 SVG 配的样式（跟着产物一起内联，不依赖任何外部表） */
export const MERMAID_FLOW_CSS = `
.mf { max-width: 100%; height: auto; font-family: inherit; }
.mf .mf-node { fill: #f7f6f2; stroke: #b9b5a8; stroke-width: 1.2; }
.mf .mf-inner { stroke: #b9b5a8; stroke-width: 1.1; fill: none; }
.mf .mf-text { fill: #2c2c2c; font-size: 13px; text-anchor: middle; }
.mf .mf-edge { stroke: #9a9689; stroke-width: 1.5; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.mf .mf-arrow { fill: #9a9689; stroke: none; }
.mf .mf-elabel rect { fill: #fdfdfb; stroke: none; }
.mf .mf-elabel text { fill: #6d6a60; font-size: 11px; text-anchor: middle; }
.mf .mf-cluster rect { fill: rgba(0,0,0,0.022); stroke: #d6d2c6; stroke-width: 1; stroke-dasharray: 5 4; }
.mf .mf-cluster text { fill: #8a8578; font-size: 11.5px; font-weight: 600; }
`;
