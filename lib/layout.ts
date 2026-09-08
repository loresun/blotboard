/**
 * 两种「整理」，解决的是不同问题：
 *
 * 1. `tidyBoard`（整齐化）—— **保留你摆出来的结构**，只把乱掉的地方收拾干净：
 *    对齐成行列、按连线重排同列顺序减少交叉、推开重叠、吸附网格。
 *    卡片还在你放的那一片，线不再像毛线团。日常用这个。
 *
 * 2. `layoutBoard`（分层重排）—— dagre 按连线方向重新算位置，**会推翻你的布局**。
 *    适合一块板乱到没法看、想从连线关系重新生成一版的时候。
 */
/* 纯计算模块（没有 React / 浏览器 API），所以前端和服务端都能用：
   agent 调 POST /:id/tidy 时走的就是这里，跟用户点「整理」是同一套算法。 */
import { CARD_METAS } from "./card-metas";
import { SNAP_GRID } from "./constants";
import { TASK_PRIORITIES, TASK_STATUSES, type BoardCard, type BoardEdge, type DataValue } from "./types";

export type LayoutDirection = "LR" | "TB";
export type TidyMode =
  | "tidy"
  | "LR"
  | "TB"
  | "flow"
  | "group"
  | "grid"
  | "timeline"
  | "kanban"
  | "matrix"
  | "swimlane"
  | "cluster";

/**
 * 整理模式的自描述表（`/api/capabilities` 的 layouts 段与顶栏菜单的文案都从这来）。
 *
 * 摆在这里而不是各自硬编码：agent 探一次 capabilities 就知道有哪几种、各是什么意思，
 * 不用去猜 mode 的拼写；服务端的合法值闸门（TIDY_MODES）也是从这派生的，加一种模式
 * 只改这一张表，三处不会漂移。
 */
export const LAYOUT_MODES: { mode: TidyMode; label: string; desc: string }[] = [
  { mode: "tidy", label: "整齐化", desc: "保留你摆出来的结构，只对齐行列、理顺交叉的线、推开重叠——默认，日常用这个" },
  { mode: "flow", label: "按流程串开", desc: "每条链拉成一行，分支往下错开，汇合点放在全部前驱的右侧；环中的返回连线保留，不要求它也向右" },
  { mode: "LR", label: "横向分层", desc: "dagre 按连线方向从左到右分层重排（会推翻当前布局）" },
  { mode: "TB", label: "纵向分层", desc: "dagre 自上而下分层重排（会推翻当前布局）" },
  { mode: "group", label: "按类型分区", desc: "同类卡片聚成一区，区与区之间留白" },
  { mode: "grid", label: "网格铺开", desc: "不看连线，全部对齐铺成网格（**会覆盖已有卡片的坐标**，改砸了用画板「历史」回滚）" },
  {
    mode: "timeline",
    label: "时间线",
    desc:
      "按 UTC 自然日横向排开：一天一列、同一天纵向堆叠（不随浏览器或服务器时区变化）。取时间的次序是「规格卡里第一个 date 字段 → 任务卡推给 Runner 的时刻 → 建卡时间」，" +
      "一个都取不到的排到最右侧「未定时」区",
  },
  {
    mode: "kanban",
    label: "看板分列",
    desc:
      "按状态分列：任务卡按 idea/issued/running/done，规格卡按规格里的状态 enum（key/label 含 status 或「状态」的那个，没有就取第一个 enum），" +
      "其余按卡片类型；取不到的进末列「其他」",
  },
  {
    mode: "matrix",
    label: "四象限",
    desc:
      "按两个二值维度摆进四象限（十字留白分隔）。维度**整块板只选一组**，次序是：" +
      "① 板上有任务卡 → 纵轴「重要」（priority urgent/high vs 其余）× 横轴「已开工」（status issued/running/done vs idea）；" +
      "② 否则在具备两个可用 enum/number 维度的规格中，选择卡片最多的一份 → 取它的前两个维度（第一个当横轴、第二个当纵轴，enum 按 options 前半/后半二分，number 按本板中位数二分）；" +
      "③ 都没有 → 按连线的「有无上游 × 有无下游」（起点 / 终点 / 中间 / 孤立）。归不了类的卡摆在四象限右侧的「未归类」区",
  },
  {
    mode: "swimlane",
    label: "泳道",
    desc:
      "二维分格：**行 = 卡片类型**（顺序同「按类型分区」），**列 = 状态**（口径与看板分列完全一致）。" +
      "行与行、列与列之间的留白远大于格内卡片间距，行首列首各自对齐成一条线——布局只摆位、画不了标题文字，行列边界靠留白自解释。" +
      "空行空列不占位",
  },
  {
    mode: "cluster",
    label: "子图分簇",
    desc:
      "按连线的**连通分量**分簇：每一簇内部用 dagre 横向分层排一次，簇与簇之间按网格铺开并留出明显间距（簇大的排在前）。" +
      "一条线都没连的孤立卡聚成最后一簇。想看清「这块板其实是几张互不相干的图」时用它",
  },
];

/** 服务端 / MCP 的合法 mode 闸门（真源是上面那张表，别再手抄一份）。 */
export const TIDY_MODES: readonly TidyMode[] = LAYOUT_MODES.map((item) => item.mode);

/**
 * 布局要用到的「规格切片」。
 *
 * timeline / kanban 得知道一份规格里哪个字段是时间、哪个字段是状态，可这个模块必须
 * 保持纯计算、前后端同构（card-spec-store 引了 node:fs，进不了浏览器 bundle）。
 * 所以规格由调用方喂进来：服务端从 card-spec-store 取，前端从 store.specs 取，
 * 两边给的对象都天然满足这个形状。喂不进来（比如老调用方没传）就退化成按建卡时间 / 卡片类型排。
 */
export interface LayoutSpecField {
  key: string;
  label?: string;
  type: string;
  options?: { value: string; label?: string }[];
}

export interface LayoutSpecLike {
  fields?: LayoutSpecField[];
}

export interface LayoutContext {
  /** specId → 规格切片 */
  specs?: Record<string, LayoutSpecLike | undefined>;
}

/** 选中多张时的对齐 / 分布动作 */
export type AlignAction = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "hspace" | "vspace";

export interface LayoutResult {
  id: string;
  x: number;
  y: number;
}

export const GAP_X = 90;
export const GAP_Y = 60;
export const ISLAND_GAP = 140;

/* ── 1. 整齐化：保结构，只去乱 ─────────────────── */

/**
 * 整理 / 对齐的格距——跟拖动吸附、画布点阵是**同一把尺**（lib/constants.ts 的 SNAP_GRID）。
 *
 * 以前这里自成一套 20，理由是「批量重排的收尾不必跟拖动手感共用刻度」。
 * 但同一块板上两套刻度是会打架的：整理完所有卡落在 20 的倍数上，开着吸附随手推一张，
 * 它就跳到 22 的倍数去——刚整齐的那一列被戳出一个豁口。一块板上只该有一把尺。
 */
const GRID = SNAP_GRID;
/** 中心点差在这个范围内视为「本来就想对齐」 */
const ALIGN_TOLERANCE = 72;
/** 卡片之间至少留的空隙 */
const MIN_GAP = 28;
const SEPARATION_PASSES = 60;

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

/**
 * 一维聚类：簇的总跨度不超过容差，已有格线作为锚点，否则取簇内均值。
 * 返回 id → 对齐后的中心坐标。
 */
function alignAxis(items: { id: string; center: number }[], tolerance: number): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.center - b.center);
  const result = new Map<string, number>();
  let cluster: typeof sorted = [];
  let gridAnchor: number | undefined;

  const flush = () => {
    if (!cluster.length) return;
    const mean = gridAnchor ?? cluster.reduce((sum, item) => sum + item.center, 0) / cluster.length;
    for (const item of cluster) result.set(item.id, mean);
    cluster = [];
    gridAnchor = undefined;
  };

  for (const item of sorted) {
    const onGrid = Math.abs(item.center - snap(item.center)) < 1e-6;
    // 已有格线是用户结构的锚点：相邻但不同的格线不再合并，否则重复整理会继续吞列。
    const differentAnchor = onGrid && gridAnchor != null && Math.abs(item.center - gridAnchor) > 1e-6;
    if (cluster.length && (item.center - cluster[0].center > tolerance || differentAnchor)) flush();
    cluster.push(item);
    if (onGrid) gridAnchor = item.center;
  }
  flush();
  return result;
}

