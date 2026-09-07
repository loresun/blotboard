/**
 * 卡片规格（Card Spec）——数据模型、严格校验、JSON Schema 生成、字段值归一化。
 *
 * 一份规格 = 一类「外部卡片」的说明书：字段有哪些、什么类型、怎么在卡面上显示。
 * 画板上的 `data` 卡片就是「按某份规格填好的一份数据」。加一种新卡片形式 =
 * 往 data/card-specs/ 里放一个 json，不用改前端、不用改后端、不用重启。
 *
 * 两套校验，方向是反的（跟模板中心同一条思路）：
 *  · **规格文件**是资产，写错了要**大声报错**并指明文件与字段 → 这里一律 throw；
 *  · **卡片数据**来自外部系统，形状不可控 → normalizeSpecValues 只清洗与报告，
 *    由调用方决定是「严格拒收」（信封导入）还是「先收下再说」（PATCH 单卡）。
 */
import { CARD_COLORS, type CardColor, type DataScalar, type DataValue } from "./types";
import type { DictKey } from "./i18n";
import { CARD_METAS } from "./card-metas";
import { SPEC_ICON_NAMES } from "./icon-names";

export const SPEC_CATEGORIES = ["external", "record", "insight"] as const;
export type SpecCategory = (typeof SPEC_CATEGORIES)[number];

/**
 * 分类的中文名与解释。**这张表仍是中文**：`listSpecCategories()` 把它拼进接口返回
 * （lib/card-spec-store.ts），那条路上没有「当前界面语言」。界面上要跟着语言换的那一份
 * 走下面的 `SPEC_CATEGORY_KEY`。
 */
export const SPEC_CATEGORY_META: Record<SpecCategory, { label: string; hint: string }> = {
  external: { label: "外部对接", hint: "飞书 / 公众号 / GitHub 这类系统同步过来的卡片" },
  record: { label: "结构化记录", hint: "自己按固定字段记的东西：会议、决策、联系人…" },
  insight: { label: "指标与洞察", hint: "带数字与口径的卡片，摆在一起看趋势" },
};

/** SPEC_CATEGORY_META 的界面那一份（规格中心的分类筛与徽标）。 */
export const SPEC_CATEGORY_KEY: Record<SpecCategory, { label: DictKey; hint: DictKey }> = {
  external: { label: "canvas.spec.category.external", hint: "canvas.spec.category.external.hint" },
  record: { label: "canvas.spec.category.record", hint: "canvas.spec.category.record.hint" },
  insight: { label: "canvas.spec.category.insight", hint: "canvas.spec.category.insight.hint" },
};

/**
 * 字段类型。刻意只有九种、且不支持嵌套对象：
 * 卡片要能在一张 320px 的卡面上一眼看完，也要能在表单里手改——
 * 真需要嵌套的东西（一整份文档、一棵树）应该另开一张卡，或者用 list 摊平成表格。
 */
export const SPEC_FIELD_TYPES = ["text", "longtext", "number", "bool", "date", "url", "enum", "tags", "list"] as const;
export type SpecFieldType = (typeof SPEC_FIELD_TYPES)[number];

/** 同 SPEC_CATEGORY_META：这一份留给给 agent 的规格说明书（specPromptBlock），恒中文。 */
export const SPEC_FIELD_TYPE_LABEL: Record<SpecFieldType, string> = {
  text: "短文本",
  longtext: "长文本",
  number: "数字",
  bool: "是否",
  date: "时间",
  url: "链接",
  enum: "单选",
  tags: "标签组",
  list: "条目表",
};

/** SPEC_FIELD_TYPE_LABEL 的界面那一份（规格详情里的字段类型）。 */
export const SPEC_FIELD_TYPE_KEY: Record<SpecFieldType, DictKey> = {
  text: "canvas.spec.fieldType.text",
  longtext: "canvas.spec.fieldType.longtext",
  number: "canvas.spec.fieldType.number",
  bool: "canvas.spec.fieldType.bool",
  date: "canvas.spec.fieldType.date",
  url: "canvas.spec.fieldType.url",
  enum: "canvas.spec.fieldType.enum",
  tags: "canvas.spec.fieldType.tags",
  list: "canvas.spec.fieldType.list",
};

/** list 的子字段只允许这四种：表格里塞不下更复杂的东西 */
export const SPEC_SUB_FIELD_TYPES = ["text", "url", "number", "bool"] as const;
export type SpecSubFieldType = (typeof SPEC_SUB_FIELD_TYPES)[number];

export const SPEC_LIMITS = {
  /** 单份规格的字段数上限 */
  fields: 40,
  /** list 的子字段数上限 */
  subFields: 8,
  /** enum 的选项数上限 */
  options: 24,
  /** 字段默认长度上限（规格里可用 max 单独调，但不能超过 hardText） */
  text: 300,
  longtext: 4000,
  hardText: 8000,
  /** tags 条数 / list 行数上限 */
  tags: 20,
  listRows: 50,
  /** 一张规格卡的 fields 序列化后字节上限 */
  cardBytes: 20_000,
  name: 30,
  description: 120,
  hint: 120,
  label: 20,
  key: 40,
  tag: 12,
  tags_: 8,
  /** 单个规格文件大小上限 */
  fileBytes: 32 * 1024,
} as const;

