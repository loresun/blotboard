/**
 * local 任务后端的 Issue 存储（`<data>/issues.json`，原子写，与 lib/storage.ts 同一套手法）。
 *
 * 只有**没配任何外部 Runner** 时才用到这份文件：Issue（含每次「发起任务」生成的 run
 * 与操作日志）全部落在本地，agent 通过 /api/issues 的 PATCH 回写状态（docs/RUNNER.md）。
 * 配了外部 Runner 时真源在对端，这个模块完全不被触碰——两边不会串数据。
 *
 * 存储形状刻意扁平：单文件 JSON、全量读写。Issue 是低频小数据（一条几 KB），
 * 不值得为它抬一套一板一文件的架子；mtime 守卫保证外部脚本直接改文件也能被感知。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { ISSUES_FILE } from "./config";
import { badRequest, conflict, notFound } from "./http";
import { writeAtomic } from "./storage";

/**
 * Issue 状态（local 专用口径，展示文案见 lib/constants.ts ISSUE_STATUS_LABEL）：
 *  pending      待派——Issue 建好了 / prompt 生成了，还没有 agent 接手
 *  in_progress  进行中——agent 已回报开工
 *  blocked      等我处理——agent 失败 / 等输入，需要人来看
 *  review       待验收——留给「完成后要人验一道」的工作流手动使用
 *  done         已完成
 *  aborted      已中止
 *  parked       已搁置
 */
export const LOCAL_ISSUE_STATUSES = ["pending", "in_progress", "blocked", "review", "done", "aborted", "parked"] as const;
export type LocalIssueStatus = (typeof LOCAL_ISSUE_STATUSES)[number];

/** run 状态与任务卡轮询的口径对齐（RUNNER_STATUS_LABEL），多一个 local 专用的「待派」。 */
export const LOCAL_RUN_STATUSES = ["pending", "running", "waiting", "completed", "failed", "aborted"] as const;
export type LocalRunStatus = (typeof LOCAL_RUN_STATUSES)[number];

export interface IssueLogEntry {
  at: number;
  event: string;
  detail?: string;
}

/** ACP run 挂起的权限请求（resolver 在内存表里，这里存的是给任务台渲染的那份） */
export interface RunPermissionRequest {
  at: number;
  /** 从 session/request_permission 的 toolCall 里抠出来的一句人话 */
  title: string;
  options: { optionId: string; name: string; kind: string }[];
}

export interface LocalIssueRun {
  id: string;
  launchedAt: number;
  mode: "implement" | "analyze";
  /** 发起时生成的完整 prompt（Issue 正文 + 深链 + 回写指引），复制给任何 agent 用 */
  prompt: string;
  status: LocalRunStatus;
  note: string | null;
  updatedAt: number;
  /** prompt = 复制给人肉转交（默认，老数据没这字段也算它）；acp = 画板自己 spawn 的 agent 子进程 */
  kind?: "prompt" | "acp";
  /** acp 专属：发起时选的 agent（注册表见 lib/runner-settings.ts） */
  agentId?: string | null;
  agentName?: string | null;
  /** acp 专属：等人批的权限请求（ask 档位下 run 会停在 waiting 直到有人选） */
  permissionRequest?: RunPermissionRequest | null;
}

/**
 * 「这条记录不是 Issue 真源，只是本机执行某条**远程** Issue 的台账」。
 *
 * goal-agent / http 后端下派本机 ACP agent 时才会有：Issue 的真源仍在对端，
 * 画板这边需要一个地方挂 run / transcript / 权限请求，就复用同一套存储开一条带这个
 * 标记的记录。带标记的记录**不进任务台的 Issue 列表**（listIssues 之上有 listOwnIssues
 * 专门筛掉它们）——不然就成了第二本 Issue 账，那正是设计上要避免的。
 */
export interface ExternalIssueRef {
  /** 当时的任务后端种类（goal-agent / http）——换后端后老记录一眼可辨 */
  backend: string;
  /** 对端的 Issue id */
  issueId: string;
  /** 对端的人类编号（identifier），拿不到就是 null */
  number: string | null;
}

export interface LocalIssue {
  id: string;
  /** 人念得出口的编号（L-1、L-2…），对应 goal-agent 的 identifier */
  number: string;
  title: string;
  description: string;
  priority: string;
  status: LocalIssueStatus;
  labels: string[];
  boardId: string | null;
  cardId: string | null;
  createdAt: number;
  updatedAt: number;
  runs: LocalIssueRun[];
  log: IssueLogEntry[];
  /** 有值 = 这是「本机执行远程 Issue」的台账，不是 Issue 真源（见 ExternalIssueRef） */
  external?: ExternalIssueRef | null;
}