/** 把每条对齐线吸到点阵上（同一簇的成员拿到同一个值，所以吸完还是一条线）。 */
function snapLines(lines: Map<string, number>): Map<string, number> {
  const snapped = new Map<string, number>();
  for (const [id, line] of lines) snapped.set(id, snap(line));
  return snapped;
}

/** 这张卡是不是还正好站在它那条对齐线上（半个像素以内算「没动过」）。 */
function isOnLine(center: number, line: number | undefined): boolean {
  return line != null && Math.abs(center - line) < 0.5;
}

/** 矩形是否重叠（含最小间隙） */
function overlaps(a: Box, b: Box, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

/**
 * 迭代推开重叠：每次沿「侵入最浅」的轴分开，避免把卡片推到天边。
 * 这一步不改对齐线的归属，只在同一片区域内挪。
 */
function separate(boxes: Box[], gap: number, passes: number): void {
  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (!overlaps(a, b, gap)) continue;
        const overlapX = Math.min(a.x + a.w + gap - b.x, b.x + b.w + gap - a.x);
        const overlapY = Math.min(a.y + a.h + gap - b.y, b.y + b.h + gap - a.y);
        const push = 0.5;
        if (overlapX < overlapY) {
          const shift = overlapX * push;
          if (a.x + a.w / 2 <= b.x + b.w / 2) {
            a.x -= shift;
            b.x += shift;
          } else {
            a.x += shift;
            b.x -= shift;
          }
        } else {
          const shift = overlapY * push;
          if (a.y + a.h / 2 <= b.y + b.h / 2) {
            a.y -= shift;
            b.y += shift;
          } else {
            a.y += shift;
            b.y -= shift;
          }
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/**
 * 同一列内按「连线邻居的平均高度」重排顺序（重心法）——
 * 这是减少连线交叉的经典手法：卡片留在你放的那一列，只是上下换个位次，
 * 于是缠成一团的曲线自己就理顺了。
 */
function reduceCrossings(columns: Map<number, Box[]>, neighborsOf: Map<string, string[]>, centerY: Map<string, number>): void {
  // 每次只接受让连线总纵向跨度平方下降的换位；同步读旧值会使两列反复交换，等分也不应换位。
  const ordered = [...columns].sort(([a], [b]) => a - b).map(([, boxes]) => boxes);
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const boxes of ordered) {
      if (boxes.length < 2) continue;
      const members = new Set(boxes.map((box) => box.id));
      const slots = boxes.map((box) => box.y + box.h / 2).sort((a, b) => a - b);
      const scored = boxes.map((box) => {
        const values = (neighborsOf.get(box.id) || []).filter((id) => !members.has(id))
          .map((id) => centerY.get(id)).filter((value): value is number => value != null);
        const center = box.y + box.h / 2;
        const barycenter = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : center;
        return { box, center, values, barycenter };
      });
      scored.sort((a, b) => a.barycenter - b.barycenter || a.center - b.center);
      const before = scored.reduce((sum, entry) => sum + entry.values.reduce((cost, y) => cost + (entry.center - y) ** 2, 0), 0);
      const after = scored.reduce((sum, entry, index) => sum + entry.values.reduce((cost, y) => cost + (slots[index] - y) ** 2, 0), 0);
      if (after >= before - 1e-6) continue;
      scored.forEach((entry, index) => {
        entry.box.y = slots[index] - entry.box.h / 2;
        centerY.set(entry.box.id, slots[index]);
      });
      changed = true;
    }
    if (!changed) break;
  }
}

/**
 * 整齐化：对齐 → 减少交叉 → 推开重叠 → 吸附网格。
 * 输入输出都是卡片左上角坐标。
 */
function tidyPass(cards: BoardCard[], edges: BoardEdge[]): LayoutResult[] {
  if (!cards.length) return [];

  const boxes: Box[] = cards.map((card) => ({ id: card.id, x: card.x, y: card.y, w: card.w, h: card.h }));
  const byId = new Map(boxes.map((box) => [box.id, box]));

  const neighborsOf = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    if (!neighborsOf.has(edge.from)) neighborsOf.set(edge.from, []);
    if (!neighborsOf.has(edge.to)) neighborsOf.set(edge.to, []);
    neighborsOf.get(edge.from)!.push(edge.to);
    neighborsOf.get(edge.to)!.push(edge.from);
  }

  /* 1) 对齐成列与行。
        **对齐线本身先吸到格上**，卡片再精确落到线上——顺序反过来（先落线、收尾逐张吸格）
        就是这个函数从前的 bug：同一列里宽度不同的卡，各自的量化误差不同，
        刚对齐好的一列在最后一步又被推散了。整列整行作为一个整体吸附，才是「齐」。 */
  const columnOf = snapLines(alignAxis(boxes.map((box) => ({ id: box.id, center: box.x + box.w / 2 })), ALIGN_TOLERANCE));
  const rowOf = snapLines(alignAxis(boxes.map((box) => ({ id: box.id, center: box.y + box.h / 2 })), ALIGN_TOLERANCE));
  for (const box of boxes) {
    const cx = columnOf.get(box.id);
    const cy = rowOf.get(box.id);
    if (cx != null) box.x = cx - box.w / 2;
    if (cy != null) box.y = cy - box.h / 2;
  }

  // 2) 同列内按连线重心重排，减少交叉
  const columns = new Map<number, Box[]>();
  for (const box of boxes) {
    const key = Math.round((columnOf.get(box.id) ?? box.x + box.w / 2) / 10);
    if (!columns.has(key)) columns.set(key, []);
    columns.get(key)!.push(box);
  }
  const centerY = new Map(boxes.map((box) => [box.id, box.y + box.h / 2]));
  reduceCrossings(columns, neighborsOf, centerY);

  // 3) 推开重叠（对齐与重排都可能造成叠在一起）
  separate(boxes, MIN_GAP, SEPARATION_PASSES);

  /* 4) 收尾吸附——**只吸被推开过的那些**。
        还站在对齐线上的原样保留：线在第 1 步就已经吸过格了，这里再吸一次
        只会按各自宽高把它们重新错开（最多差一格）。被 separate() / reduceCrossings
        挪动过的卡已经不在线上，那才需要落回点阵，免得它孤零零停在一个随机坐标上。 */
  const rowLines = [...new Set(rowOf.values())];
  for (const box of boxes) {
    const onColumn = isOnLine(box.x + box.w / 2, columnOf.get(box.id));
    // 减少交叉会交换行位：站在任何一条已对齐的行上都应保留，而非只认原来的行。
    const onRow = rowLines.some((line) => isOnLine(box.y + box.h / 2, line));
    box.x = onColumn ? box.x : snap(box.x + box.w / 2) - box.w / 2;
    box.y = onRow ? box.y : snap(box.y + box.h / 2) - box.h / 2;
  }

  // 量化可能缩小刚留出的间隙；有限次的迭代也可能留下密集堆叠。
  // 以最终坐标验收，每张只向下跨过已放置的障碍，有限步终止；之后绝不再量化。
  const placed: Box[] = [];
  for (const box of [...boxes].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))) {
    let obstacles = placed.filter((other) => overlaps(box, other, MIN_GAP - 1e-6));
    while (obstacles.length) {
      const below = Math.max(...obstacles.map((other) => other.y + other.h + MIN_GAP));
      box.y = Math.ceil((below + box.h / 2) / GRID) * GRID - box.h / 2;
      obstacles = placed.filter((other) => overlaps(box, other, MIN_GAP - 1e-6));
    }
    placed.push(box);
  }
  return boxes.map(({ id, x, y }) => ({ id, x, y }));
}

