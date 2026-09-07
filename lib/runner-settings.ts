/**
 * Runner 设置（`<data>/runner-settings.json`）：ACP agent 注册表 + 权限档位。
 *
 * 这是 local 任务后端「ACP 派单」的配置面（docs/RUNNER.md §4）：
 *  - agents：每个 agent 一条「怎么拉起」的记录（command + args + cwd + env）；
 *  - defaultAgentId：任务台派单时预选的那个；
 *  - permissionMode：agent 的 `session/request_permission` 怎么处理——
 *    "ask" = 挂起等人批（run 进「等我处理」镜头），"auto" = 自动选 allow 类选项并记账。
 *
 * env 可能装着 API key，所以对浏览器**只回 key 名不回值**（toPublic）；
 * 值只在 spawn 子进程时注入。读写手法与 issue-store 同一套（mtime 守卫 + 原子写）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { RUNNER_SETTINGS_FILE } from "./config";
import { badRequest, conflict } from "./http";
import { writeAtomic } from "./storage";

export interface AcpAgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** 不配 = spawn 在 <data>/acp-workspace/（见 lib/config.ts ACP_WORKSPACE_DIR 注释） */
  cwd: string | null;
  /** 追加在画板进程 env 之上；值不回显给浏览器 */
  env: Record<string, string>;
}

export type PermissionMode = "ask" | "auto";

export interface RunnerSettings {
  version: string;
  agents: AcpAgentConfig[];
  defaultAgentId: string | null;
  permissionMode: PermissionMode;
}

/** 浏览器侧形状：env 只给 key 名（值永不出服务端） */
export interface PublicRunnerSettings {
  agents: (Omit<AcpAgentConfig, "env"> & { envKeys: string[] })[];
  defaultAgentId: string | null;
  permissionMode: PermissionMode;
}

const DATA_VERSION = "1";
const MAX_AGENTS = 20;

function emptySettings(): RunnerSettings {
  return { version: DATA_VERSION, agents: [], defaultAgentId: null, permissionMode: "ask" };
}

/* ── 读写（mtime 守卫缓存 + 原子写） ─────────────────── */

let cache: { file: string; mtimeMs: number; data: RunnerSettings } | null = null;
let readFailed = false;

export function loadRunnerSettings(): RunnerSettings {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(RUNNER_SETTINGS_FILE);
  } catch (error) {
    readFailed = (error as NodeJS.ErrnoException).code !== "ENOENT";
    cache = null;
    return emptySettings();
  }
  if (cache && cache.file === RUNNER_SETTINGS_FILE && cache.mtimeMs === stat.mtimeMs) return cache.data;
  try {
    const raw = JSON.parse(fs.readFileSync(RUNNER_SETTINGS_FILE, "utf8"));
    if (!raw || !Array.isArray(raw.agents)) throw new Error("Invalid Runner settings structure");
    const data: RunnerSettings = {
      version: DATA_VERSION,
      agents: Array.isArray(raw?.agents) ? raw.agents.map(normalizeStoredAgent).filter(Boolean) as AcpAgentConfig[] : [],
      defaultAgentId: typeof raw?.defaultAgentId === "string" ? raw.defaultAgentId : null,
      permissionMode: raw?.permissionMode === "auto" ? "auto" : "ask",
    };
    if (data.defaultAgentId && !data.agents.some((agent) => agent.id === data.defaultAgentId)) data.defaultAgentId = null;
    cache = { file: RUNNER_SETTINGS_FILE, mtimeMs: stat.mtimeMs, data };
    readFailed = false;
    return data;
  } catch (err) {
    // 文件坏了当空配置用、不覆盖原文件——与 issues.json 的容错口径一致
    console.error("[runner] runner-settings.json 读取失败（按空配置处理）；请检查文件格式与权限");
    cache = null;
    readFailed = true;
    return emptySettings();
  }
}

function persist(data: RunnerSettings): void {
  // 0600（writeAtomic 的默认）：env 里可能有 key，跟 token 文件同一待遇
  // 走 storage 的公共原子写：临时文件名带 pid、失败会把半成品清掉（各处自己抄的那几版两样都没有）
  writeAtomic(RUNNER_SETTINGS_FILE, `${JSON.stringify(data, null, 2)}\n`);
  const stat = fs.statSync(RUNNER_SETTINGS_FILE);
  cache = { file: RUNNER_SETTINGS_FILE, mtimeMs: stat.mtimeMs, data };
}

/* ── 归一化 ───────────────────────────────────────── */