interface IssueFile {
  version: string;
  /** 编号自增位（L-<seq>） */
  seq: number;
  issues: LocalIssue[];
}

const DATA_VERSION = "1";
const MAX_LOG_ENTRIES = 200;
const MAX_NOTE = 2000;

function newId(prefix: "i" | "r"): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

/* ── 读写（mtime 守卫缓存 + 原子写） ─────────────────── */

let cache: { file: string; mtimeMs: number; data: IssueFile } | null = null;
let readFailed = false;

function emptyFile(): IssueFile {
  return { version: DATA_VERSION, seq: 0, issues: [] };
}

function loadFile(): IssueFile {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(ISSUES_FILE);
  } catch (error) {
    readFailed = (error as NodeJS.ErrnoException).code !== "ENOENT";
    cache = null;
    return emptyFile();
  }
  if (cache && cache.file === ISSUES_FILE && cache.mtimeMs === stat.mtimeMs) return cache.data;
  try {
    const raw = JSON.parse(fs.readFileSync(ISSUES_FILE, "utf8")) as IssueFile;
    if (!raw || !Array.isArray(raw.issues)) throw new Error("Invalid Issue file structure");
    const data: IssueFile = {
      version: DATA_VERSION,
      seq: Number.isFinite(Number(raw?.seq)) ? Number(raw.seq) : 0,
      issues: Array.isArray(raw?.issues) ? raw.issues : [],
    };
    cache = { file: ISSUES_FILE, mtimeMs: stat.mtimeMs, data };
    readFailed = false;
    return data;
  } catch (err) {
    // 文件坏了不覆盖、不让整个任务台 500：当空库用，等人来修（原文件原样留着）
    console.error("[issues] issues.json 读取失败（按空库处理，不覆盖原文件）；请检查文件格式与权限");
    cache = null;
    readFailed = true;
    return emptyFile();
  }
}

function writableFile(): IssueFile {
  const data = loadFile();
  if (readFailed) throw conflict("issues.json 损坏或不可读，已保留原文件；请修复文件格式与权限后重试");
  return structuredClone(data);
}

function persist(data: IssueFile): void {
  // 走 storage 的公共原子写：临时文件名带 pid、失败会把半成品清掉（各处自己抄的那几版两样都没有）
  writeAtomic(ISSUES_FILE, `${JSON.stringify(data, null, 2)}\n`);
  const stat = fs.statSync(ISSUES_FILE);
  cache = { file: ISSUES_FILE, mtimeMs: stat.mtimeMs, data };
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeLabels(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.map((item) => cleanText(item, 40)).filter(Boolean))].slice(0, 20);
}

function pushLog(issue: LocalIssue, event: string, detail?: string): void {
  issue.log.push({ at: Date.now(), event, ...(detail ? { detail: cleanText(detail, MAX_NOTE) } : {}) });
  // 日志封顶：agent 疯狂回写也不能把单文件撑爆
  if (issue.log.length > MAX_LOG_ENTRIES) issue.log = issue.log.slice(-MAX_LOG_ENTRIES);
}

/* ── 查询 ─────────────────────────────────────────── */

export function listIssues(): LocalIssue[] {
  return loadFile().issues;
}

/** 画板自己的 Issue（筛掉「本机执行远程 Issue」的台账）——任务台列表用这个，不用 listIssues */
export function listOwnIssues(): LocalIssue[] {
  return loadFile().issues.filter((issue) => !issue.external);
}

/** 按（后端, 对端 issueId）反查本机执行台账 */
export function findExternalIssue(backend: string, externalId: string): LocalIssue | null {
  return (
    loadFile().issues.find((issue) => issue.external?.backend === backend && issue.external?.issueId === externalId) ||
    null
  );
}

export function getIssue(id: string): LocalIssue | null {
  return loadFile().issues.find((issue) => issue.id === id) || null;
}

export function requireIssue(id: string): LocalIssue {
  const issue = getIssue(id);
  if (!issue) throw notFound("Issue 不存在");
  return issue;
}

/** 按 run id 反查（任务卡轮询存的是 runId，即 launch 返回的 sessionId）。 */
export function findRun(runId: string): { issue: LocalIssue; run: LocalIssueRun } | null {
  for (const issue of loadFile().issues) {
    const run = (issue.runs || []).find((item) => item.id === runId);
    if (run) return { issue, run };
  }
  return null;
}

/* ── 写 ───────────────────────────────────────────── */

// Mutate detached candidates: failed validation or disk writes must not affect live Issue/run state.

export interface CreateIssueInput {
  title: unknown;
  description: unknown;
  priority?: unknown;
  labels?: unknown;
  boardId?: string | null;
  cardId?: string | null;
  /** 见 ExternalIssueRef：给了就是「本机执行远程 Issue」的台账，不是画板自己的 Issue */
  external?: ExternalIssueRef | null;
}