/** 重排混合高度卡之后需再次检查交叉和间距；一次点击完成这些内部收敛步骤。 */
export function tidyBoard(cards: BoardCard[], edges: BoardEdge[]): LayoutResult[] {
  let current = cards;
  const history: LayoutResult[][] = [];
  const seen = new Map<string, number>();
  for (let pass = 0; pass < 8; pass++) {
    const result = tidyPass(current, edges);
    if (result.every((position, index) => position.x === current[index].x && position.y === current[index].y)) return result;
    const key = JSON.stringify(result);
    const previous = seen.get(key);
    if (previous != null) {
      // 极端图若形成循环，固定选择循环内同一份坐标，避免每点一次就换一个状态。
      return history.slice(previous).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))[0];
    }
    seen.set(key, history.length);
    history.push(result);
    current = current.map((card, index) => ({ ...card, ...result[index] }));
  }
  return history[history.length - 1] || [];
}

/* ── 3. 工作流串：一条链一行 ──────────────────────
   「有线段顺序的，就按顺序排开」——把每个连通块拆成若干条从起点走到终点的链，
   一条链占一行，从左到右就是执行顺序；同一块里的分支往下错开一行。
   dagre 的分层是按「秩」压扁的，看不出「这条路径是怎么走下来的」，这个能看出来。 */
const LANE_GAP = 90;
const STEP_GAP = 120;
const CHAIN_GAP = 180;

function buildGraph(cards: BoardCard[], edges: BoardEdge[]) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const out = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  const undirected = new Map<string, Set<string>>();
  for (const card of cards) {
    out.set(card.id, []);
    inDeg.set(card.id, 0);
    undirected.set(card.id, new Set());
  }
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue;
    if (out.get(edge.from)!.includes(edge.to)) continue;
    out.get(edge.from)!.push(edge.to);
    inDeg.set(edge.to, (inDeg.get(edge.to) || 0) + 1);
    undirected.get(edge.from)!.add(edge.to);
    undirected.get(edge.to)!.add(edge.from);
  }
  return { byId, out, inDeg, undirected };
}

/** 连通块，按「块内卡片数」从大到小，大的先排在上面 */
function components(cards: BoardCard[], undirected: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const card of cards) {
    if (seen.has(card.id)) continue;
    const stack = [card.id];
    const group: string[] = [];
    seen.add(card.id);
    while (stack.length) {
      const id = stack.pop()!;
      group.push(id);
      for (const next of undirected.get(id) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    groups.push(group);
  }
  return groups.sort((a, b) => b.length - a.length);
}

/**
 * 无向连通分量（大的排前面）。
 *
 * 「一块板其实是几张互不相干的图」这个判断，导出分节（lib/export-html.ts 的 sectionize）
 * 与子图分簇（lib/layout-dagre.ts 的 clusterBoard）问的是同一件事。那边用并查集是因为
 * 顺带要挑「阅读顺序最靠前的当节标题」，这里用现成的 buildGraph 做一次广搜就够了。
 */
export function connectedComponents(cards: BoardCard[], edges: BoardEdge[]): string[][] {
  const { undirected } = buildGraph(cards, edges);
  return components(cards, undirected);
}

/**
 * 把有向图中的 DFS 回边暂作返回线，其余依赖保留为 DAG，再按所有前驱的最右端排横坐标。
 * 使用显式栈避免长链递归溢出；只忽略构成环的回边，不会把正常汇合的依赖误当成回边。
 */
function flowColumns(cards: BoardCard[], graph: Map<string, string[]>) {
  const color = new Map<string, number>();
  const back = new Map<string, Set<string>>();
  for (const card of cards) {
    if (color.has(card.id)) continue;
    color.set(card.id, 1);
    const stack = [{ id: card.id, next: 0 }];
    while (stack.length) {
      const current = stack[stack.length - 1];
      const neighbors = graph.get(current.id) || [];
      if (current.next === neighbors.length) {
        color.set(current.id, 2);
        stack.pop();
        continue;
      }
      const next = neighbors[current.next++];
      if (color.get(next) === 1) {
        if (!back.has(current.id)) back.set(current.id, new Set());
        back.get(current.id)!.add(next);
      } else if (!color.has(next)) {
        color.set(next, 1);
        stack.push({ id: next, next: 0 });
      }
    }
  }
  const out = new Map([...graph].map(([id, next]) => [id, next.filter((target) => !back.get(id)?.has(target))]));
  const inDeg = new Map(cards.map((card) => [card.id, 0]));
  for (const next of out.values()) for (const id of next) inDeg.set(id, inDeg.get(id)! + 1);
  const pending = new Map(inDeg);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const xOf = new Map(cards.map((card) => [card.id, snap(40)]));
  const queue = cards.filter((card) => !pending.get(card.id)).map((card) => card.id);
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const after = Math.ceil((xOf.get(id)! + byId.get(id)!.w + STEP_GAP) / GRID) * GRID;
    for (const next of out.get(id) || []) {
      xOf.set(next, Math.max(xOf.get(next)!, after));
      pending.set(next, pending.get(next)! - 1);
      if (!pending.get(next)) queue.push(next);
    }
  }
  return { out, inDeg, xOf };
}

export function flowBoard(cards: BoardCard[], edges: BoardEdge[]): LayoutResult[] {
  if (!cards.length) return [];
  const { byId, out: graph, undirected } = buildGraph(cards, edges);
  const { out, inDeg, xOf } = flowColumns(cards, graph);
  const result: LayoutResult[] = [];
  let cursorY = 40;

  for (const group of components(cards, undirected)) {
    const inGroup = new Set(group);
    // 回边已剥离作返回线，其余依赖构成 DAG，从入度为 0 的节点开始。
    const roots = group.filter((id) => (inDeg.get(id) || 0) === 0);
    const starts = roots.length ? roots : [group[0]];
    const placed = new Set<string>();
    const groupTop = cursorY;
    let laneY = cursorY;

    /** 从一个起点沿「还没排过的下游」一路走到底，走出一条链 */
    const walkChain = (from: string): string[] => {
      const chain: string[] = [];
      let current: string | null = from;
      while (current && !placed.has(current)) {
        chain.push(current);
        placed.add(current);
        const next: string[] = (out.get(current) || []).filter((id) => inGroup.has(id) && !placed.has(id));
        // 顺着「下游最多」的那条走，主干才会落在同一行
        next.sort((a: string, b: string) => (out.get(b)?.length || 0) - (out.get(a)?.length || 0));
        current = next[0] ?? null;
      }
      return chain;
    };

    const queue = [...starts];
    while (queue.length) {
      const seed = queue.shift()!;
      if (placed.has(seed)) continue;
      const chain = walkChain(seed);
      if (!chain.length) continue;
      let rowHeight = 0;
      for (const id of chain) {
        const card = byId.get(id)!;
        result.push({ id, x: xOf.get(id)!, y: snap(laneY) });
        rowHeight = Math.max(rowHeight, card.h);
        // 这条链上每个节点的旁支，作为后面的新链
        for (const next of out.get(id) || []) {
          if (inGroup.has(next) && !placed.has(next)) queue.push(next);
        }
      }
      laneY += rowHeight + LANE_GAP;
    }

    // 防御性兜底：即使后续改变了链路选择，也不遗漏块里的卡片。
    for (const id of group) {
      if (placed.has(id)) continue;
      const card = byId.get(id)!;
      result.push({ id, x: xOf.get(id)!, y: snap(laneY) });
      laneY += card.h + LANE_GAP;
      placed.add(id);
    }
    cursorY = Math.max(laneY, groupTop) + CHAIN_GAP;
  }
  return result;
}

/* ── 4. 按类型分组：同类聚成一区，区与区之间留白 ──
   顺序从卡片包注册表派生（cards/<type>/meta.ts 的 groupOrder）；
   未知类型 indexOf 得 -1，自然排最前，不炸。 */
const GROUP_ORDER: BoardCard["type"][] = [...CARD_METAS]
  .sort((a, b) => a.groupOrder - b.groupOrder)
  .map((meta) => meta.type);
const GROUP_GAP = 200;
const ROW_MAX = 1800;

