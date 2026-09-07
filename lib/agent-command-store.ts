/**
 * 自定义 Agent 指令的存储（<数据目录>/agent-commands.json，原子写）。
 *
 * 内置指令留在代码里（BUILTIN_COMMANDS），这里只存：用户新建的指令、
 * 以及对内置指令的「隐藏 / 改写」覆盖层——升级时内置文案能跟着代码走，用户改过的不被覆盖。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config";
import { ApiError, badRequest, notFound } from "./http";
import { writeAtomic } from "./storage";
import {
  BUILTIN_COMMANDS,
  MAX_COMMAND_DESC,
  MAX_COMMAND_INPUT_HINT,
  MAX_COMMAND_PROMPT,
  MAX_COMMAND_TITLE,
  type AgentCommand,
} from "./agent-commands";
import { AGENT_ICON_NAMES } from "./icon-names";

const FILE = process.env.BLOTBOARD_AGENT_COMMANDS_FILE
  ? path.resolve(process.env.BLOTBOARD_AGENT_COMMANDS_FILE)
  : path.join(DATA_DIR, "agent-commands.json");

const MAX_COMMANDS = 60;
const CUSTOM_ID_RE = /^ac_[a-z0-9]+$/;

interface StoreFile {
  version: string;
  /** 用户新建的指令 */
  custom: AgentCommand[];
  /** 对内置指令的覆盖：id → 局部字段 */
  overrides: Record<string, Partial<AgentCommand>>;
}

const EMPTY: StoreFile = { version: "1.0.0", custom: [], overrides: {} };

function load(): StoreFile {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as StoreFile;
    return {
      version: raw.version || "1.0.0",
      custom: Array.isArray(raw.custom) ? raw.custom : [],
      overrides: raw.overrides && typeof raw.overrides === "object" ? raw.overrides : {},
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ...EMPTY, custom: [], overrides: {} };
    throw err;
  }
}

function save(data: StoreFile): void {
  // 走 storage 的公共原子写：临时文件名带 pid、失败会把半成品清掉（各处自己抄的那几版两样都没有）
  writeAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`);
}

function clean(value: unknown, max: number, field: string, { required = false } = {}): string {
  const text = String(value ?? "").replace(/\x00/g, "").trim();
  if (!text) {
    if (required) throw badRequest(`${field}不能为空`);
    return "";
  }
  return text.slice(0, max);
}

function normalizeIcon(value: unknown): string {
  const icon = String(value || "").trim();
  return (AGENT_ICON_NAMES as readonly string[]).includes(icon) ? icon : "sparkles";
}

/** 内置 + 自定义，按内置在前的顺序返回；内置带上覆盖层。 */
export function listCommands(): AgentCommand[] {
  const data = load();
  const builtins = BUILTIN_COMMANDS.map((command) => {
    const override = data.overrides[command.id];
    return override ? { ...command, ...override, id: command.id, builtin: true } : command;
  });
  return [...builtins, ...data.custom];
}

export function createCommand(input: Record<string, any>): AgentCommand {
  const data = load();
  if (data.custom.length >= MAX_COMMANDS) throw badRequest(`自定义指令最多 ${MAX_COMMANDS} 条`);
  const now = Date.now();
  const command: AgentCommand = {
    id: `ac_${now.toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    icon: normalizeIcon(input.icon),
    title: clean(input.title, MAX_COMMAND_TITLE, "指令标题", { required: true }),
    desc: clean(input.desc, MAX_COMMAND_DESC, "指令说明"),
    prompt: clean(input.prompt, MAX_COMMAND_PROMPT, "指令正文", { required: true }),
    inputHint: clean(input.inputHint, MAX_COMMAND_INPUT_HINT, "输入提示"),
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
  data.custom.push(command);
  save(data);
  return command;
}

export function updateCommand(id: string, input: Record<string, any>): AgentCommand {
  const data = load();

  // 内置指令：只写覆盖层，代码里的原文不动（这样既能改，也能恢复默认）
  const builtin = BUILTIN_COMMANDS.find((command) => command.id === id);
  if (builtin) {
    const override: Partial<AgentCommand> = { ...(data.overrides[id] || {}) };
    if (input.title !== undefined) override.title = clean(input.title, MAX_COMMAND_TITLE, "指令标题", { required: true });
    if (input.desc !== undefined) override.desc = clean(input.desc, MAX_COMMAND_DESC, "指令说明");
    if (input.prompt !== undefined) override.prompt = clean(input.prompt, MAX_COMMAND_PROMPT, "指令正文", { required: true });
    if (input.icon !== undefined) override.icon = normalizeIcon(input.icon);
    if (input.inputHint !== undefined) override.inputHint = clean(input.inputHint, MAX_COMMAND_INPUT_HINT, "输入提示");
    if (input.hidden !== undefined) override.hidden = input.hidden === true;
    override.updatedAt = Date.now();
    data.overrides[id] = override;
    save(data);
    return { ...builtin, ...override, id, builtin: true };
  }

  if (!CUSTOM_ID_RE.test(id)) throw badRequest("指令 id 无效");
  const index = data.custom.findIndex((command) => command.id === id);
  if (index < 0) throw notFound("指令不存在");
  const current = data.custom[index];
  const next: AgentCommand = {
    ...current,
    ...(input.title !== undefined ? { title: clean(input.title, MAX_COMMAND_TITLE, "指令标题", { required: true }) } : {}),
    ...(input.desc !== undefined ? { desc: clean(input.desc, MAX_COMMAND_DESC, "指令说明") } : {}),
    ...(input.prompt !== undefined ? { prompt: clean(input.prompt, MAX_COMMAND_PROMPT, "指令正文", { required: true }) } : {}),
    ...(input.icon !== undefined ? { icon: normalizeIcon(input.icon) } : {}),
    ...(input.inputHint !== undefined ? { inputHint: clean(input.inputHint, MAX_COMMAND_INPUT_HINT, "输入提示") } : {}),
    ...(input.hidden !== undefined ? { hidden: input.hidden === true } : {}),
    updatedAt: Date.now(),
  };
  data.custom[index] = next;
  save(data);
  return next;
}

/** 自定义指令真删；内置指令「删除」= 恢复默认（清掉覆盖层）。 */
export function deleteCommand(id: string): { removed: string; restored: boolean } {
  const data = load();
  if (BUILTIN_COMMANDS.some((command) => command.id === id)) {
    if (!data.overrides[id]) throw new ApiError("内置指令不能删除（可以隐藏）", 400);
    delete data.overrides[id];
    save(data);
    return { removed: id, restored: true };
  }
  if (!CUSTOM_ID_RE.test(id)) throw badRequest("指令 id 无效");
  const before = data.custom.length;
  data.custom = data.custom.filter((command) => command.id !== id);
  if (data.custom.length === before) throw notFound("指令不存在");
  save(data);
  return { removed: id, restored: false };
}
