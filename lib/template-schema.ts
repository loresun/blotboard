/**
 * 模板数据模型与校验（模板中心）。
 *
 * 模板 = 一份可复用的画板骨架：若干卡片 + 连线 + 视口 + 可填充提示词。
 * 文件放 data/templates/*.json，随仓库走（不是用户数据），只读暴露、不可写。
 *
 * 校验风格跟 lib/board-schema.ts 反着来，是有意的：
 * 画板数据来自用户与 agent，规则是「强制 clamp + 兜底」，怎么都要收下；
 * 模板是仓库自带的代码资产，写错了应该在启动/请求时**大声报错**而不是被悄悄兜底成一张空卡——
 * 所以这里一律 throw，且错误里带上文件名与卡片 id，改模板的人一眼知道哪行写错了。
 */
import { BOARD_CARD_TYPES, CARD_COLORS, EDGE_KINDS, EDGE_STYLES, type CardColor, type CardType, type EdgeKind, type EdgeStyle } from "./types";
import { TEMPLATE_ICON_NAMES } from "./icon-names";
import type { DictKey } from "./i18n";

export const TEMPLATE_CATEGORIES = ["topic", "mental", "sop", "flow"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/**
 * 分类的中文名与解释。**这张表仍是中文**：`listTemplateCategories()` 把它拼进接口返回
 * （lib/template-store.ts），那条路上没有「当前界面语言」。界面上那一份走 `CATEGORY_KEY`。
 */
export const CATEGORY_META: Record<TemplateCategory, { label: string; hint: string }> = {
  topic: { label: "选题方法", hint: "把一个题目发散成一板可选的角度" },
  mental: { label: "思维模型", hint: "拆本质、找根因、做决策的经典框架" },
  sop: { label: "诊断 · SOP", hint: "反复要走的固定流程，照着填就行" },
  flow: { label: "流程骨架", hint: "一件事从立项到产出的骨架" },
};

/** CATEGORY_META 的界面那一份（模板中心的分类筛与徽标）。 */
export const CATEGORY_KEY: Record<TemplateCategory, { label: DictKey; hint: DictKey }> = {
  topic: { label: "canvas.template.category.topic", hint: "canvas.template.category.topic.hint" },
  mental: { label: "canvas.template.category.mental", hint: "canvas.template.category.mental.hint" },
  sop: { label: "canvas.template.category.sop", hint: "canvas.template.category.sop.hint" },
  flow: { label: "canvas.template.category.flow", hint: "canvas.template.category.flow.hint" },
};

/**
 * 模板里能用的卡片类型：需要上传文件（image/pdf）、需要外部主键（ref）、
 * 需要指向另一块板（board）的三类排除在外——它们没法在「一键应用」时凭空生成。
 * Excalidraw 卡同理：空白卡没意义，等用户保存了 source/thumbnail 才有内容——
 * 模板里要发骨架也只是一张空壳，所以也不在模板白名单里。
 */
export const TEMPLATE_CARD_TYPES = ["text", "task", "todo", "mindmap", "svg", "mermaid", "quote", "link"] as const;
export type TemplateCardType = (typeof TEMPLATE_CARD_TYPES)[number];

export const TEMPLATE_LIMITS = {
  /** 单模板卡片数上限（spec §11：别让模板把画板撑爆） */
  cards: 24,
  /** 模板自带正文上限——模板给的是骨架与提示，不是长文 */
  content: 500,
  /** 每张卡的填充提示词上限 */
  fillPrompt: 600,
  /** 整套模板的 agent 提示词上限 */
  agentPrompt: 2000,
  title: 60,
  name: 40,
  description: 120,
  tags: 8,
  tag: 12,
  /** 单个模板文件大小上限（读盘时校验，防止有人把长文塞进模板） */
  fileBytes: 64 * 1024,
} as const;

/** 模板内卡片 id：kebab-case，应用时会被改写成 c_xxx */
const LOCAL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 模板 id：kebab-case，必须与文件名一致 */
export const TEMPLATE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface TemplateCard {
  id: string;
  type: TemplateCardType;
  title: string;
  content?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: CardColor;
  /** 类型专属字段：形状与 BoardCard 同名字段一致，落板时交给 normalizeCardInput 兜底 */
  task?: Record<string, unknown>;
  todo?: Record<string, unknown>;
  mindmap?: Record<string, unknown>;
  svg?: Record<string, unknown>;
  mermaid?: Record<string, unknown>;
  quote?: Record<string, unknown>;
  link?: Record<string, unknown>;
  /** 是否参与「AI 填充」；写了 fillPrompt 默认就是 true */
  fillable?: boolean;
  /** 这张卡要 agent 填什么；落板后写进卡片的 agentPrompt（带【模板待填】标记） */
  fillPrompt?: string;
}

export interface TemplateEdge {
  from: string;
  to: string;
  label?: string;
  kind?: EdgeKind;
  color?: CardColor | null;
  style?: EdgeStyle | null;
  width?: number | null;
}

export interface Template {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  icon: string;
  tags: string[];
  cards: TemplateCard[];
  edges: TemplateEdge[];
  viewport: { x: number; y: number; zoom: number };
  /** 「AI 填充」派给 Goal Agent 的整体说明（逐卡提示词在 card.fillPrompt） */
  agentPrompt?: string;
}

/** 列表项：去掉 cards/edges/viewport/agentPrompt，只留挑模板要看的那几项 + 统计 */
export interface TemplateListItem {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  icon: string;
  tags: string[];
  counts: { cards: number; edges: number; fillable: number };
  /** 几何缩略（前端画预览用，几百字节） */
  shape: { x: number; y: number; w: number; h: number; color: CardColor }[];
  /** 缩略里的连线：中心点连线，跟 /preview 一个形状 */
  links: { x1: number; y1: number; x2: number; y2: number }[];
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

function fail(where: string, message: string): never {
  throw new TemplateError(`模板 ${where}：${message}`);
}

function str(value: unknown, max: number, where: string, field: string, { required = false } = {}): string {
  if (value === undefined || value === null) {
    if (required) fail(where, `缺 ${field}`);
    return "";
  }
  if (typeof value !== "string") fail(where, `${field} 必须是字符串`);
  const text = (value as string).replace(/\x00/g, "").trim();
  if (!text && required) fail(where, `${field} 不能为空`);
  if (text.length > max) fail(where, `${field} 超长（${text.length} > ${max}）`);
  return text;
}

function num(value: unknown, where: string, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(where, `${field} 必须是数字`);
  const n = value as number;
  if (n < min || n > max) fail(where, `${field} 超出范围 [${min}, ${max}]：${n}`);
  return n;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], where: string, field: string, fallback?: T): T {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    fail(where, `缺 ${field}`);
  }
  if (!allowed.includes(value as T)) fail(where, `${field} 只能是 ${allowed.join(" / ")}，收到 ${String(value)}`);
  return value as T;
}