export function groupBoard(cards: BoardCard[]): LayoutResult[] {
  if (!cards.length) return [];
  const buckets = new Map<string, BoardCard[]>();
  for (const card of cards) {
    if (!buckets.has(card.type)) buckets.set(card.type, []);
    buckets.get(card.type)!.push(card);
  }
  const types = [...buckets.keys()].sort(
    (a, b) => GROUP_ORDER.indexOf(a as BoardCard["type"]) - GROUP_ORDER.indexOf(b as BoardCard["type"]),
  );

  const result: LayoutResult[] = [];
  const start = snap(40);
  // Advance from the actual snapped geometry, rounding gaps upward. Rounding
  // each final position independently used to eat into row and group spacing.
  const nextGrid = (value: number) => Math.ceil(value / SNAP_GRID) * SNAP_GRID;
  let cursorY = start;
  for (const type of types) {
    const list = buckets.get(type)!;
    let cursorX = start;
    let rowHeight = 0;
    let blockBottom = cursorY;
    for (const card of list) {
      if (cursorX > start && cursorX + card.w > ROW_MAX) {
        cursorX = start;
        cursorY = nextGrid(cursorY + rowHeight + GAP_Y);
        rowHeight = 0;
      }
      result.push({ id: card.id, x: cursorX, y: cursorY });
      cursorX = nextGrid(cursorX + card.w + GAP_X);
      rowHeight = Math.max(rowHeight, card.h);
      blockBottom = Math.max(blockBottom, cursorY + card.h);
    }
    cursorY = nextGrid(blockBottom + GROUP_GAP);
  }
  return result;
}

/* ── 5. 网格：不管连线，全部对齐铺开 ── */
export function gridBoard(cards: BoardCard[]): LayoutResult[] {
  if (!cards.length) return [];
  const maxWidth = Math.max(...cards.map((card) => card.w));
  // Quantize the cell pitch once, not every card position: otherwise odd card
  // sizes produce alternating column/row gaps despite the "grid" promise.
  // Round upward so grid alignment never consumes the advertised minimum gap.
  const colWidth = Math.ceil((maxWidth + GAP_X) / SNAP_GRID) * SNAP_GRID;
  const rowHeight = Math.ceil((Math.max(...cards.map((card) => card.h)) + GAP_Y) / SNAP_GRID) * SNAP_GRID;
  const start = snap(40);
  // Balance the whole collection around a landscape 16:10 footprint. A fixed
  // pixel row limit squeezed heterogeneous / large collections into long strips
  // that became unreadable when fitted into the viewport.
  const columns = Math.min(cards.length, Math.max(1, Math.ceil(Math.sqrt(cards.length * rowHeight * 1.6 / colWidth))));
  return cards.map((card, index) => ({
    id: card.id,
    x: start + (index % columns) * colWidth,
    y: start + Math.floor(index / columns) * rowHeight,
  }));
}

/* ── 5.5 时间线：一天一列，从左往右就是时间 ──────────
   画板上的卡片大多带着「什么时候的事」——规格卡里填的日期、任务卡推给 Runner 的时刻、
   最不济也有建卡时间。把这条隐含的时间轴显出来，一块杂乱的板立刻能看出「先后」。 */

const TIMELINE_TOP = 40;
const TIMELINE_LEFT = 40;
/** 一天与下一天之间的留白：明显大于同一天内两张卡的间距，肉眼才分得出「这是两天」 */
const TIMELINE_DAY_GAP = 120;
/** 同一天内上下两张卡的间距 */
const TIMELINE_STACK_GAP = 40;
/** 「未定时」区与时间轴之间再拉开一大段：它不在时间轴上，别让人误读成「最晚的一天」 */
const TIMELINE_UNDATED_GAP = 280;

/** 一份规格里第一个 date 字段的 key（规格自己的字段顺序就是重要性顺序，取第一个即可）。 */
function firstDateKey(spec: LayoutSpecLike | undefined): string | null {
  return (spec?.fields || []).find((field) => field.type === "date")?.key || null;
}

/** Reject absent/coerced scalars before numeric conversion; zero remains real numeric data. */
function semanticNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function finiteTime(value: unknown, historical = false): number | null {
  const num = semanticNumber(value);
  if (num == null || (!historical && num <= 0)) return null;
  return Number.isFinite(new Date(num).getTime()) ? num : null;
}

/**
 * 一张卡「算哪个时间」。次序是刻意的：
 * 规格卡填的业务时间 > 任务卡的同步时刻 > 建卡时间——越靠前的越是用户心里那个时间。
 * 全都取不到返回 null（进「未定时」区）。
 */
function cardTime(card: BoardCard, ctx: LayoutContext): number | null {
  if (card.type === "data" && card.data) {
    const key = firstDateKey(ctx.specs?.[card.data.specId]);
    if (key) {
      const value = (card.data.fields || {})[key] as DataValue | undefined;
      const time = finiteTime(value, true);
      if (time != null) return time;
    }
  }
  // 任务卡自己没有业务时间字段，issueSyncedAt 是它唯一「这件事什么时候动过」的账本
  if (card.type === "task" && card.task) {
    const synced = finiteTime(card.task.issueSyncedAt);
    if (synced) return synced;
  }
  return finiteTime(card.createdAt);
}

/** UTC calendar days are identical for API hosts and remote browsers (including DST). */
function dayKey(time: number): string {
  return new Date(time).toISOString().split("T")[0];
}

export function timelineBoard(cards: BoardCard[], ctx: LayoutContext = {}): LayoutResult[] {
  if (!cards.length) return [];

  const days = new Map<string, { time: number; cards: BoardCard[] }>();
  const undated: BoardCard[] = [];
  for (const card of cards) {
    const time = cardTime(card, ctx);
    if (time == null) {
      undated.push(card);
      continue;
    }
    const key = dayKey(time);
    const bucket = days.get(key) || { time, cards: [] };
    bucket.time = Math.min(bucket.time, time);
    bucket.cards.push(card);
    days.set(key, bucket);
  }

  const result: LayoutResult[] = [];
  let cursorX = TIMELINE_LEFT;
  const columns = [...days.entries()].sort((a, b) => a[1].time - b[1].time);

  for (const [, bucket] of columns) {
    // 同一天内也按时间先后堆；时间一样时按 id 定序，免得每次整理结果都不一样
    const list = [...bucket.cards].sort(
      (a, b) => (cardTime(a, ctx) || 0) - (cardTime(b, ctx) || 0) || (a.id < b.id ? -1 : 1),
    );
    let cursorY = TIMELINE_TOP;
    let columnWidth = 0;
    for (const card of list) {
      result.push({ id: card.id, x: snap(cursorX), y: snap(cursorY) });
      cursorY += card.h + TIMELINE_STACK_GAP;
      columnWidth = Math.max(columnWidth, card.w);
    }
    cursorX += columnWidth + TIMELINE_DAY_GAP;
  }

  if (undated.length) {
    if (columns.length) cursorX += TIMELINE_UNDATED_GAP - TIMELINE_DAY_GAP;
    let cursorY = TIMELINE_TOP;
    for (const card of [...undated].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      result.push({ id: card.id, x: snap(cursorX), y: snap(cursorY) });
      cursorY += card.h + TIMELINE_STACK_GAP;
    }
  }
  return result;
}

/* ── 5.6 看板：按状态分列 ─────────────────────────
   「这块板上的事各自到哪一步了」——这个问题在自由画板上本来要一张张点开看。
   分列之后一眼就是答案，而且列还是画板上的卡片，能接着连线、接着改。 */

const KANBAN_TOP = 40;
const KANBAN_LEFT = 40;
const KANBAN_COL_GAP = 80;
const KANBAN_STACK_GAP = 40;

/** 列的内部键：按来源加前缀，任务的 done 与某份规格的 done 不会撞成一列 */
const OTHER_COLUMN = "other";

interface KanbanColumn {
  key: string;
  /** 排序用的字典序元组：[来源组, 组内位次, 兜底位次] */
  rank: [number, number, number];
  cards: BoardCard[];
}

/** 一份规格里当「状态」用的那个 enum 字段：key / label 点了名的优先，否则取第一个 enum。 */
function kanbanField(spec: LayoutSpecLike | undefined): LayoutSpecField | null {
  const enums = (spec?.fields || []).filter((field) => field.type === "enum" && (field.options || []).length);
  if (!enums.length) return null;
  const named = enums.find((field) => /status|状态/i.test(field.key) || /status|状态/i.test(field.label || ""));
  return named || enums[0];
}