export function createIssue(input: CreateIssueInput): LocalIssue {
  const title = cleanText(input.title, 300);
  if (!title) throw badRequest("Issue 标题不能为空");
  const data = writableFile();
  const now = Date.now();
  data.seq += 1;
  const issue: LocalIssue = {
    id: newId("i"),
    number: `L-${data.seq}`,
    title,
    // 画板拼装好的正文（上下文 + 评论 + agent 指令）原样落库，不再二次加工
    description: cleanText(input.description, 40_000),
    priority: cleanText(input.priority, 20) || "none",
    status: "pending",
    labels: normalizeLabels(input.labels),
    boardId: input.boardId || null,
    cardId: input.cardId || null,
    createdAt: now,
    updatedAt: now,
    runs: [],
    log: [{ at: now, event: "created" }],
    ...(input.external ? { external: input.external } : {}),
  };
  data.issues.push(issue);
  persist(data);
  return issue;
}

/**
 * 拿到「本机执行这条远程 Issue」的台账：有就复用（同一条远程 Issue 的多次本机执行
 * 记在一起，历史连得上），没有就按对端当前的标题正文新建一条。
 *
 * 刻意每次都刷新标题正文：远程 Issue 改过之后，下一轮派单要用新内容，
 * 而不是拿第一次抓下来的旧快照去跑（「执行的一定是现状」与卡片派单同一条口径）。
 */
export function ensureExternalIssue(input: {
  external: ExternalIssueRef;
  title: unknown;
  description: unknown;
  boardId?: string | null;
  cardId?: string | null;
}): LocalIssue {
  const existing = findExternalIssue(input.external.backend, input.external.issueId);
  if (!existing) {
    return createIssue({
      title: input.title,
      description: input.description,
      boardId: input.boardId || null,
      cardId: input.cardId || null,
      external: input.external,
    });
  }
  const data = writableFile();
  const issue = data.issues.find((item) => item.id === existing.id)!;
  const title = cleanText(input.title, 300);
  const description = cleanText(input.description, 40_000);
  if (title) issue.title = title;
  issue.description = description;
  issue.external = input.external;
  if (input.boardId) issue.boardId = input.boardId;
  if (input.cardId) issue.cardId = input.cardId;
  issue.updatedAt = Date.now();
  persist(data);
  return issue;
}

export interface PatchIssueInput {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  status?: unknown;
  labels?: unknown;
  /** 追加一条日志（agent 的进度备注走这里，不覆盖任何字段） */
  note?: unknown;
}

/**
 * 改 Issue：画板的正文回推（title/description/priority）与 agent 的状态回写
 * （status/labels/note）走同一个函数。不存在返回 null（与 goal-agent 的
 * 「200 + issue:null」口径一致，issue-sync 靠它认出「Issue 已被删」）。
 */
export function patchIssue(id: string, patch: PatchIssueInput): LocalIssue | null {
  const data = writableFile();
  const issue = data.issues.find((item) => item.id === id);
  if (!issue) return null;
  if (patch.title !== undefined) {
    const title = cleanText(patch.title, 300);
    if (title) issue.title = title;
  }
  if (patch.description !== undefined) issue.description = cleanText(patch.description, 40_000);
  if (patch.priority !== undefined) issue.priority = cleanText(patch.priority, 20) || "none";
  if (patch.labels !== undefined) issue.labels = normalizeLabels(patch.labels, issue.labels);
  if (patch.status !== undefined) {
    const status = String(patch.status);
    if (!(LOCAL_ISSUE_STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`Issue 状态无效：「${status}」（可选：${LOCAL_ISSUE_STATUSES.join(" / ")}）`);
    }
    if (status !== issue.status) {
      pushLog(issue, "status", `${issue.status} → ${status}`);
      issue.status = status as LocalIssueStatus;
    }
  }
  if (patch.note !== undefined) {
    const note = cleanText(patch.note, MAX_NOTE);
    if (note) pushLog(issue, "note", note);
  }
  issue.updatedAt = Date.now();
  persist(data);
  return issue;
}

/**
 * 发起任务：挂一个新 run（初始状态「待派」）。
 * prompt 是回调：正文里要写 runId 自己（回写指引指向这个 run），
 * 所以由这里生成 id 后回头找调用方拼——一次事务落盘，不用写两遍。
 */