/** 规格 id：kebab-case，且必须与文件名一致 */
export const SPEC_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 字段 key：JS 标识符风格，方便直接写进 JSON Schema 与前端表单 */
export const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const URL_RE = /^https?:\/\/[^\s"'<>]{3,2048}$/i;

export interface SpecFieldOption {
  value: string;
  label: string;
}

export interface SpecSubField {
  key: string;
  label: string;
  type: SpecSubFieldType;
}

export interface SpecField {
  key: string;
  label: string;
  type: SpecFieldType;
  required?: boolean;
  /** 填写说明；也会写进 JSON Schema 的 description，agent 照着填 */
  hint?: string;
  /** text/longtext：字符上限；tags：条数上限；list：行数上限；number：无意义 */
  max?: number;
  /** number 的单位，只用于显示（如「元」「次」「%」） */
  unit?: string;
  /** enum 的可选值 */
  options?: SpecFieldOption[];
  /** list 的列定义 */
  item?: SpecSubField[];
}

/**
 * 卡面显示映射：规格决定「哪个字段当标题、哪个当正文、哪几个做徽标」，
 * 前端只有一套通用渲染器，不给每种规格写组件——这是「插件」而不是「又一种卡片类型」的关键。
 */
export interface SpecDisplay {
  title?: string;
  subtitle?: string;
  body?: string;
  badges: string[];
  link?: string;
  time?: string;
}

export interface CardSpec {
  id: string;
  version: number;
  name: string;
  category: SpecCategory;
  description: string;
  icon: string;
  tags: string[];
  /** 这份规格对接的是哪个系统（显示与筛选用） */
  source?: { app?: string; hint?: string };
  /** 装上就默认可用；实验性规格可以写 false，装上但默认关着 */
  defaultEnabled: boolean;
  card: { w: number; h: number; color: CardColor };
  display: SpecDisplay;
  fields: SpecField[];
  /** 示例数据：既是文档，也是「用示例建一张卡」按钮的数据源 */
  example?: Record<string, unknown>;
  /** 运行时补：builtin = 随仓库走，user = 用户自己放进数据目录的 */
  origin: "builtin" | "user";
}

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

function fail(where: string, message: string): never {
  throw new SpecError(`规格 ${where}：${message}`);
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

function pick<T extends string>(value: unknown, allowed: readonly T[], where: string, field: string, fallback?: T): T {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    fail(where, `缺 ${field}`);
  }
  if (!allowed.includes(value as T)) fail(where, `${field} 只能是 ${allowed.join(" / ")}，收到 ${String(value)}`);
  return value as T;
}

function int(value: unknown, where: string, field: string, min: number, max: number, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    fail(where, `缺 ${field}`);
  }
  const num = Number(value);
  if (!Number.isFinite(num)) fail(where, `${field} 必须是数字`);
  if (num < min || num > max) fail(where, `${field} 超出范围 [${min}, ${max}]：${num}`);
  return Math.round(num);
}