/** Persisted values are authoritative; labels are a fallback for legacy imported fields. */
function enumOptionIndex(options: NonNullable<LayoutSpecField["options"]>, raw: unknown): number {
  if (raw == null || !["string", "number", "boolean"].includes(typeof raw)) return -1;
  const value = String(raw);
  if (!value.trim()) return -1;
  const exact = options.findIndex((option) => option.value === value);
  return exact >= 0 ? exact : options.findIndex((option) => option.label === value);
}

/**
 * 多份规格同时在场时，列的先后按 specId 字典序定——同一块板反复整理结果要一样。
 * 泳道也要同一份序，所以抽出来共用。
 */
function specRankOf(cards: BoardCard[]): Map<string, number> {
  const rank = new Map<string, number>();
  [...new Set(cards.filter((card) => card.type === "data" && card.data).map((card) => card.data!.specId))]
    .sort()
    .forEach((specId, index) => rank.set(specId, index));
  return rank;
}

/**
 * 一张卡「算哪一列」（看板与泳道共用的**唯一**状态口径）。
 *
 * 抽成函数是为了让泳道的列跟看板逐格对齐：两处各写一份判定，早晚会漂成
 * 「同一张卡在看板里进 running 列、在泳道里进其他列」。
 */
function kanbanColumnOf(
  card: BoardCard,
  ctx: LayoutContext,
  specRank: Map<string, number>,
): { key: string; rank: [number, number, number] } {
  // ① 任务卡：现成的四态，顺序就是任务台那一套
  if (card.type === "task") {
    if (card.task && TASK_STATUSES.includes(card.task.status)) {
      return { key: `task:${card.task.status}`, rank: [0, TASK_STATUSES.indexOf(card.task.status), 0] };
    }
    return { key: OTHER_COLUMN, rank: [3, 0, 0] };
  }
  // ② 规格卡：规格里的状态 enum，列顺序照 options 的顺序
  if (card.type === "data" && card.data) {
    const spec = ctx.specs?.[card.data.specId];
    const field = kanbanField(spec);
    const raw = field ? (card.data.fields || {})[field.key] : undefined;
    const index = field ? enumOptionIndex(field.options || [], raw) : -1;
    if (field && index >= 0) {
      return {
        key: `spec:${card.data.specId}:${field.options![index].value}`,
        rank: [1, specRank.get(card.data.specId) ?? 0, index],
      };
    }
    // 规格没装 / 状态字段没填 → 没有可分的列，进末列比硬塞一个假列诚实
    return { key: OTHER_COLUMN, rank: [3, 0, 0] };
  }
  // ③ 其余卡片按类型成列（顺序沿用「按类型分区」那套 groupOrder）
  return { key: `type:${card.type}`, rank: [2, Math.max(0, GROUP_ORDER.indexOf(card.type)), 0] };
}

export function kanbanBoard(cards: BoardCard[], ctx: LayoutContext = {}): LayoutResult[] {
  if (!cards.length) return [];

  const specRank = specRankOf(cards);
  const columns = new Map<string, KanbanColumn>();
  for (const card of cards) {
    const { key, rank } = kanbanColumnOf(card, ctx, specRank);
    const column = columns.get(key) || { key, rank, cards: [] };
    columns.set(key, { ...column, cards: [...column.cards, card] });
  }

  const ordered = [...columns.values()].sort(
    (a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2] || (a.key < b.key ? -1 : 1),
  );

  // 列宽一致：取全板最宽的一张卡，列与列的左边界才对得齐
  const columnWidth = Math.max(...cards.map((card) => card.w));
  const result: LayoutResult[] = [];
  ordered.forEach((column, index) => {
    const x = KANBAN_LEFT + index * (columnWidth + KANBAN_COL_GAP);
    let cursorY = KANBAN_TOP;
    for (const card of [...column.cards].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      result.push({ id: card.id, x: snap(x), y: snap(cursorY) });
      cursorY += card.h + KANBAN_STACK_GAP;
    }
  });
  return result;
}

/* ── 5.7 四象限：两个二值维度切成田字 ─────────────
   看板与时间线都是一维的（一条轴上分列）。可实际做决定时问的往往是**两件事同时成立吗**：
   「重要」×「开工了没」、「影响面」×「修没修」。二维一摆，「重要但还没动」那一格
   自己就跳出来了——那是一维排列永远显不出来的东西。

   三条硬规矩：
   1. 维度**整块板只选一组**（不是每张卡各选各的），否则同一格里的卡不是同一件事，象限就没意义；
   2. 归不了类的卡摆到四象限右侧的「未归类」区，不硬塞进某一格（塞进去等于伪造数据）；
   3. 布局只摆位，画不出坐标轴与象限标题——所以十字方向的留白开得很大，
      而格内卡片是紧挨着的网格，肉眼一看就知道分界线在哪。 */

const MATRIX_TOP = 40;
const MATRIX_LEFT = 40;
/** 十字分隔带：明显大于格内卡片间距，肉眼才读得出「这是两个象限」 */
const MATRIX_CROSS_GAP = 220;
/** 象限内部卡片之间的间距 */
const MATRIX_CELL_GAP_X = 40;
const MATRIX_CELL_GAP_Y = 36;
/** 「未归类」区与四象限之间再拉开一大段：它不在坐标系里，别让人当成第五个象限 */
const MATRIX_LOOSE_GAP = 360;
/** 单个象限内部最多几列——再宽就跨出屏幕，象限之间的对比反而看不成 */
const MATRIX_MAX_COLS = 4;

/**
 * 一块板选定的象限维度。
 * `axisX` / `axisY` 拿到一张卡时回答 true（右 / 上）、false（左 / 下）、null（归不了类）。
 */
interface MatrixAxes {
  source: "task" | "spec" | "graph";
  axisX: (card: BoardCard) => boolean | null;
  axisY: (card: BoardCard) => boolean | null;
}

/** 规格字段里能二值化的那两个：enum（按 options 前半 / 后半）或 number（按本板中位数）。 */
function matrixSpecFields(spec: LayoutSpecLike | undefined): LayoutSpecField[] {
  return (spec?.fields || []).filter(
    (field) => (field.type === "enum" && (field.options || []).length >= 2) || field.type === "number",
  );
}

function fieldValue(card: BoardCard, key: string): DataValue | undefined {
  const raw = card.data?.fields?.[key];
  return Array.isArray(raw) ? undefined : raw;
}

/** 一个 number 字段在本板上的中位数：二分点跟着数据走，不写死一个魔法阈值。 */
function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  const low = sorted[mid - 1];
  const high = sorted[mid];
  // Same-sign subtraction avoids overflow while retaining very small values;
  // opposite signs use half-sums because high-low can exceed Number.MAX_VALUE.
  return Math.sign(low) === Math.sign(high) ? low + (high - low) / 2 : low / 2 + high / 2;
}

/** 把一个规格字段变成「这张卡在这条轴的哪一半」的判定函数。 */
function specAxis(specId: string, field: LayoutSpecField, cards: BoardCard[]): (card: BoardCard) => boolean | null {
  if (field.type === "number") {
    const numbers = cards
      .filter((card) => card.type === "data" && card.data?.specId === specId)
      .map((card) => semanticNumber(fieldValue(card, field.key)))
      .filter((value): value is number => value != null);
    const median = medianOf(numbers);
    return (card) => {
      if (card.type !== "data" || card.data?.specId !== specId) return null;
      const value = semanticNumber(fieldValue(card, field.key));
      if (value == null || median == null) return null;
      // 中位数本身算「高的一半」：一半的卡在中位数上时，全押到低半区更违背直觉
      return value >= median;
    };
  }
  const options = field.options || [];
  // 前半 = 低档（左 / 下），后半 = 高档（右 / 上）；奇数个时中间那档算低档
  const split = Math.ceil(options.length / 2);
  return (card) => {
    if (card.type !== "data" || card.data?.specId !== specId) return null;
    const index = enumOptionIndex(options, fieldValue(card, field.key));
    return index < 0 ? null : index >= split;
  };
}

/**
 * 选维度。次序是刻意的：**越是用户自己填过的东西越靠前**——
 * 任务卡的优先级与状态是他一张张点出来的，规格字段是他照格式填的，
 * 连线拓扑则是「什么都没填时」还能算出来的最后一层意思。
 */