function normalizeCard(raw: any, where: string): TemplateCard {
  if (!raw || typeof raw !== "object") fail(where, "卡片必须是对象");
  const id = str(raw.id, 40, where, "card.id", { required: true });
  if (!LOCAL_ID_RE.test(id)) fail(where, `card.id「${id}」不是 kebab-case`);
  const spot = `${where} · 卡片 ${id}`;
  const type = pick<TemplateCardType>(raw.type, TEMPLATE_CARD_TYPES, spot, "type");
  // 白名单之外的类型给一句明确的话，别让人对着「只能是 text/task…」猜为什么 ref 不行
  if ((BOARD_CARD_TYPES as readonly string[]).includes(raw.type) && !(TEMPLATE_CARD_TYPES as readonly string[]).includes(raw.type)) {
    fail(spot, `type=${raw.type} 需要上传/外部主键，模板里造不出来`);
  }

  const card: TemplateCard = {
    id,
    type,
    title: str(raw.title, TEMPLATE_LIMITS.title, spot, "title", { required: true }),
    x: num(raw.x, spot, "x", -20_000, 20_000),
    y: num(raw.y, spot, "y", -20_000, 20_000),
    w: num(raw.w, spot, "w", 140, 1600),
    h: num(raw.h, spot, "h", 80, 2400),
  };
  const content = str(raw.content, TEMPLATE_LIMITS.content, spot, "content");
  if (content) card.content = content;
  if (raw.color !== undefined) card.color = pick<CardColor>(raw.color, CARD_COLORS, spot, "color");

  for (const field of ["task", "todo", "mindmap", "svg", "mermaid", "quote", "link"] as const) {
    if (raw[field] === undefined) continue;
    if (!raw[field] || typeof raw[field] !== "object") fail(spot, `${field} 必须是对象`);
    // 类型专属字段只认「跟卡片类型对得上」的那个，糊错地方的字段读不到、纯脏数据
    if (field !== type) fail(spot, `type=${type} 的卡片不该带 ${field} 字段`);
    card[field] = raw[field] as Record<string, unknown>;
  }

  const fillPrompt = str(raw.fillPrompt, TEMPLATE_LIMITS.fillPrompt, spot, "fillPrompt");
  if (fillPrompt) card.fillPrompt = fillPrompt;
  if (raw.fillable !== undefined) {
    if (typeof raw.fillable !== "boolean") fail(spot, "fillable 必须是布尔");
    card.fillable = raw.fillable;
  }
  if (card.fillable && !fillPrompt) fail(spot, "fillable=true 但没写 fillPrompt");
  return card;
}

/** 写了 fillPrompt 且没显式关掉的卡，就是「等 agent 填」的卡 */
export function isFillable(card: TemplateCard): boolean {
  return Boolean(card.fillPrompt) && card.fillable !== false;
}