function normalizeField(raw: any, where: string): SpecField {
  if (!raw || typeof raw !== "object") fail(where, "field 必须是对象");
  const key = str(raw.key, SPEC_LIMITS.key, where, "field.key", { required: true });
  if (!FIELD_KEY_RE.test(key)) fail(where, `field.key「${key}」必须是字母开头的标识符（a-zA-Z0-9_）`);
  const spot = `${where} · 字段 ${key}`;
  const type = pick<SpecFieldType>(raw.type, SPEC_FIELD_TYPES, spot, "type");

  const field: SpecField = {
    key,
    label: str(raw.label, SPEC_LIMITS.label, spot, "label", { required: true }),
    type,
  };
  if (raw.required !== undefined) {
    if (typeof raw.required !== "boolean") fail(spot, "required 必须是布尔");
    if (raw.required) field.required = true;
  }
  const hint = str(raw.hint, SPEC_LIMITS.hint, spot, "hint");
  if (hint) field.hint = hint;
  const unit = str(raw.unit, 8, spot, "unit");
  if (unit) {
    if (type !== "number") fail(spot, "unit 只有 number 字段能用");
    field.unit = unit;
  }

  if (raw.max !== undefined) {
    const ceiling =
      type === "tags" ? SPEC_LIMITS.tags : type === "list" ? SPEC_LIMITS.listRows : SPEC_LIMITS.hardText;
    field.max = int(raw.max, spot, "max", 1, ceiling);
  }

  if (type === "enum") {
    const raws = raw.options;
    if (!Array.isArray(raws) || !raws.length) fail(spot, "enum 字段必须给非空 options");
    if (raws.length > SPEC_LIMITS.options) fail(spot, `options 最多 ${SPEC_LIMITS.options} 个`);
    const seen = new Set<string>();
    field.options = raws.map((option: any) => {
      const value =
        typeof option === "string"
          ? str(option, 40, spot, "options[]", { required: true })
          : str(option?.value, 40, spot, "options[].value", { required: true });
      if (seen.has(value)) fail(spot, `options 重复：${value}`);
      seen.add(value);
      const label = typeof option === "string" ? value : str(option?.label, SPEC_LIMITS.label, spot, "options[].label") || value;
      return { value, label };
    });
  } else if (raw.options !== undefined) {
    fail(spot, `type=${type} 的字段不该带 options`);
  }

  if (type === "list") {
    const raws = raw.item;
    if (!Array.isArray(raws) || !raws.length) fail(spot, "list 字段必须给非空 item（列定义）");
    if (raws.length > SPEC_LIMITS.subFields) fail(spot, `item 最多 ${SPEC_LIMITS.subFields} 列`);
    const seen = new Set<string>();
    field.item = raws.map((sub: any) => {
      const subKey = str(sub?.key, SPEC_LIMITS.key, spot, "item[].key", { required: true });
      if (!FIELD_KEY_RE.test(subKey)) fail(spot, `item.key「${subKey}」必须是字母开头的标识符`);
      if (seen.has(subKey)) fail(spot, `item.key 重复：${subKey}`);
      seen.add(subKey);
      return {
        key: subKey,
        label: str(sub?.label, SPEC_LIMITS.label, spot, "item[].label", { required: true }),
        type: pick<SpecSubFieldType>(sub?.type, SPEC_SUB_FIELD_TYPES, spot, "item[].type", "text"),
      };
    });
  } else if (raw.item !== undefined) {
    fail(spot, `type=${type} 的字段不该带 item`);
  }

  return field;
}

function normalizeDisplay(raw: any, where: string, keys: Map<string, SpecField>): SpecDisplay {
  const input = raw && typeof raw === "object" ? raw : {};
  const ref = (name: string, allowed?: SpecFieldType[]): string | undefined => {
    const value = str(input[name], SPEC_LIMITS.key, where, `display.${name}`);
    if (!value) return undefined;
    const field = keys.get(value);
    if (!field) fail(where, `display.${name} 指向不存在的字段「${value}」`);
    if (allowed && !allowed.includes(field.type)) {
      fail(where, `display.${name} 只能指向 ${allowed.join(" / ")} 字段，「${value}」是 ${field.type}`);
    }
    return value;
  };

  const badgesRaw = input.badges === undefined ? [] : input.badges;
  if (!Array.isArray(badgesRaw)) fail(where, "display.badges 必须是数组");
  if (badgesRaw.length > 4) fail(where, "display.badges 最多 4 个（卡面一行放不下更多）");
  const badges = badgesRaw.map((name: unknown) => {
    const key = str(name, SPEC_LIMITS.key, where, "display.badges[]", { required: true });
    if (!keys.has(key)) fail(where, `display.badges 指向不存在的字段「${key}」`);
    return key;
  });

  return {
    title: ref("title", ["text", "url", "enum"]),
    subtitle: ref("subtitle"),
    body: ref("body", ["text", "longtext"]),
    badges,
    link: ref("link", ["url"]),
    time: ref("time", ["date"]),
  };
}