function pickMatrixAxes(cards: BoardCard[], edges: BoardEdge[], ctx: LayoutContext): MatrixAxes {
  // ① 任务卡：纵轴「重要」× 横轴「已开工」。
  //    左上格 = 重要但还没动 —— 这是这块板上最该先看的一格，也是选这组维度的全部理由。
  const hasTask = cards.some((card) => card.type === "task" && card.task);
  if (hasTask) {
    const important = new Set(["urgent", "high"]);
    return {
      source: "task",
      axisX: (card) => {
        if (card.type !== "task" || !card.task || !TASK_STATUSES.includes(card.task.status)) return null;
        // idea = 还躺在想法里；issued / running / done 都已经离开「只是个想法」这一档
        return card.task.status !== "idea";
      },
      axisY: (card) => {
        if (card.type !== "task" || !card.task || !TASK_PRIORITIES.includes(card.task.priority)) return null;
        return important.has(card.task.priority);
      },
    };
  }

  // ② 规格卡：取**卡片最多的那份规格**里前两个可二值化字段，第一个当横轴、第二个当纵轴。
  //    「前两个」不是随手挑的：规格自己的字段顺序就是它的重要性顺序（timeline 取第一个 date 也是这个道理）。
  const specCounts = new Map<string, number>();
  for (const card of cards) {
    if (card.type !== "data" || !card.data || matrixSpecFields(ctx.specs?.[card.data.specId]).length < 2) continue;
    specCounts.set(card.data.specId, (specCounts.get(card.data.specId) || 0) + 1);
  }
  // 张数并列时按 specId 字典序，同一块板反复整理结果要一样
  const mainSpec = [...specCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  const fields = mainSpec ? matrixSpecFields(ctx.specs?.[mainSpec]) : [];
  if (mainSpec && fields.length >= 2) {
    return {
      source: "spec",
      axisX: specAxis(mainSpec, fields[0], cards),
      axisY: specAxis(mainSpec, fields[1], cards),
    };
  }

  // ③ 兜底：连线拓扑。上排 = 没有上游（源头），右列 = 有下游。
  //    于是四格分别是 起点 / 中间 / 孤立 / 终点 —— 全板一张任务卡一张规格卡都没有时，
  //    「这块图从哪儿开始、到哪儿结束」是唯一还算得出来的二维信息。
  const ids = new Set(cards.map((card) => card.id));
  const hasUp = new Set<string>();
  const hasDown = new Set<string>();
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    hasDown.add(edge.from);
    hasUp.add(edge.to);
  }
  return {
    source: "graph",
    axisX: (card) => hasDown.has(card.id),
    axisY: (card) => !hasUp.has(card.id),
  };
}

export function matrixBoard(cards: BoardCard[], edges: BoardEdge[], ctx: LayoutContext = {}): LayoutResult[] {
  if (!cards.length) return [];
  const axes = pickMatrixAxes(cards, edges, ctx);

  /** 四象限：索引 = (top ? 0 : 2) + (right ? 1 : 0)，即 左上 右上 左下 右下 */
  const quadrants: BoardCard[][] = [[], [], [], []];
  const loose: BoardCard[] = [];
  for (const card of cards) {
    const right = axes.axisX(card);
    const top = axes.axisY(card);
    if (right == null || top == null) {
      loose.push(card);
      continue;
    }
    quadrants[(top ? 0 : 2) + (right ? 1 : 0)].push(card);
  }

  // 格子尺寸全板统一：象限之间要能横着竖着对比，格子不一样大就比不了
  const cellW = Math.max(...cards.map((card) => card.w)) + MATRIX_CELL_GAP_X;
  const cellH = Math.max(...cards.map((card) => card.h)) + MATRIX_CELL_GAP_Y;
  // 列数取「最挤的那个象限」，四个象限同宽，十字分界线才是直的
  const cols = Math.max(
    1,
    Math.min(MATRIX_MAX_COLS, Math.max(...quadrants.map((list) => Math.ceil(Math.sqrt(list.length)) || 1))),
  );
  const rows = Math.max(1, Math.max(...quadrants.map((list) => Math.ceil(list.length / cols))));

  const result: LayoutResult[] = [];
  quadrants.forEach((list, index) => {
    const originX = MATRIX_LEFT + (index % 2 === 1 ? cols * cellW + MATRIX_CROSS_GAP : 0);
    const originY = MATRIX_TOP + (index >= 2 ? rows * cellH + MATRIX_CROSS_GAP : 0);
    // 象限内部按 id 定序：反复整理同一块板要落到同一个位置
    [...list]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .forEach((card, at) => {
        result.push({
          id: card.id,
          x: snap(originX + (at % cols) * cellW),
          y: snap(originY + Math.floor(at / cols) * cellH),
        });
      });
  });

  if (loose.length) {
    const originX = MATRIX_LEFT + 2 * cols * cellW + MATRIX_CROSS_GAP + MATRIX_LOOSE_GAP;
    [...loose]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .forEach((card, at) => {
        result.push({ id: card.id, x: snap(originX), y: snap(MATRIX_TOP + at * cellH) });
      });
  }
  return result;
}

/* ── 5.8 泳道：行 × 列的二维分格 ───────────────────
   看板只有列（状态），一眼看得出「到哪一步了」，看不出「这一步里都是些什么东西」。
   泳道把类型摊成行：横着读是一种卡片的流转，竖着读是某个阶段的全部内容。

   **布局只产出坐标，画不了行列标题**，所以行列边界全靠留白说话：
   · 行与行之间的空白 ≈ 格内纵向间距的 5 倍，列与列之间 ≈ 横向间距的 3 倍；
   · 每一行的第一张卡都从同一个 x 起步，每一列的所有行都在同一个 x —— 行首列首各成一条直线；
   · 空行 / 空列不占位，不留下让人猜的空白带。 */

const SWIM_TOP = 40;
const SWIM_LEFT = 40;
/** 列与列之间的留白（远大于格内的 SWIM_CELL_GAP_X） */
const SWIM_COL_GAP = 140;
/** 行与行之间的留白（远大于格内的 SWIM_STACK_GAP） */
const SWIM_ROW_GAP = 180;
/** 一格内部：卡片纵向堆叠时的间距 */
const SWIM_STACK_GAP = 32;
/** 一格内部：横向多列时的间距（格里卡片多到要分列时才用得上） */
const SWIM_CELL_GAP_X = 40;
/** 一格里最多摆几列，再多就把行撑得比屏幕还宽 */
const SWIM_CELL_MAX_COLS = 3;
/** 一格里堆到这个数才开始分内列——**默认单列**，泳道的列边界才是一条干净的线 */
const SWIM_CELL_STACK_MAX = 4;

/** 一格要几个内列：少量卡永远单列，多到堆成长条时才横过来分列。 */
function swimCellCols(count: number): number {
  return count > SWIM_CELL_STACK_MAX ? Math.min(SWIM_CELL_MAX_COLS, Math.ceil(count / SWIM_CELL_STACK_MAX)) : 1;
}

