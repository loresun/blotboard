/**
 * 模板读盘与实例化。
 *
 * 模板文件是**仓库资产**而不是用户数据：所以它跟着项目根目录走（data/templates/），
 * 不跟 BLOTBOARD_DATA_DIR 走——冒烟测试把数据目录换到临时目录时，模板照样在。
 *
 * 缓存：整目录一份，按「目录 mtime + 各文件 mtime」守卫，改完模板不用重启。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TEMPLATES_DIR } from "./config";
import { badRequest, notFound } from "./http";
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_ID_RE,
  TEMPLATE_LIMITS,
  CATEGORY_META,
  TemplateError,
  isFillable,
  normalizeTemplate,
  templateListItem,
  type Template,
  type TemplateCategory,
  type TemplateListItem,
} from "./template-schema";
import { FILL_MARK } from "./template-fill";

interface CacheEntry {
  dir: string;
  /** 文件名 → mtimeMs，任何一项变了就整目录重读 */
  stamps: string;
  templates: Template[];
}

let cache: CacheEntry | null = null;

function stampOf(dir: string, files: string[]): string {
  return files
    .map((file) => {
      try {
        return `${file}:${fs.statSync(path.join(dir, file)).mtimeMs}`;
      } catch {
        return `${file}:gone`;
      }
    })
    .join("|");
}

function listFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json") && !file.startsWith("."))
      .sort();
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

function readAll(): Template[] {
  const dir = TEMPLATES_DIR;
  const files = listFiles(dir);
  const stamps = stampOf(dir, files);
  if (cache && cache.dir === dir && cache.stamps === stamps) return cache.templates;

  const templates: Template[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const size = fs.statSync(full).size;
    if (size > TEMPLATE_LIMITS.fileBytes) {
      throw new TemplateError(`模板 ${file}：文件 ${size} 字节，超过上限 ${TEMPLATE_LIMITS.fileBytes}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (err) {
      throw new TemplateError(`模板 ${file}：不是合法 JSON（${(err as Error).message}）`);
    }
    templates.push(normalizeTemplate(raw, file.replace(/\.json$/, "")));
  }
  // 分类内按名称排，分类之间按 TEMPLATE_CATEGORIES 的顺序——列表顺序稳定，不跟文件系统走
  templates.sort((a, b) => {
    const byCategory = TEMPLATE_CATEGORIES.indexOf(a.category) - TEMPLATE_CATEGORIES.indexOf(b.category);
    return byCategory !== 0 ? byCategory : a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  cache = { dir, stamps, templates };
  return templates;
}

export function listTemplates(): TemplateListItem[] {
  return readAll().map(templateListItem);
}

export function getTemplate(id: string): Template {
  if (!TEMPLATE_ID_RE.test(id || "")) throw badRequest("模板 id 无效");
  const found = readAll().find((template) => template.id === id);
  if (!found) throw notFound("模板不存在");
  return found;
}

export function listCategories(): { id: TemplateCategory; label: string; hint: string; count: number }[] {
  const templates = readAll();
  return TEMPLATE_CATEGORIES.map((id) => ({
    id,
    label: CATEGORY_META[id].label,
    hint: CATEGORY_META[id].hint,
    count: templates.filter((template) => template.category === id).length,
  }));
}

/** 测试钩子：丢掉目录缓存 */
export function resetTemplateCache(): void {
  cache = null;
}

/* ── 实例化 ───────────────────────────────────────── */

/**
 * 模板内的 kebab id → 画板卡片 id。
 *
 * 形状 `c_{模板}_{本次实例}_{卡片}`：模板名留着是为了在 JSON 里一眼看出这批卡从哪来，
 * 中间那段随机码是「同一个模板往同一块板插两次不能撞 id」的那道保险。
 */
function idMapper(templateId: string): (localId: string) => string {
  const run = crypto.randomBytes(3).toString("hex");
  const slug = (text: string) => text.replace(/-/g, "_");
  return (localId: string) => `c_${slug(templateId)}_${run}_${slug(localId)}`;
}

export interface InstantiateOptions {
  offsetX?: number;
  offsetY?: number;
}

export interface Instantiated {
  /** 直接喂 normalizeCardInput 的卡片入参 */
  cards: Record<string, unknown>[];
  edges: { from: string; to: string; label?: string; kind?: string; color?: unknown; style?: unknown; width?: unknown }[];
  /** 模板内 id → 落板 id，插入后要定位/回报时用 */
  idMap: Record<string, string>;
  fillableIds: string[];
}

/**
 * 把模板摊成一批「可以直接建的卡片 + 连线」。
 *
 * fillPrompt 落到卡片的 agentPrompt 上（带 FILL_MARK 前缀），不新增卡片字段：
 * 画板本来就有「卡片级 agent 指令」这个概念，模板填充只是它的一个用法。
 */
export function instantiate(template: Template, { offsetX = 0, offsetY = 0 }: InstantiateOptions = {}): Instantiated {
  const mapId = idMapper(template.id);
  const idMap: Record<string, string> = {};
  for (const card of template.cards) idMap[card.id] = mapId(card.id);

  const cards = template.cards.map((card, index) => {
    const payload: Record<string, unknown> = {
      id: idMap[card.id],
      type: card.type,
      title: card.title,
      content: card.content || "",
      x: card.x + offsetX,
      y: card.y + offsetY,
      w: card.w,
      h: card.h,
      z: index + 1,
      color: card.color || "slate",
      createdBy: "user",
    };
    if (isFillable(card)) payload.agentPrompt = `${FILL_MARK}${card.fillPrompt}`;
    for (const field of ["task", "todo", "mindmap", "svg", "mermaid", "quote", "link"] as const) {
      if (card[field]) payload[field] = card[field];
    }
    return payload;
  });

  const edges = template.edges.map((edge) => ({
    from: idMap[edge.from],
    to: idMap[edge.to],
    label: edge.label,
    kind: edge.kind,
    color: edge.color,
    style: edge.style,
    width: edge.width,
  }));

  return {
    cards,
    edges,
    idMap,
    fillableIds: template.cards.filter(isFillable).map((card) => idMap[card.id]),
  };
}
