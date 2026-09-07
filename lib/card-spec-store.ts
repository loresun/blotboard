/**
 * 规格读盘、开关状态、用户自定义规格的增删。
 *
 * 两个来源：
 *  · 内置 `data/card-specs/*.json` —— 仓库资产，git 跟踪，不可改不可删；
 *  · 用户 `<DATA_DIR>/card-specs/*.json` —— 自己定的规格，能建能删，不进 git。
 * 同 id 不允许（用户规格顶掉内置规格会让「按 id 取规格」在两台机器上得到两种结构）。
 *
 * 开关状态单独存 `<DATA_DIR>/card-spec-state.json`：规格文件本身是只读资产，
 * 「关掉飞书消息卡」这种偏好属于用户数据，不该写回仓库文件里。
 *
 * 缓存与模板中心同一套：按「文件名 + mtime」串守卫，改完规格不用重启。
 */
import fs from "node:fs";
import path from "node:path";
import { CARD_SPECS_DIR, CARD_SPEC_STATE_FILE, USER_CARD_SPECS_DIR } from "./config";
import { badRequest, conflict, notFound } from "./http";
import { writeAtomic } from "./storage";
import {
  SPEC_CATEGORIES,
  SPEC_CATEGORY_META,
  SPEC_ID_RE,
  SPEC_LIMITS,
  SpecError,
  normalizeCardSpec,
  type CardSpec,
  type SpecCategory,
} from "./card-spec-schema";

export interface SpecState {
  version: string;
  /** 只记被显式改过的：id → 开 / 关。没记的跟规格自己的 defaultEnabled 走。 */
  overrides: Record<string, boolean>;
}

const EMPTY_STATE: SpecState = { version: "1", overrides: {} };

/** 与固定路由重名的 id 不能用（/api/card-specs/schema、/validate） */
export const RESERVED_SPEC_IDS = ["schema", "validate"];

interface CacheEntry {
  stamps: string;
  specs: CardSpec[];
}

let cache: CacheEntry | null = null;
let stateCache: { mtime: number | null; state: SpecState } | null = null;

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

function stampOf(dir: string, files: string[]): string {
  return files
    .map((file) => {
      try {
        return `${dir}/${file}:${fs.statSync(path.join(dir, file)).mtimeMs}`;
      } catch {
        return `${dir}/${file}:gone`;
      }
    })
    .join("|");
}