export function swimlaneBoard(cards: BoardCard[], ctx: LayoutContext = {}): LayoutResult[] {
  if (!cards.length) return [];

  const specRank = specRankOf(cards);
  /** cellKey = `行||列`；顺便记下行与列各自的排序键 */
  const cellCards = new Map<string, BoardCard[]>();
  const rowRank = new Map<string, number>();
  const colRank = new Map<string, [number, number, number]>();

  for (const card of cards) {
    const column = kanbanColumnOf(card, ctx, specRank);
    const rowKey = card.type;
    // 行序沿用「按类型分区」那套 groupOrder：同一块板在两种整理里，类型的先后是一致的
    if (!rowRank.has(rowKey)) rowRank.set(rowKey, Math.max(0, GROUP_ORDER.indexOf(card.type)));
    if (!colRank.has(column.key)) colRank.set(column.key, column.rank);
    const cellKey = `${rowKey}||${column.key}`;
    if (!cellCards.has(cellKey)) cellCards.set(cellKey, []);
    cellCards.get(cellKey)!.push(card);
  }

  const rows = [...rowRank.keys()].sort((a, b) => rowRank.get(a)! - rowRank.get(b)! || (a < b ? -1 : 1));
  const columns = [...colRank.keys()].sort((a, b) => {
    const ra = colRank.get(a)!;
    const rb = colRank.get(b)!;
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || (a < b ? -1 : 1);
  });

  // 全板统一的格子宽度：列的左边界要对成一条直线
  const cardW = Math.max(...cards.map((card) => card.w));
  const cellStep = cardW + SWIM_CELL_GAP_X;
  /** 每一列实际要几张卡并排（取该列所有格里最挤的那个） */
  const colInner = new Map<string, number>();
  for (const key of columns) {
    let widest = 1;
    for (const row of rows) {
      const list = cellCards.get(`${row}||${key}`);
      if (!list) continue;
      widest = Math.max(widest, swimCellCols(list.length));
    }
    colInner.set(key, widest);
  }

  // 列的 x 起点：一次算好，所有行共用
  const colX = new Map<string, number>();
  let cursorX = SWIM_LEFT;
  for (const key of columns) {
    colX.set(key, cursorX);
    cursorX += colInner.get(key)! * cellStep - SWIM_CELL_GAP_X + SWIM_COL_GAP;
  }

  const result: LayoutResult[] = [];
  let cursorY = SWIM_TOP;
  for (const row of rows) {
    let rowHeight = 0;
    for (const key of columns) {
      const list = cellCards.get(`${row}||${key}`);
      if (!list?.length) continue;
      const inner = colInner.get(key)!;
      const x0 = colX.get(key)!;
      let cellBottom = 0;
      let lineTop = 0;
      let lineHeight = 0;
      [...list]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .forEach((card, at) => {
          const column = at % inner;
          if (column === 0 && at > 0) {
            lineTop += lineHeight + SWIM_STACK_GAP;
            lineHeight = 0;
          }
          result.push({ id: card.id, x: snap(x0 + column * cellStep), y: snap(cursorY + lineTop) });
          lineHeight = Math.max(lineHeight, card.h);
          cellBottom = Math.max(cellBottom, lineTop + card.h);
        });
      rowHeight = Math.max(rowHeight, cellBottom);
    }
    if (rowHeight) cursorY += rowHeight + SWIM_ROW_GAP;
  }
  return result;
}

/* ── 6. 对齐 / 等距：只动选中的那几张 ──
   这一组的**唯一职责就是「真的齐」**，所以通篇只有一条规矩：
   先把基准线（或起点）吸一次格，再由它反算每张卡的坐标；绝不逐张吸格。

   反过来写（`snap(right - card.w)` 那种）曾经是这里的实现，问题是量化误差跟着宽度走：
   A(w=260) 与 B(w=150) 右对齐到 360，B 会落在 snap(210)=220 → 右缘 370，
   差出 10px。点了「右对齐」却没对齐，是这个功能最不该犯的错。
   `left` / `top` 当年侥幸没露馅——它们给所有卡赋的是同一个值，一起吸当然还在一条线上。 */
export function alignCards(cards: BoardCard[], action: AlignAction): LayoutResult[] {
  if (cards.length < 2) return [];
  const left = Math.min(...cards.map((card) => card.x));
  const right = Math.max(...cards.map((card) => card.x + card.w));
  const top = Math.min(...cards.map((card) => card.y));
  const bottom = Math.max(...cards.map((card) => card.y + card.h));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;

  if (action === "hspace" || action === "vspace") {
    const horizontal = action === "hspace";
    const sorted = [...cards].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    const span = horizontal ? right - left : bottom - top;
    const used = sorted.reduce((sum, card) => sum + (horizontal ? card.w : card.h), 0);
    const gap = sorted.length > 1 ? (span - used) / (sorted.length - 1) : 0;
    // 只有起点吸一次格，之后按精确的 gap 累加：逐张吸格会把间距抖成 gap±半格，
    // 那就不叫等距了——等距要保证的是**相邻间隙彼此相等**，不是每张卡都压在点上。
    let cursor = snap(horizontal ? left : top);
    return sorted.map((card) => {
      const position = { id: card.id, x: card.x, y: card.y };
      if (horizontal) {
        position.x = cursor;
        cursor += card.w + gap;
      } else {
        position.y = cursor;
        cursor += card.h + gap;
      }
      return position;
    });
  }

  // 几何 API 支持小数：保留奇数宽高的半像素中心，不再逐卡取整。
  // 六个方向各自的基准线，先吸格，后面所有卡都从它反算
  const lineLeft = snap(left);
  const lineRight = snap(right);
  const lineTop = snap(top);
  const lineBottom = snap(bottom);
  const lineCx = snap(cx);
  const lineCy = snap(cy);

  return cards.map((card) => {
    const position = { id: card.id, x: card.x, y: card.y };
    if (action === "left") position.x = lineLeft;
    if (action === "right") position.x = lineRight - card.w;
    if (action === "hcenter") position.x = lineCx - card.w / 2;
    if (action === "top") position.y = lineTop;
    if (action === "bottom") position.y = lineBottom - card.h;
    if (action === "vcenter") position.y = lineCy - card.h / 2;
    return position;
  });
}

/** 统一入口：整齐化保结构，其余几种会重排整块板。 */
/**
 * 十一种整理模式的统一入口（清单与文案见上面的 LAYOUT_MODES）。
 *
 * 异步是为了「分层重排」与「子图分簇」——只有它们要 dagre，而 dagre 是个不小的包。
 * 日常用的整齐化 / 流程 / 分区 / 网格 / 时间线 / 看板 / 四象限 / 泳道全是纯计算，
 * 不该让每个人的首屏为它买单，所以真按到那两项时才 import（见 lib/layout-dagre.ts）。
 */
/**
 * 整理会重排哪些卡：**自由卡**——分组框本身与被它圈住的卡一律跳过。
 *
 * 为什么这么定（三种做法里挑一种）：
 *  · 「框与子卡当成一个整体参与摆位」最漂亮，但布局是纯几何计算，要理解父子关系就得
 *    先算出每个框的包围盒、把它当成一个超级节点、摆完再把子卡按相对位置搬回去——
 *    十一种模式各自都要改一遍，而 timeline / kanban / matrix 这些「按字段分列」的模式
 *    根本回答不了「一个框该归到哪一列」；
 *  · 「连框带子卡一起打散重排」最省事，但那等于每次整理都把用户手工圈出来的分区拆掉——
 *    分组框存在的意义就是「这一摊别动」；
 *  · 所以取第三种：**框里的东西整理不碰**，框外的自由卡照常重排。行为确定、十一种模式
 *    口径一致、也符合直觉——想让框里的卡重新摆，先把它们拖出来。
 *
 * 连线也要跟着筛：两端有一端被跳过的线不该参与分层 / 分簇的计算，
 * 否则 dagre 会为一个不在结果里的节点留出一整层空位。
 */
function layoutScope(cards: BoardCard[], edges: BoardEdge[]): { cards: BoardCard[]; edges: BoardEdge[] } {
  const frames = new Set(cards.filter((card) => card.type === "frame").map((card) => card.id));
  const free = cards.filter((card) => card.type !== "frame" && !frames.has(card.frameId || ""));
  if (free.length === cards.length) return { cards, edges };
  const ids = new Set(free.map((card) => card.id));
  return { cards: free, edges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) };
}

/** All modes preserve fixed frames, stay within the persisted coordinate domain,
 * and translate free cards together if a fresh layout would cover a fixed region. */