/** 严格校验一份规格 JSON。fileId = 文件名（不含扩展名），必须与 json 里的 id 一致。 */
export function normalizeCardSpec(raw: any, fileId: string, origin: "builtin" | "user" = "builtin"): CardSpec {
  const where = `${fileId}.json`;
  if (!raw || typeof raw !== "object") fail(where, "顶层必须是对象");
  const id = str(raw.id, 40, where, "id", { required: true });
  if (!SPEC_ID_RE.test(id)) fail(where, `id「${id}」不是 kebab-case`);
  if (id !== fileId) fail(where, `id「${id}」与文件名「${fileId}」不一致`);

  const rawTags = raw.tags === undefined ? [] : raw.tags;
  if (!Array.isArray(rawTags)) fail(where, "tags 必须是数组");
  if (rawTags.length > SPEC_LIMITS.tags_) fail(where, `tags 最多 ${SPEC_LIMITS.tags_} 个`);

  if (!Array.isArray(raw.fields) || !raw.fields.length) fail(where, "fields 必须是非空数组");
  if (raw.fields.length > SPEC_LIMITS.fields) fail(where, `字段数 ${raw.fields.length} 超过上限 ${SPEC_LIMITS.fields}`);
  const fields = raw.fields.map((field: unknown) => normalizeField(field, where));
  const byKey = new Map<string, SpecField>();
  for (const field of fields) {
    if (byKey.has(field.key)) fail(where, `字段 key 重复：${field.key}`);
    byKey.set(field.key, field);
  }

  const card = raw.card && typeof raw.card === "object" ? raw.card : {};
  const spec: CardSpec = {
    id,
    version: int(raw.version, where, "version", 1, 9999, 1),
    name: str(raw.name, SPEC_LIMITS.name, where, "name", { required: true }),
    category: pick<SpecCategory>(raw.category, SPEC_CATEGORIES, where, "category"),
    description: str(raw.description, SPEC_LIMITS.description, where, "description", { required: true }),
    icon: pick(raw.icon, SPEC_ICON_NAMES, where, "icon"),
    tags: rawTags.map((tag: unknown) => str(tag, SPEC_LIMITS.tag, where, "tags[]", { required: true })),
    defaultEnabled: raw.defaultEnabled === undefined ? true : raw.defaultEnabled === true,
    card: {
      w: int(card.w, where, "card.w", 140, 1600, 320),
      h: int(card.h, where, "card.h", 80, 2400, 240),
      color: pick<CardColor>(card.color, CARD_COLORS, where, "card.color", "slate"),
    },
    display: normalizeDisplay(raw.display, where, byKey),
    fields,
    origin,
  };

  if (raw.source !== undefined) {
    if (!raw.source || typeof raw.source !== "object") fail(where, "source 必须是对象");
    const app = str(raw.source.app, 40, where, "source.app");
    const hint = str(raw.source.hint, SPEC_LIMITS.hint, where, "source.hint");
    if (app || hint) spec.source = { ...(app ? { app } : {}), ...(hint ? { hint } : {}) };
  }

  if (raw.example !== undefined) {
    if (!raw.example || typeof raw.example !== "object" || Array.isArray(raw.example)) {
      fail(where, "example 必须是对象（字段 key → 值）");
    }
    // 示例也要过一遍字段校验：写歪的示例比没有示例更糟——它会被人照抄
    const checked = normalizeSpecValues(spec, raw.example as Record<string, unknown>);
    if (checked.missing.length) fail(where, `example 缺必填字段：${checked.missing.join("、")}`);
    if (checked.unknown.length) fail(where, `example 里有规格未定义的字段：${checked.unknown.join("、")}`);
    if (checked.issues.length) fail(where, `example 字段有问题：${checked.issues.map((i) => `${i.key}（${i.problem}）`).join("、")}`);
    spec.example = checked.fields;
  }

  return spec;
}

/* ── 字段值归一化 ─────────────────────────────────────── */

/**
 * 字段级问题的两种性质，**文案必须分得开**（真实反馈：agent 传了个非法 enum 值，
 * 却收到「缺必填字段」，照着补了半天也补不对）：
 *  · `invalid`  —— 值给了但不合规，值被丢弃。文案要写清**期望是什么**（enum 列合法值、
 *                  date 说接受格式、url 说必须 http(s)），否则调用方只能瞎猜；
 *  · `adjusted` —— 值收下了，但被截断 / 压缩。提一句就好，不影响落板。
 */
export type FieldIssueKind = "invalid" | "adjusted";

export interface FieldIssue {
  key: string;
  /** 规格里的中文标签，报错文案里跟 key 一起给（agent 按 key 改，人按 label 认） */
  label: string;
  kind: FieldIssueKind;
  problem: string;
}

export interface ValueReport {
  fields: Record<string, DataValue>;
  /** 规格里 required 但**压根没给**的字段（给了但不合规的算 invalid，不算 missing） */
  missing: string[];
  /** 规格里没定义、已被丢弃的字段 */
  unknown: string[];
  /** 值给了但不合规、已被丢弃的字段（含必填与非必填） */
  invalid: FieldIssue[];
  /** invalid + adjusted 的全集，按老形状保留（调用方按 kind 自己分流） */
  issues: FieldIssue[];
}

function cleanString(value: unknown, max: number): string {
  return String(value ?? "").replace(/\x00/g, "").trim().slice(0, max);
}

function toTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // 十位数是秒级时间戳（大量外部系统这么给），补成毫秒
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  const text = String(value).trim();
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** enum 的合法值提示：全列会把报错撑爆，前 8 个 + 总数足够让调用方对上号。 */
function enumHint(field: SpecField): string {
  const options = field.options || [];
  const shown = options.slice(0, 8).map((option) => option.value);
  return `可选：${shown.join(" / ")}${options.length > shown.length ? ` …共 ${options.length} 个` : ""}`;
}