function readDir(dir: string, origin: "builtin" | "user"): CardSpec[] {
  const specs: CardSpec[] = [];
  for (const file of listFiles(dir)) {
    const full = path.join(dir, file);
    const size = fs.statSync(full).size;
    if (size > SPEC_LIMITS.fileBytes) {
      throw new SpecError(`规格 ${file}：文件 ${size} 字节，超过上限 ${SPEC_LIMITS.fileBytes}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (err) {
      throw new SpecError(`规格 ${file}：不是合法 JSON（${(err as Error).message}）`);
    }
    specs.push(normalizeCardSpec(raw, file.replace(/\.json$/, ""), origin));
  }
  return specs;
}

function readAll(): CardSpec[] {
  const builtinFiles = listFiles(CARD_SPECS_DIR);
  const userFiles = USER_CARD_SPECS_DIR === CARD_SPECS_DIR ? [] : listFiles(USER_CARD_SPECS_DIR);
  const stamps = `${stampOf(CARD_SPECS_DIR, builtinFiles)}#${stampOf(USER_CARD_SPECS_DIR, userFiles)}`;
  if (cache && cache.stamps === stamps) return cache.specs;

  const builtin = readDir(CARD_SPECS_DIR, "builtin");
  const seen = new Set(builtin.map((spec) => spec.id));
  const user: CardSpec[] = [];
  for (const spec of USER_CARD_SPECS_DIR === CARD_SPECS_DIR ? [] : readDir(USER_CARD_SPECS_DIR, "user")) {
    // 同 id 直接报错而不是静默择一：两边内容不同的话，选哪边都会在别处出错
    if (seen.has(spec.id)) throw new SpecError(`规格 ${spec.id}：与内置规格重名，请换一个 id`);
    seen.add(spec.id);
    user.push(spec);
  }

  const specs = [...builtin, ...user].sort((a, b) => {
    const byCategory = SPEC_CATEGORIES.indexOf(a.category) - SPEC_CATEGORIES.indexOf(b.category);
    return byCategory !== 0 ? byCategory : a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  cache = { stamps, specs };
  return specs;
}

/* ── 开关状态 ─────────────────────────────────────────── */

function readState(): SpecState {
  let mtime: number | null = null;
  try {
    mtime = fs.statSync(CARD_SPEC_STATE_FILE).mtimeMs;
  } catch {
    return EMPTY_STATE;
  }
  if (stateCache && stateCache.mtime === mtime) return stateCache.state;
  try {
    const raw = JSON.parse(fs.readFileSync(CARD_SPEC_STATE_FILE, "utf8"));
    const overrides: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(raw?.overrides || {})) {
      if (SPEC_ID_RE.test(id)) overrides[id] = value === true;
    }
    const state = { version: "1", overrides };
    stateCache = { mtime, state };
    return state;
  } catch {
    // 状态文件坏了不该让整个规格中心打不开：当作「全用默认」
    return EMPTY_STATE;
  }
}

function writeState(state: SpecState): void {
  // 走 storage 的公共原子写：临时文件名带 pid、失败会把半成品清掉（各处自己抄的那几版两样都没有）
  writeAtomic(CARD_SPEC_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  stateCache = null;
}

export function isEnabled(spec: CardSpec, state: SpecState = readState()): boolean {
  const override = state.overrides[spec.id];
  return override === undefined ? spec.defaultEnabled : override;
}

/* ── 对外读取 ─────────────────────────────────────────── */

export interface SpecListItem {
  id: string;
  version: number;
  name: string;
  category: SpecCategory;
  description: string;
  icon: string;
  tags: string[];
  origin: "builtin" | "user";
  enabled: boolean;
  app: string;
  fieldCount: number;
  requiredCount: number;
  hasExample: boolean;
}

export function specListItem(spec: CardSpec, state?: SpecState): SpecListItem {
  return {
    id: spec.id,
    version: spec.version,
    name: spec.name,
    category: spec.category,
    description: spec.description,
    icon: spec.icon,
    tags: spec.tags,
    origin: spec.origin,
    enabled: isEnabled(spec, state),
    app: spec.source?.app || "",
    fieldCount: spec.fields.length,
    requiredCount: spec.fields.filter((field) => field.required).length,
    hasExample: Boolean(spec.example),
  };
}

/** 全部规格（含停用的）；列表页要把停用的也显示出来，才能再打开。 */
export function listSpecs(): SpecListItem[] {
  const state = readState();
  return readAll().map((spec) => specListItem(spec, state));
}

/** 只要启用的那些（新建卡片菜单、schema 汇总、agent 提示词用）。 */
export function enabledSpecs(): CardSpec[] {
  const state = readState();
  return readAll().filter((spec) => isEnabled(spec, state));
}

export function allSpecs(): CardSpec[] {
  return readAll();
}

/** 按 id 取；找不到返回 null（画板上可能留着「规格已被删掉」的老卡片，那不是错误）。 */
export function findSpec(id: string): CardSpec | null {
  if (!SPEC_ID_RE.test(id || "")) return null;
  return readAll().find((spec) => spec.id === id) || null;
}

/** 按 id 取，找不到就 404；写路径（建卡 / 导入）用这个。 */
export function getSpec(id: string): CardSpec {
  if (!SPEC_ID_RE.test(id || "")) throw badRequest("规格 id 无效");
  const found = readAll().find((spec) => spec.id === id);
  if (!found) throw notFound(`规格不存在：${id}`);
  return found;
}

/** 写路径专用：既要存在，也要处于启用状态。 */
export function requireEnabledSpec(id: string): CardSpec {
  const spec = getSpec(id);
  if (!isEnabled(spec)) throw conflict(`规格「${spec.name}」已停用，先在规格中心打开它`);
  return spec;
}

export function listSpecCategories(): { id: SpecCategory; label: string; hint: string; count: number }[] {
  const specs = readAll();
  return SPEC_CATEGORIES.map((id) => ({
    id,
    label: SPEC_CATEGORY_META[id].label,
    hint: SPEC_CATEGORY_META[id].hint,
    count: specs.filter((spec) => spec.category === id).length,
  }));
}

/* ── 写：开关 / 自定义规格 ─────────────────────────────── */

/** 开 / 关一份规格。跟默认值一致时把 override 删掉，状态文件保持干净。 */
export function setSpecEnabled(id: string, enabled: boolean): SpecListItem {
  const spec = getSpec(id);
  const current = readState();
  const state = { ...current, overrides: { ...current.overrides } };
  if (spec.defaultEnabled === enabled) delete state.overrides[spec.id];
  else state.overrides[spec.id] = enabled;
  writeState(state);
  return specListItem(spec, state);
}

/** 新建 / 覆盖一份用户规格（写到 USER_CARD_SPECS_DIR）。 */
export function saveUserSpec(raw: any, { overwrite = false }: { overwrite?: boolean } = {}): CardSpec {
  const id = String(raw?.id || "").trim();
  if (!SPEC_ID_RE.test(id)) throw badRequest("规格 id 必须是 kebab-case（小写字母、数字、连字符）");
  // 这两个 id 会跟 /api/card-specs/schema、/validate 两条固定路由撞车
  if (RESERVED_SPEC_IDS.includes(id)) throw badRequest(`「${id}」是保留 id，换一个`);
  const existing = readAll().find((spec) => spec.id === id);
  if (existing && existing.origin === "builtin") throw conflict(`「${id}」是内置规格，请换一个 id`);
  if (existing && !overwrite) throw conflict(`规格「${id}」已存在，要改它请带 overwrite: true`);

  // 先过一遍严格校验再落盘：不合规的规格文件会让整个规格中心读不出来。
  // 这里的输入来自调用方（不是仓库资产），所以校验失败是 400 而不是 500。
  let spec: CardSpec;
  try {
    spec = normalizeCardSpec(raw, id, "user");
  } catch (err) {
    throw badRequest(err instanceof SpecError ? err.message : `规格不合规：${(err as Error).message}`);
  }
  const body = `${JSON.stringify(stripRuntime(spec), null, 2)}\n`;
  if (Buffer.byteLength(body) > SPEC_LIMITS.fileBytes) throw badRequest(`规格过大（上限 ${SPEC_LIMITS.fileBytes} 字节）`);
  const full = path.join(USER_CARD_SPECS_DIR, `${id}.json`);
  writeAtomic(full, body);
  cache = null;
  return spec;
}

export function deleteUserSpec(id: string): string {
  const spec = getSpec(id);
  if (spec.origin !== "user") throw conflict("内置规格不能删除，可以在规格中心把它停用");
  fs.rmSync(path.join(USER_CARD_SPECS_DIR, `${spec.id}.json`), { force: true });
  const state = readState();
  if (state.overrides[spec.id] !== undefined) {
    const next = { ...state, overrides: { ...state.overrides } };
    delete next.overrides[spec.id];
    writeState(next);
  }
  cache = null;
  return spec.id;
}

/** 落盘时去掉运行时字段（origin 由目录决定，不该写进文件） */
function stripRuntime(spec: CardSpec): Record<string, unknown> {
  const { origin, ...rest } = spec;
  return rest;
}

/** 测试钩子：丢掉目录与状态缓存 */
export function resetSpecCache(): void {
  cache = null;
  stateCache = null;
}