export function addRun(
  issueId: string,
  input: {
    mode: "implement" | "analyze";
    prompt: (issue: LocalIssue, runId: string) => string;
    kind?: "prompt" | "acp";
    agentId?: string;
    agentName?: string;
  },
): LocalIssueRun {
  const data = writableFile();
  const issue = data.issues.find((item) => item.id === issueId);
  if (!issue) throw notFound("Issue 不存在");
  const now = Date.now();
  const runId = newId("r");
  const run: LocalIssueRun = {
    id: runId,
    launchedAt: now,
    mode: input.mode,
    prompt: input.prompt(issue, runId),
    status: "pending",
    note: null,
    updatedAt: now,
    ...(input.kind === "acp"
      ? { kind: "acp" as const, agentId: input.agentId || null, agentName: input.agentName || null }
      : {}),
  };
  issue.runs.push(run);
  pushLog(issue, "launch", `${run.id}（${input.mode}${input.kind === "acp" ? ` · acp:${input.agentName || input.agentId}` : ""}）`);
  issue.updatedAt = now;
  persist(data);
  return run;
}

/** 有没有还在跑 / 等人的 run——ACP 派单前的并发闸（同一 Issue 同时只允许一个）。 */
export function activeRunOf(issue: LocalIssue): LocalIssueRun | null {
  return (issue.runs || []).find((run) => run.status === "running" || run.status === "waiting") || null;
}

/**
 * 挂 / 摘 ACP run 的权限请求（只动这一个字段，状态由 patchRun 单独走——
 * 两件事分开，日志与状态推导都不用学新入口）。
 */
export function setRunPermissionRequest(
  issueId: string,
  runId: string,
  request: RunPermissionRequest | null,
): void {
  const data = writableFile();
  const issue = data.issues.find((item) => item.id === issueId);
  const run = issue && (issue.runs || []).find((item) => item.id === runId);
  if (!issue || !run) return;
  run.permissionRequest = request;
  run.updatedAt = Date.now();
  issue.updatedAt = run.updatedAt;
  persist(data);
}

/**
 * run 状态回写（agent 走 PATCH /api/issues/:id/runs/:runId）。
 *
 * run 状态顺带把 Issue 状态推着走——local 模式没有别人来推：
 *  running → in_progress；waiting / failed → blocked（等我处理）；
 *  completed → done；aborted → pending（可以重派）。
 * 人工在任务台手动改过的状态之后仍然可以覆盖回来，日志里都有账。
 */
const RUN_TO_ISSUE: Partial<Record<LocalRunStatus, LocalIssueStatus>> = {
  running: "in_progress",
  waiting: "blocked",
  failed: "blocked",
  completed: "done",
  aborted: "pending",
};

export function patchRun(
  issueId: string,
  runId: string,
  patch: { status?: unknown; note?: unknown },
): { issue: LocalIssue; run: LocalIssueRun } {
  const data = writableFile();
  const issue = data.issues.find((item) => item.id === issueId);
  if (!issue) throw notFound("Issue 不存在");
  const run = (issue.runs || []).find((item) => item.id === runId);
  if (!run) throw notFound("run 不存在");
  if (patch.status !== undefined) {
    const status = String(patch.status);
    if (!(LOCAL_RUN_STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`run 状态无效：「${status}」（可选：${LOCAL_RUN_STATUSES.join(" / ")}）`);
    }
    if (status !== run.status) {
      pushLog(issue, "run", `${runId}：${run.status} → ${status}`);
      run.status = status as LocalRunStatus;
      const next = RUN_TO_ISSUE[run.status];
      if (next && next !== issue.status) {
        pushLog(issue, "status", `${issue.status} → ${next}（随 run）`);
        issue.status = next;
      }
    }
  }
  if (patch.note !== undefined) {
    run.note = cleanText(patch.note, MAX_NOTE) || null;
  }
  run.updatedAt = Date.now();
  issue.updatedAt = run.updatedAt;
  persist(data);
  return { issue, run };
}

/* ── 镜头（任务台左栏五个筛选口径，服务端算好计数下发） ── */

export type IssueLens = "all" | "pending" | "in_progress" | "attention" | "done" | "aborted";

/** 「等我处理」：受阻的 Issue，或最近一次 run 失败 / 在等输入（agent 只改了 run 也要能被捞出来）。 */
export function needsAttention(issue: LocalIssue): boolean {
  if (issue.status === "blocked") return true;
  const last = issue.runs[issue.runs.length - 1];
  return Boolean(last && (last.status === "failed" || last.status === "waiting"));
}

/** Issue 属于哪个镜头（互斥，attention 优先——「等我处理」永远不能被别的桶藏起来）。 */
export function lensOf(issue: LocalIssue): Exclude<IssueLens, "all"> {
  if (needsAttention(issue)) return "attention";
  if (issue.status === "done") return "done";
  if (issue.status === "aborted" || issue.status === "parked") return "aborted";
  if (issue.status === "in_progress" || issue.status === "review") return "in_progress";
  return "pending";
}