function normalizeOne(field: SpecField, value: unknown, issues: FieldIssue[]): DataValue | undefined {
  /** 值不合规、已丢弃——文案里必须带上「期望是什么」 */
  const reject = (problem: string) => issues.push({ key: field.key, label: field.label, kind: "invalid", problem });
  /** 值收下了但改动过（截断 / 压缩）——只是提一句 */
  const adjust = (problem: string) => issues.push({ key: field.key, label: field.label, kind: "adjusted", problem });

  switch (field.type) {
    case "text":
    case "longtext": {
      const max = Math.min(field.max || (field.type === "longtext" ? SPEC_LIMITS.longtext : SPEC_LIMITS.text), SPEC_LIMITS.hardText);
      const raw = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
      const text = raw.replace(/\x00/g, "").trim();
      if (!text) return undefined;
      if (text.length > max) adjust(`超过 ${max} 字，已截断`);
      return text.slice(0, max);
    }
    case "url": {
      const url = cleanString(value, 2048);
      if (!url) return undefined;
      if (!URL_RE.test(url)) {
        reject(`「${url.slice(0, 60)}」不是合法链接，值已丢弃；必须是 http:// 或 https:// 开头的绝对地址`);
        return undefined;
      }
      return url;
    }
    case "number": {
      if (value === null || value === undefined || value === "") return undefined;
      const num = Number(value);
      if (!Number.isFinite(num)) {
        reject(`不是数字，值已丢弃；要一个 number（或能转成数字的字符串）${field.unit ? `，单位 ${field.unit}` : ""}`);
        return undefined;
      }
      return num;
    }
    case "bool": {
      if (value === null || value === undefined || value === "") return undefined;
      if (typeof value === "boolean") return value;
      const text = String(value).toLowerCase();
      if (["true", "1", "yes", "y", "是"].includes(text)) return true;
      if (["false", "0", "no", "n", "否"].includes(text)) return false;
      reject("不是布尔值，值已丢弃；接受 true/false、1/0、yes/no、是/否");
      return undefined;
    }
    case "date": {
      const stamp = toTimestamp(value);
      if (stamp === null) {
        if (value !== null && value !== undefined && value !== "") {
          reject(
            "认不出的时间格式，值已丢弃；接受 ISO 8601（如 2026-08-20T10:12:00Z / 2026-08-20）、" +
              "10 位秒级时间戳或 13 位毫秒级时间戳",
          );
        }
        return undefined;
      }
      return stamp;
    }
    case "enum": {
      const text = cleanString(value, 40);
      if (!text) return undefined;
      const hit = (field.options || []).find((option) => option.value === text || option.label === text);
      if (!hit) {
        reject(`「${text}」不是合法取值，值已丢弃；${enumHint(field)}（value 与 label 都认）`);
        return undefined;
      }
      return hit.value;
    }
    case "tags": {
      const list = Array.isArray(value) ? value : typeof value === "string" && value.trim() ? value.split(/[,，;；]/) : [];
      const max = Math.min(field.max || SPEC_LIMITS.tags, SPEC_LIMITS.tags);
      // 对象元素直接丢：cleanString(对象) 会存成一条叫 "[object Object]" 的标签
      const flat = list.filter((item) => typeof item !== "object" || item === null);
      if (flat.length < list.length) reject(`有 ${list.length - flat.length} 条不是标量（对象/数组），已丢弃；标签组要一串字符串`);
      const tags = flat
        .map((item) => cleanString(item, 40))
        .filter((item, index, all) => item && all.indexOf(item) === index);
      if (!tags.length) return undefined;
      if (tags.length > max) adjust(`超过 ${max} 条，已截断`);
      return tags.slice(0, max);
    }
    case "list": {
      if (!Array.isArray(value)) {
        if (value !== null && value !== undefined && value !== "") {
          reject(`必须是数组，值已丢弃；每行一个对象，列名取 ${(field.item || []).map((sub) => sub.key).join(" / ") || "规格里的子字段"}`);
        }
        return undefined;
      }
      const max = Math.min(field.max || SPEC_LIMITS.listRows, SPEC_LIMITS.listRows);
      const rows: Record<string, DataScalar>[] = [];
      for (const raw of value) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const row: Record<string, DataScalar> = {};
        for (const sub of field.item || []) {
          const cell = (raw as Record<string, unknown>)[sub.key];
          if (cell === undefined || cell === null || cell === "") continue;
          // 子字段只放标量：对象进来会被 cleanString 存成 "[object Object]"，
          // 表格里一格 "[object Object]" 比空着更糟
          if (typeof cell === "object") {
            reject(`第 ${rows.length + 1} 行的 ${sub.key} 是对象/数组，已丢弃；条目表的每一格只能是标量`);
            continue;
          }
          if (sub.type === "number") {
            const num = Number(cell);
            if (Number.isFinite(num)) row[sub.key] = num;
          } else if (sub.type === "bool") {
            row[sub.key] = cell === true || String(cell).toLowerCase() === "true";
          } else if (sub.type === "url") {
            const url = cleanString(cell, 2048);
            if (URL_RE.test(url)) row[sub.key] = url;
          } else {
            const text = cleanString(cell, 200);
            if (text) row[sub.key] = text;
          }
        }
        if (Object.keys(row).length) rows.push(row);
        if (rows.length >= max) break;
      }
      if (!rows.length) return undefined;
      if (value.length > max) adjust(`超过 ${max} 行，已截断`);
      return rows;
    }
    default:
      return undefined;
  }
}

/**
 * 按规格清洗一份字段值。**不抛异常**：认不出的东西丢掉并记一笔，
 * 由调用方决定要不要因此拒收（信封导入会拒，单卡 PATCH 不会）。
 */