function finishLayout(cards: BoardCard[], result: LayoutResult[], fixed: BoardCard[]): LayoutResult[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const within = (places: LayoutResult[]) => places.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 100_000 && Math.abs(p.y) <= 100_000);
  if (result.length !== cards.length || new Set(result.map((p) => p.id)).size !== cards.length || result.some((p) => !byId.has(p.id))) {
    throw new RangeError("整理结果不完整，未修改画板");
  }
  const boxes = result.map((p) => ({ ...byId.get(p.id)!, ...p }));
  if (boxes.some((c) => !Number.isFinite(c.w) || !Number.isFinite(c.h) || c.w <= 0 || c.h <= 0) || !within(result)) {
    throw new RangeError("整理范围超出画布支持的坐标，请减少卡片或拆成子画板后重试");
  }
  const overlaps = (a: BoardCard, b: BoardCard) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const colliding = fixed.filter((obstacle) => boxes.some((box) => overlaps(box, obstacle)));
  if (!colliding.length) return result;
  const bounds = (items: BoardCard[]) => items.reduce((b, c) => ({ left: Math.min(b.left, c.x), top: Math.min(b.top, c.y), right: Math.max(b.right, c.x + c.w), bottom: Math.max(b.bottom, c.y + c.h) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const from = bounds(boxes);
  const ceil = (v: number) => Math.ceil(v / SNAP_GRID) * SNAP_GRID;
  const floor = (v: number) => Math.floor(v / SNAP_GRID) * SNAP_GRID;
  // 优先绕开实际冲突区域；远处无关的框不应迫使整组横跨整块画布。
  // 全部固定区的包围盒仍作为兜底，每个候选都再针对真实障碍逐一验碰撞。
  const shifts = [bounds(colliding), bounds(fixed)].flatMap((obstacles) => [
    { x: ceil(obstacles.right + GAP_X - from.left), y: 0 },
    { x: 0, y: ceil(obstacles.bottom + GAP_Y - from.top) },
    { x: floor(obstacles.left - GAP_X - from.right), y: 0 },
    { x: 0, y: floor(obstacles.top - GAP_Y - from.bottom) },
  ]).sort((a, b) => Math.abs(a.x) + Math.abs(a.y) - Math.abs(b.x) - Math.abs(b.y));
  for (const shift of shifts) {
    const places = result.map((p) => ({ ...p, x: p.x + shift.x, y: p.y + shift.y }));
    if (within(places) && boxes.every((box) => {
      const moved = { ...box, x: box.x + shift.x, y: box.y + shift.y };
      return !fixed.some((obstacle) => overlaps(moved, obstacle));
    })) return places;
  }
  throw new RangeError("固定分组框附近没有足够空间，请拆分画板或移动分组框后再整理");
}

export async function runLayout(
  rawCards: BoardCard[],
  rawEdges: BoardEdge[],
  mode: TidyMode,
  ctx: LayoutContext = {},
): Promise<LayoutResult[]> {
  const { cards, edges } = layoutScope(rawCards, rawEdges);
  if (!cards.length) return [];
  let result: LayoutResult[];
  if (mode === "tidy") result = tidyBoard(cards, edges);
  else if (mode === "flow") result = flowBoard(cards, edges);
  else if (mode === "group") result = groupBoard(cards);
  else if (mode === "grid") result = gridBoard(cards);
  else if (mode === "timeline") result = timelineBoard(cards, ctx);
  else if (mode === "kanban") result = kanbanBoard(cards, ctx);
  else if (mode === "matrix") result = matrixBoard(cards, edges, ctx);
  else if (mode === "swimlane") result = swimlaneBoard(cards, ctx);
  else if (mode === "cluster") {
    const { clusterBoard } = await import("./layout-dagre");
    result = clusterBoard(cards, edges);
  } else if (mode === "LR" || mode === "TB") {
    const { layoutBoard } = await import("./layout-dagre");
    result = layoutBoard(cards, edges, mode);
  } else throw new RangeError("未知整理模式");
  const freeIds = new Set(cards.map((card) => card.id));
  const fixed = rawCards.filter((card) => !freeIds.has(card.id));
  return finishLayout(cards, result, fixed);
}

/* ── 7. 阅读顺序：把二维摆放压成一维序列 ── */

/** 顶边差在这个范围内算「并排」：同一排的卡按 x 从左往右读 */
const ROW_MIN_BAND = 80;
/** 行带也跟首卡高度走——一张 320 高的图旁边挂着偏 120px 的小卡，肉眼仍是同一排 */
const ROW_BAND_RATIO = 0.5;

/** 阅读顺序认得出的最小卡片形状：几何 + 分组归属 + 显式例外 */
export interface ReadableCard {
  id: string;
  x: number;
  y: number;
  h: number;
  type?: string;
  frameId?: string | null;
  reading?: { skip?: boolean; order?: number | null };
}

/** 纯几何的那一半：从上到下、同排从左到右 */
function geometricOrder<T extends ReadableCard>(cards: readonly T[]): T[] {
  const sorted = [...cards].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: { limit: number; items: T[] }[] = [];
  for (const card of sorted) {
    const row = rows[rows.length - 1];
    // 行带只由「行首那张卡」定，不让后进来的卡把带子一路往下撑——
    // 否则阶梯状摆放会被串成一整行。
    if (row && card.y < row.limit) row.items.push(card);
    else rows.push({ limit: card.y + Math.max(ROW_MIN_BAND, card.h * ROW_BAND_RATIO), items: [card] });
  }
  return rows.flatMap((row) => row.items.sort((a, b) => a.x - b.x || a.y - b.y));
}

/**
 * 显式序号排在几何前面：设了 `reading.order` 的卡按序号排到最前，没设的仍按几何跟在后面。
 *
 * 用稳定排序（JS 的 Array#sort 保证稳定），所以没编号的那批相对顺序**逐张不变**——
 * 一张都没编号时，这一步是彻底的恒等变换。
 */
function applyExplicitOrder<T extends ReadableCard>(order: T[]): T[] {
  if (!order.some((card) => typeof card.reading?.order === "number")) return order;
  return [...order].sort((a, b) => {
    const ax = typeof a.reading?.order === "number" ? a.reading.order : Number.POSITIVE_INFINITY;
    const bx = typeof b.reading?.order === "number" ? b.reading.order : Number.POSITIVE_INFINITY;
    return ax - bx;
  });
}

/**
 * 阅读顺序：从上到下，同一排从左到右（跟中文读版面的习惯一致）。
 *
 * 不按连线算顺序：连线只覆盖画板上一部分卡，孤立的卡会整批漏掉；
 * 而「摆在哪」是用户自己排的版，本来就带着他心里的先后。
 *
 * 在这条基本盘上面叠了两件事，**两件都只在用户自己设了东西时才生效**：
 * ① **分组框是章节**：框里的卡跟着它的框走，读完一个框再读下一个。
 *    没有框的板子（或者框里一张卡都没有的板子）走的还是原来那条纯几何的路。
 *    这条不需要用户配置——框本来就是他手工圈的一块地，读的时候把它读成一节，
 *    比让框里的卡跟框外的卡按 y 坐标交叉着读更接近他圈框时的意思。
 * ② **显式序号**：`reading.order` 把几张卡钉到最前面（见 lib/types.ts 的 CardReading）。
 *
 * 不变量：**输出与输入等长，一张不丢**——归属指向不存在的框、或指向不是框的卡，
 * 那张卡按自由卡处理，不会因为找不到章节就从序列里消失。
 */
export function readingOrder<T extends ReadableCard>(cards: T[]): T[] {
  const frames = new Set(cards.filter((card) => card.type === "frame").map((card) => card.id));
  const members = new Map<string, T[]>();
  const top: T[] = [];
  for (const card of cards) {
    // 悬空归属（框被删了 / 指向的不是框）按自由卡走：宁可顺序退回几何，也不能把卡读丢
    if (card.frameId && frames.has(card.frameId) && card.frameId !== card.id) {
      const bucket = members.get(card.frameId);
      if (bucket) bucket.push(card);
      else members.set(card.frameId, [card]);
    } else {
      top.push(card);
    }
  }
  if (!members.size) return applyExplicitOrder(geometricOrder(top));
  return applyExplicitOrder(geometricOrder(top)).flatMap((card) => {
    const bucket = members.get(card.id);
    return bucket ? [card, ...applyExplicitOrder(geometricOrder(bucket))] : [card];
  });
}

/**
 * 序列里每一张卡属于哪一「章」（= 它归属的那个分组框）。
 * 没有框的板子返回一张空表，调用方照旧按平铺渲染。
 */
export function readingChapters<T extends ReadableCard>(cards: readonly T[]): Map<string, string> {
  const frames = new Set(cards.filter((card) => card.type === "frame").map((card) => card.id));
  const chapters = new Map<string, string>();
  for (const card of cards) {
    if (card.frameId && frames.has(card.frameId)) chapters.set(card.id, card.frameId);
  }
  return chapters;
}
