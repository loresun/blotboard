/**
 * 卡片包开关状态（`<DATA_DIR>/card-packs.json`）。
 *
 * 语义（OPEN-SOURCE-PLAN §3.2 / 阶段 B 任务书）：
 *  · 停用一个包 = 工具条入口消失 + **新建**该类型返回结构化 400（信封 strict 拒 / lenient 跳过照旧）；
 *  · **已有卡片不受影响**——包代码编译在内，停用只挡新建，渲染 / 编辑 / 导出照常；
 *  · 未知类型（数据里有、代码里没有）不归这里管，走 Tier 0 兜底 + 透传铁律。
 *
 * **首次生成时的默认**（文件不存在时自动生成并落盘）：
 *  方案默认集（text / task / link / quote / todo / mermaid / data / code / table / media，即 meta.defaultEnabled；
 *  media 在里面是因为它**没有工具条入口**——停用不表现为「少一个按钮」，只表现为
 *  把一个 mp4 拖进画布时撞一句 400，费解）
 *  ∪ **存量数据里实际出现过的类型**（扫一遍 boards 目录统计 type）。
 *  这样开源新装机是精简默认；老实例首启即全量启用自己用过的类型，谁都不惊讶。
 *
 * **已经有 card-packs.json 的实例升级之后**：文件里没记的新包按它自己的
 *  meta.defaultEnabled 算（见 defaultEnabledOf），不是一律当开——
 *  否则「默认不启用」的包会在老实例上不请自来。
 *
 * 缓存与规格开关同一套：mtime 守卫，改文件不用重启。
 */
import fs from "node:fs";
import { CARD_PACKS_FILE } from "./config";
import { CARD_METAS, cardMetaOf } from "./card-metas";
import { badRequest } from "./http";
import * as storage from "./storage";

interface PackState {
  version: "1";
  enabled: Record<string, boolean>;
}

let stateCache: { mtime: number | null; state: PackState } | null = null;

/** 首次生成：方案默认集 ∪ 存量数据里实际出现过的类型。 */
function buildInitialState(): PackState {
  const enabled: Record<string, boolean> = {};
  for (const meta of CARD_METAS) enabled[meta.type] = Boolean(meta.defaultEnabled);
  try {
    for (const board of storage.load().boards) {
      for (const card of board.cards || []) {
        // 只认原生类型：未知类型不进开关表（它没有包可开）
        if (enabled[card.type] === false) enabled[card.type] = true;
      }
    }
  } catch {
    /* 存量扫不动（数据目录还没建）就用纯默认集 */
  }
  return { version: "1", enabled };
}

function writeState(state: PackState): void {
  // 走 storage 的公共原子写：临时文件名带 pid、失败会把半成品清掉（各处自己抄的那几版两样都没有）
  storage.writeAtomic(CARD_PACKS_FILE, `${JSON.stringify(state, null, 2)}\n`);
  stateCache = null;
}

function readState(): PackState {
  let mtime: number | null = null;
  try {
    mtime = fs.statSync(CARD_PACKS_FILE).mtimeMs;
  } catch {
    // 文件不存在 = 首次启动：按规则生成并落盘，之后的行为就稳定可查了
    const state = buildInitialState();
    try {
      writeState(state);
    } catch {
      /* 写不进也能用（只是每次现算） */
    }
    return state;
  }
  if (stateCache && stateCache.mtime === mtime) return stateCache.state;
  try {
    const raw = JSON.parse(fs.readFileSync(CARD_PACKS_FILE, "utf8"));
    const enabled: Record<string, boolean> = {};
    for (const [type, value] of Object.entries(raw?.enabled || {})) {
      if (cardMetaOf(type)) enabled[type] = value === true;
    }
    const state: PackState = { version: "1", enabled };
    stateCache = { mtime, state };
    return state;
  } catch {
    // 状态文件坏了不该把所有卡全关掉：当作全开（老实例的既有行为）。
    // 这里要**逐个写 true**，不能靠下面的缺省——缺省走的是方案默认集，
    // 一个坏文件会顺手停掉九个包，那是把「读不出来」误判成「用户关掉了」
    return { version: "1", enabled: Object.fromEntries(CARD_METAS.map((meta) => [meta.type, true])) };
  }
}

/**
 * 文件里没记的类型按**这个包自己的 defaultEnabled** 算。
 *
 * 这条只对「升级后新加的包」生效：card-packs.json 是首启时按当时的全部包一次写全的，
 * 老实例升上来会多出几个文件里没有的类型。老写法一律当成开——于是 chart 这种
 * 声明了「默认不启用」的包，在老实例上反而自动出现在工具条上，与它的声明相反。
 * 现在跟着 meta 走：code / table（defaultEnabled: true）自动可用，chart 等用户按需开。
 */
function defaultEnabledOf(type: string): boolean {
  return Boolean(cardMetaOf(type)?.defaultEnabled);
}

/** 这个包现在开着吗？文件里没记的类型（比如后加的包）按 meta.defaultEnabled。未知类型 = false。 */
export function isPackEnabled(type: string): boolean {
  if (!cardMetaOf(type)) return false;
  const state = readState();
  return state.enabled[type] ?? defaultEnabledOf(type);
}

export interface CardPackListItem {
  type: string;
  label: string;
  icon: string;
  enabled: boolean;
  /** 方案默认集里的成员（卡片中心提示用） */
  defaultEnabled: boolean;
}

/** 全部卡片包（含停用的）；卡片中心要把停用的也列出来，才能再打开。 */
export function listCardPacks(): CardPackListItem[] {
  const state = readState();
  return CARD_METAS.map((meta) => ({
    type: meta.type,
    label: meta.label,
    icon: meta.icon,
    // 缺省口径与 isPackEnabled 必须一致，否则「清单显示开着、建卡却 400」
    enabled: state.enabled[meta.type] ?? defaultEnabledOf(meta.type),
    defaultEnabled: Boolean(meta.defaultEnabled),
  }));
}

export function setPackEnabled(type: string, enabled: boolean): CardPackListItem[] {
  return setPacksEnabled({ [type]: enabled });
}

/**
 * 一次开 / 关多个包（`PATCH /api/card-packs` 的 `{enabled:{svg:true,html:false}}` 形态）。
 *
 * 为什么值得单开：装机 / 换形态时要改的从来不是一个包，而是一批。逐个 PATCH 会写四五次盘、
 * 每次都重算一遍状态，中途失败还留下改了一半的开关表——这里**先整批校验再一次落盘**，
 * 要么全改要么全不改。单个开关的老路径原样保留（就是这个函数的一元特例）。
 */
export function setPacksEnabled(changes: Record<string, unknown>): CardPackListItem[] {
  const entries = Object.entries(changes || {});
  if (!entries.length) throw badRequest("没有要改的开关：body 传 `{type, enabled}` 或 `{enabled: {type: bool, …}}`");
  for (const [type, value] of entries) {
    if (!cardMetaOf(type)) throw badRequest(`没有这种卡片包：${type}（GET /api/card-packs 看有哪些）`);
    if (typeof value !== "boolean") throw badRequest(`enabled.${type} 必须是布尔，收到 ${JSON.stringify(value)}`);
  }
  const state = readState();
  writeState({ version: "1", enabled: { ...state.enabled, ...(Object.fromEntries(entries) as Record<string, boolean>) } });
  return listCardPacks();
}