export function normalizeSpecValues(spec: CardSpec, raw: Record<string, unknown> = {}): ValueReport {
  const input = raw && typeof raw === "object" ? raw : {};
  const fields: Record<string, DataValue> = {};
  const issues: FieldIssue[] = [];
  const missing: string[] = [];

  for (const field of spec.fields) {
    const before = issues.length;
    const given = input[field.key];
    // 「压根没给」与「给了但不合规」是两回事：混成一句「缺必填字段」，
    // 调用方会去补一个它明明已经传了的字段（真实踩坑）。
    const provided = given !== undefined && given !== null && given !== "";
    const value = normalizeOne(field, given, issues);
    if (value === undefined) {
      if (provided && !issues.slice(before).some((issue) => issue.kind === "invalid")) {
        // 有几条路会静默返回 undefined（空数组的 tags、全是空行的 list…）：补一条，
        // 免得「传了却没进去」这件事没有任何交代
        issues.push({ key: field.key, label: field.label, kind: "invalid", problem: "值为空或识别不出内容，已丢弃" });
      }
      // 给了但不合规的算 invalid，不算 missing——否则文案会指错方向
      if (field.required && !provided) missing.push(field.key);
      continue;
    }
    fields[field.key] = value;
  }

  const known = new Set(spec.fields.map((field) => field.key));
  const unknown = Object.keys(input).filter((key) => !known.has(key));

  // 序列化上限：单张卡不能把整块板撑爆（长文本应该另开一张 text 卡）
  if (Buffer.byteLength(JSON.stringify(fields)) > SPEC_LIMITS.cardBytes) {
    for (const field of [...spec.fields].reverse()) {
      if (field.type !== "longtext" || fields[field.key] === undefined) continue;
      fields[field.key] = String(fields[field.key]).slice(0, 1000);
      issues.push({ key: field.key, label: field.label, kind: "adjusted", problem: "整卡数据超过 20KB，长文本已压到 1000 字" });
      if (Buffer.byteLength(JSON.stringify(fields)) <= SPEC_LIMITS.cardBytes) break;
    }
  }

  return { fields, missing, unknown, invalid: issues.filter((issue) => issue.kind === "invalid"), issues };
}

/**
 * 规格不在本机时的兜底清洗：别人给的卡片照样收下、照样能看，
 * 只是显示成一张朴素的 key-value 表。这条路是「查看别人的卡片」能成立的前提。
 */
export function normalizeLooseValues(raw: Record<string, unknown> = {}): Record<string, DataValue> {
  const input = raw && typeof raw === "object" ? raw : {};
  const fields: Record<string, DataValue> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= SPEC_LIMITS.fields) break;
    if (!FIELD_KEY_RE.test(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "number" && Number.isFinite(value)) fields[key] = value;
    else if (typeof value === "boolean") fields[key] = value;
    else if (Array.isArray(value)) {
      const scalars = value.filter((item) => ["string", "number", "boolean"].includes(typeof item));
      if (scalars.length === value.length) {
        fields[key] = scalars.slice(0, SPEC_LIMITS.tags).map((item) => (typeof item === "string" ? cleanString(item, 200) : (item as DataScalar)));
      } else {
        const rows: Record<string, DataScalar>[] = [];
        for (const item of value.slice(0, SPEC_LIMITS.listRows)) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const row: Record<string, DataScalar> = {};
          for (const [subKey, subValue] of Object.entries(item as Record<string, unknown>).slice(0, SPEC_LIMITS.subFields)) {
            if (typeof subValue === "number" || typeof subValue === "boolean") row[subKey] = subValue;
            else if (typeof subValue === "string") row[subKey] = cleanString(subValue, 200);
          }
          if (Object.keys(row).length) rows.push(row);
        }
        if (rows.length) fields[key] = rows;
      }
    } else if (typeof value === "object") {
      // 一层对象摊成 JSON 文本：留着看，别丢
      fields[key] = cleanString(JSON.stringify(value), SPEC_LIMITS.longtext);
    } else {
      fields[key] = cleanString(value, SPEC_LIMITS.longtext);
    }
    count += 1;
  }
  if (Buffer.byteLength(JSON.stringify(fields)) > SPEC_LIMITS.cardBytes) {
    // 兜底路径没有类型信息，超限就按 key 顺序丢尾巴
    for (const key of Object.keys(fields).reverse()) {
      delete fields[key];
      if (Buffer.byteLength(JSON.stringify(fields)) <= SPEC_LIMITS.cardBytes) break;
    }
  }
  return fields;
}

/* ── 显示 / 文本化 ────────────────────────────────────── */

/** 卡片标题：规格指定了 display.title 就用它，否则退回规格名。 */
export function specCardTitle(spec: CardSpec, fields: Record<string, DataValue>): string {
  const key = spec.display.title;
  const value = key ? fields[key] : undefined;
  const text = value === undefined || value === null ? "" : String(Array.isArray(value) ? value.join("、") : value);
  return (text || spec.name).slice(0, 300);
}