function normalizeEdge(raw: any, where: string, ids: Set<string>, seen: Set<string>): TemplateEdge {
  if (!raw || typeof raw !== "object") fail(where, "连线必须是对象");
  const from = str(raw.from, 40, where, "edge.from", { required: true });
  const to = str(raw.to, 40, where, "edge.to", { required: true });
  const spot = `${where} · 连线 ${from}→${to}`;
  if (!ids.has(from)) fail(spot, `from 指向不存在的卡片「${from}」`);
  if (!ids.has(to)) fail(spot, `to 指向不存在的卡片「${to}」`);
  if (from === to) fail(spot, "两端不能是同一张卡片");
  const key = `${from}→${to}`;
  if (seen.has(key)) fail(spot, "重复连线");
  seen.add(key);

  const edge: TemplateEdge = { from, to };
  const label = str(raw.label, 60, spot, "label");
  if (label) edge.label = label;
  if (raw.kind !== undefined) edge.kind = pick<EdgeKind>(raw.kind, EDGE_KINDS, spot, "kind");
  if (raw.style !== undefined && raw.style !== null) edge.style = pick<EdgeStyle>(raw.style, EDGE_STYLES, spot, "style");
  if (raw.color !== undefined && raw.color !== null) edge.color = pick<CardColor>(raw.color, CARD_COLORS, spot, "color");
  if (raw.width !== undefined && raw.width !== null) edge.width = num(raw.width, spot, "width", 1, 3);
  return edge;
}

/**
 * 严格校验一份模板 JSON。fileId = 文件名（不含扩展名），必须与 json 里的 id 一致——
 * 不一致的话「按 id 取模板」和「按文件名找文件」就会指到两个东西上。
 */
export function normalizeTemplate(raw: any, fileId: string): Template {
  const where = `${fileId}.json`;
  if (!raw || typeof raw !== "object") fail(where, "顶层必须是对象");
  const id = str(raw.id, 40, where, "id", { required: true });
  if (!TEMPLATE_ID_RE.test(id)) fail(where, `id「${id}」不是 kebab-case`);
  if (id !== fileId) fail(where, `id「${id}」与文件名「${fileId}」不一致`);

  const category = pick<TemplateCategory>(raw.category, TEMPLATE_CATEGORIES, where, "category");
  const icon = pick(raw.icon, TEMPLATE_ICON_NAMES, where, "icon");

  const rawTags = raw.tags === undefined ? [] : raw.tags;
  if (!Array.isArray(rawTags)) fail(where, "tags 必须是数组");
  if (rawTags.length > TEMPLATE_LIMITS.tags) fail(where, `tags 最多 ${TEMPLATE_LIMITS.tags} 个`);
  const tags = rawTags.map((tag) => str(tag, TEMPLATE_LIMITS.tag, where, "tags[]", { required: true }));

  if (!Array.isArray(raw.cards) || !raw.cards.length) fail(where, "cards 必须是非空数组");
  if (raw.cards.length > TEMPLATE_LIMITS.cards) fail(where, `卡片数 ${raw.cards.length} 超过上限 ${TEMPLATE_LIMITS.cards}`);
  const cards = raw.cards.map((card: unknown) => normalizeCard(card, where));
  const ids = new Set<string>();
  for (const card of cards) {
    if (ids.has(card.id)) fail(where, `卡片 id 重复：${card.id}`);
    ids.add(card.id);
  }

  const rawEdges = raw.edges === undefined ? [] : raw.edges;
  if (!Array.isArray(rawEdges)) fail(where, "edges 必须是数组");
  const seen = new Set<string>();
  const edges = rawEdges.map((edge: unknown) => normalizeEdge(edge, where, ids, seen));

  const viewport = raw.viewport ?? { x: 0, y: 0, zoom: 1 };
  if (!viewport || typeof viewport !== "object") fail(where, "viewport 必须是对象");

  return {
    id,
    name: str(raw.name, TEMPLATE_LIMITS.name, where, "name", { required: true }),
    category,
    description: str(raw.description, TEMPLATE_LIMITS.description, where, "description", { required: true }),
    icon,
    tags,
    cards,
    edges,
    viewport: {
      x: num(viewport.x ?? 0, where, "viewport.x", -20_000, 20_000),
      y: num(viewport.y ?? 0, where, "viewport.y", -20_000, 20_000),
      zoom: num(viewport.zoom ?? 1, where, "viewport.zoom", 0.2, 3),
    },
    agentPrompt: str(raw.agentPrompt, TEMPLATE_LIMITS.agentPrompt, where, "agentPrompt") || undefined,
  };
}

/** 列表项：给抽屉列表用，带几何缩略但不带正文 */
export function templateListItem(template: Template): TemplateListItem {
  const byId = new Map(template.cards.map((card) => [card.id, card]));
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    description: template.description,
    icon: template.icon,
    tags: template.tags,
    counts: {
      cards: template.cards.length,
      edges: template.edges.length,
      fillable: template.cards.filter(isFillable).length,
    },
    shape: template.cards.map((card) => ({
      x: card.x,
      y: card.y,
      w: card.w,
      h: card.h,
      color: card.color || "slate",
    })),
    links: template.edges.flatMap((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return [];
      return [{ x1: from.x + from.w / 2, y1: from.y + from.h / 2, x2: to.x + to.w / 2, y2: to.y + to.h / 2 }];
    }),
  };
}

export type { CardType, CardColor };