function cleanText(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

/** 存盘里读出来的：尽量救，救不动（没 command）就丢这一条 */
function normalizeStoredAgent(raw: any): AcpAgentConfig | null {
  const command = cleanText(raw?.command, 500);
  if (!command) return null;
  return {
    id: cleanText(raw?.id, 60) || newAgentId(),
    name: cleanText(raw?.name, 80) || command,
    command,
    args: Array.isArray(raw?.args) ? raw.args.map((item: unknown) => String(item ?? "")).slice(0, 50) : [],
    cwd: cleanText(raw?.cwd, 1000) || null,
    env: normalizeEnv(raw?.env) || {},
  };
}

function normalizeEnv(raw: unknown): Record<string, string> | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = cleanText(key, 100);
    // env 名限成安全字符集：这个东西会原样进子进程环境
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    env[name] = String(value ?? "");
  }
  return env;
}

function newAgentId(): string {
  return `a_${crypto.randomBytes(4).toString("hex")}`;
}

/* ── 查询 ─────────────────────────────────────────── */

export function getAgent(agentId: string): AcpAgentConfig | null {
  return loadRunnerSettings().agents.find((agent) => agent.id === agentId) || null;
}

export function toPublic(settings: RunnerSettings): PublicRunnerSettings {
  return {
    agents: settings.agents.map(({ env, ...rest }) => ({ ...rest, envKeys: Object.keys(env) })),
    defaultAgentId: settings.defaultAgentId,
    permissionMode: settings.permissionMode,
  };
}

/* ── 写（PATCH 语义：给了哪个字段改哪个） ───────────── */

export interface PatchRunnerSettingsInput {
  agents?: unknown;
  defaultAgentId?: unknown;
  permissionMode?: unknown;
}

/**
 * agents 传的是**完整替换列表**。env 的特殊约定：某条 agent 带着已存在的 id 且
 * **不带 env 字段** → 保留存盘里的 env（浏览器拿不到值，回传时只能这么表达「别动」）；
 * 显式给 env（哪怕 {}）→ 整体替换。
 */
export function patchRunnerSettings(patch: PatchRunnerSettingsInput): RunnerSettings {
  // Validate and persist a detached candidate: rejected writes must not change the live cache.
  const current = loadRunnerSettings();
  if (readFailed) throw conflict("runner-settings.json 损坏或不可读，已保留原文件；请修复文件格式与权限后重试");
  const data = structuredClone(current);

  if (patch.agents !== undefined) {
    if (!Array.isArray(patch.agents)) throw badRequest("agents 必须是数组");
    if (patch.agents.length > MAX_AGENTS) throw badRequest(`agent 最多 ${MAX_AGENTS} 个`);
    const previous = new Map(data.agents.map((agent) => [agent.id, agent]));
    const seen = new Set<string>();
    const next: AcpAgentConfig[] = [];
    for (const raw of patch.agents as any[]) {
      const command = cleanText(raw?.command, 500);
      if (!command) throw badRequest("每个 agent 都要有 command（怎么拉起它）");
      let id = cleanText(raw?.id, 60);
      if (id && !/^[A-Za-z0-9_-]+$/.test(id)) throw badRequest(`agent id 只能是字母数字连字符：「${id}」`);
      if (!id) id = newAgentId();
      if (seen.has(id)) throw badRequest(`agent id 重复：「${id}」`);
      seen.add(id);
      const stored = previous.get(id);
      const envGiven = normalizeEnv(raw?.env);
      next.push({
        id,
        name: cleanText(raw?.name, 80) || command,
        command,
        args: Array.isArray(raw?.args)
          ? raw.args.map((item: unknown) => String(item ?? "")).filter((item: string) => item.length <= 1000).slice(0, 50)
          : [],
        cwd: cleanText(raw?.cwd, 1000) || null,
        // raw.env === undefined 且 id 已存在 → 保留旧 env（见函数注释）
        env: raw?.env === undefined && stored ? stored.env : envGiven || {},
      });
    }
    data.agents = next;
  }

  if (patch.defaultAgentId !== undefined) {
    const id = patch.defaultAgentId === null ? null : cleanText(patch.defaultAgentId, 60) || null;
    if (id && !data.agents.some((agent) => agent.id === id)) throw badRequest(`默认 agent 不存在：「${id}」`);
    data.defaultAgentId = id;
  }
  // agents 列表换过之后默认项可能已不在列表里：静默清空，别让配置自相矛盾
  if (data.defaultAgentId && !data.agents.some((agent) => agent.id === data.defaultAgentId)) data.defaultAgentId = null;

  if (patch.permissionMode !== undefined) {
    const mode = String(patch.permissionMode);
    if (mode !== "ask" && mode !== "auto") throw badRequest(`permissionMode 只能是 ask / auto，收到「${mode}」`);
    data.permissionMode = mode;
  }

  persist(data);
  return data;
}