/** 单个字段值的人话形式（Markdown 导出、卡面徽标、校验预览共用）。 */
export function formatFieldValue(field: SpecField | null, value: DataValue | undefined): string {
  if (value === undefined || value === null || value === "") return "";
  if (field?.type === "date") {
    const stamp = Number(value);
    return Number.isFinite(stamp) ? new Date(stamp).toISOString().replace("T", " ").slice(0, 16) : String(value);
  }
  if (field?.type === "bool" || typeof value === "boolean") return value ? "是" : "否";
  if (field?.type === "enum") {
    return field.options?.find((option) => option.value === value)?.label || String(value);
  }
  if (field?.type === "number" && field.unit) return `${value} ${field.unit}`;
  if (Array.isArray(value)) {
    if (!value.length) return "";
    if (typeof value[0] === "object") {
      const rows = value as Record<string, DataScalar>[];
      return rows.map((row) => Object.values(row).join(" · ")).join("\n");
    }
    return (value as DataScalar[]).join("、");
  }
  return String(value);
}

/* ── JSON Schema 生成（「注入 schema」的那份 schema） ───────── */

const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

function fieldSchema(field: SpecField): Record<string, unknown> {
  const base: Record<string, unknown> = { title: field.label };
  if (field.hint) base.description = field.hint;
  switch (field.type) {
    case "text":
      return { ...base, type: "string", maxLength: Math.min(field.max || SPEC_LIMITS.text, SPEC_LIMITS.hardText) };
    case "longtext":
      return { ...base, type: "string", maxLength: Math.min(field.max || SPEC_LIMITS.longtext, SPEC_LIMITS.hardText) };
    case "url":
      return { ...base, type: "string", format: "uri", pattern: "^https?://" };
    case "number":
      return { ...base, type: "number", ...(field.unit ? { description: `${field.hint ? `${field.hint}；` : ""}单位：${field.unit}` } : {}) };
    case "bool":
      return { ...base, type: "boolean" };
    case "date":
      return {
        ...base,
        description: `${field.hint ? `${field.hint}；` : ""}毫秒时间戳，或 ISO 8601 字符串（秒级时间戳也接受）`,
        anyOf: [{ type: "integer" }, { type: "string" }],
      };
    case "enum":
      return { ...base, type: "string", enum: (field.options || []).map((option) => option.value) };
    case "tags":
      return { ...base, type: "array", items: { type: "string", maxLength: 40 }, maxItems: Math.min(field.max || SPEC_LIMITS.tags, SPEC_LIMITS.tags) };
    case "list":
      return {
        ...base,
        type: "array",
        maxItems: Math.min(field.max || SPEC_LIMITS.listRows, SPEC_LIMITS.listRows),
        items: {
          type: "object",
          properties: Object.fromEntries(
            (field.item || []).map((sub) => [
              sub.key,
              { title: sub.label, type: sub.type === "number" ? "number" : sub.type === "bool" ? "boolean" : "string" },
            ]),
          ),
          additionalProperties: false,
        },
      };
    default:
      return base;
  }
}

/** 单张卡的 JSON Schema：外部系统 / agent 照着这个构造 cards[] 里的一项。 */
export function specCardSchema(spec: CardSpec): Record<string, unknown> {
  const required = spec.fields.filter((field) => field.required).map((field) => field.key);
  return {
    type: "object",
    title: `${spec.name}（${spec.id} v${spec.version}）`,
    description: spec.description,
    properties: {
      spec: { const: spec.id, description: "规格 id，固定值" },
      specVersion: { type: "integer", const: spec.version },
      id: { type: "string", description: "信封内的本地 id，只用于 edges 引用；不传则不参与连线" },
      title: { type: "string", maxLength: 300, description: `卡片标题；不传则取 ${spec.display.title || "规格名"}` },
      color: { enum: [...CARD_COLORS], description: "卡片颜色；不传用规格默认色" },
      x: { type: "number" },
      y: { type: "number" },
      w: { type: "number" },
      h: { type: "number" },
      agentPrompt: { type: "string", maxLength: 4000, description: "绑在这张卡上的 agent 指令（可选）" },
      source: {
        type: "object",
        description: "这张卡的外部出处；同 spec + 同 externalId 视为同一张卡（导入时可去重）",
        properties: {
          app: { type: "string", maxLength: 40 },
          url: { type: "string", format: "uri" },
          externalId: { type: "string", maxLength: 200 },
          fetchedAt: { type: "integer" },
        },
        additionalProperties: false,
      },
      fields: {
        type: "object",
        title: "字段值",
        properties: Object.fromEntries(spec.fields.map((field) => [field.key, fieldSchema(field)])),
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      },
    },
    required: ["spec", "fields"],
    additionalProperties: false,
  };
}

/** 带 $schema 头的独立 schema 文档（给「复制 Schema」按钮 / GET …/schema 用）。 */
export function specSchemaDocument(spec: CardSpec, publicUrl: string): Record<string, unknown> {
  return {
    $schema: SCHEMA_DIALECT,
    $id: `${publicUrl.replace(/\/$/, "")}/api/card-specs/${spec.id}/schema`,
    ...specCardSchema(spec),
  };
}

export const ENVELOPE_FORMAT = "blotboard.cards";
/**
 * 旧格式名（本项目自 goal-board 重构而来，存量脚本/信封还写着老名字）。
 * 读入时新旧都收，写出永远用 ENVELOPE_FORMAT——别让改名变成一次破坏性升级。
 */
export const LEGACY_ENVELOPE_FORMATS = ["goal-board.cards"] as const;
export const ENVELOPE_VERSION = 1;

/**
 * 「哪种原生卡把专属字段放在哪个键里」——从注册表现算（meta.envelope + meta.fieldKey）。
 * 光给一个 type 枚举，调用方还是不知道 excalidraw 的内容该往哪塞。
 */
function describeEnvelopeFieldKeys(): string {
  return CARD_METAS.filter((meta) => meta.envelope)
    .map((meta) => `${meta.type}${meta.fieldKey ? ` → ${meta.fieldKey}` : "（只有 title/content）"}`)
    .join("、");
}

/** 整个信封的 JSON Schema：cards 里既能放规格卡，也能放原生卡片。 */
export function envelopeSchemaDocument(specs: CardSpec[], publicUrl: string): Record<string, unknown> {
  const base = publicUrl.replace(/\/$/, "");
  return {
    $schema: SCHEMA_DIALECT,
    $id: `${base}/api/card-specs/schema`,
    title: "blotboard 卡片信封（Card Envelope v1）",
    description:
      "外部系统往画板送卡片的统一格式。POST 到 /api/boards/{boardId}/ingest 即落板；" +
      "先 POST /api/card-specs/validate 可以只校验不落库。",
    type: "object",
    properties: {
      format: { enum: [ENVELOPE_FORMAT, ...LEGACY_ENVELOPE_FORMATS] },
      version: { type: "integer", const: ENVELOPE_VERSION },
      generator: { type: "string", maxLength: 100, description: "谁生成的，如 feishu-bot/1.2（可选，只作记录）" },
      mode: {
        enum: ["strict", "lenient"],
        description: "strict（默认）= 有一张卡不合规就整批不落；lenient = 跳过坏卡，其余照落",
        default: "strict",
      },
      cards: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          anyOf: [
            ...specs.map((spec) => specCardSchema(spec)),
            {
              type: "object",
              title: "原生卡片",
              description:
                "画板自带的卡片类型；不需要规格。信封只收**自包含**的类型——" +
                `专属字段跟单张建卡完全一样，按类型放在各自的键里：${describeEnvelopeFieldKeys()}。` +
                "image / pdf / board 不在其中：它们的 file.uploadId / boardRef.boardId 是本机主键，" +
                "换台机器指不到东西，得先在目标机器拿到 id 再 POST /api/boards/{boardId}/cards 单张建卡。",
              properties: {
                // 可导入的原生类型从卡片包注册表派生（meta.envelope），与 card-ingest 同源
                type: { enum: CARD_METAS.filter((meta) => meta.envelope).map((meta) => meta.type) },
                id: { type: "string" },
                title: { type: "string", maxLength: 300 },
                content: { type: "string", maxLength: 20000 },
                color: { enum: [...CARD_COLORS] },
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
                agentPrompt: { type: "string", maxLength: 4000 },
              },
              required: ["type"],
            },
          ],
        },
      },
      edges: {
        type: "array",
        maxItems: 400,
        items: {
          type: "object",
          properties: {
            from: { type: "string", description: "信封里某张卡的 id" },
            to: { type: "string" },
            label: { type: "string", maxLength: 120 },
            kind: { enum: ["rel", "blocks", "enables", "references", "produces"] },
          },
          required: ["from", "to"],
        },
      },
    },
    required: ["cards"],
  };
}

/** 给 agent / 人看的一段规格说明（比 JSON Schema 省 token，也更好读）。 */
export function specPromptBlock(spec: CardSpec): string {
  const lines = [
    `## ${spec.name}（spec: ${spec.id} · v${spec.version}）`,
    spec.description,
    "",
    "| 字段 | 名称 | 类型 | 必填 | 说明 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const field of spec.fields) {
    const type =
      field.type === "enum"
        ? `单选：${(field.options || []).map((option) => option.value).join(" / ")}`
        : field.type === "list"
          ? `条目表（列：${(field.item || []).map((sub) => sub.key).join(" / ")}）`
          : SPEC_FIELD_TYPE_LABEL[field.type];
    lines.push(`| \`${field.key}\` | ${field.label} | ${type} | ${field.required ? "是" : ""} | ${field.hint || ""} |`);
  }
  if (spec.example) {
    lines.push("", "示例：", "```json", JSON.stringify({ spec: spec.id, fields: spec.example }, null, 2), "```");
  }
  return lines.join("\n");
}
