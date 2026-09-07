/**
 * 画板存储层（一块板一个 JSON 文件，原子写；接口按「同步事务」抽象，将来换 SQLite 只换本文件实现）。
 *
 * 为什么不再是单个 boards.json：那个方案的每一次写都要把**全库**重新序列化并落盘。
 * 真实数据到 144 块板 / 18.75 MB 时，改一张卡要付 63 ms（两次全库 stringify + 全量写盘），
 * 而且是同步 API——写盘期间整个服务的其他请求都被堵住（实测只读请求 5 ms → 104 ms）。
 * 拆开之后写入代价只与「你正在改的那块板」有关：典型 0.17 ms，最大的板 1.91 ms。
 *
 * 布局：
 *   <data>/boards/_index.json   { version, order: [boardId] }  —— 只存顺序，很小
 *   <data>/boards/<boardId>.json  一块板的完整数据
 *   <data>/boards.json          旧格式；首次启动自动迁移后改名为 boards.legacy-<时间戳>.json 留底
 *
 * - 单进程写入点：Next 路由 handler 都跑在同一个 node 进程里。
 * - mtime 检测：agent/脚本直接改某块板的文件时感知外部写入并只重读那一块
 *   （readdir + 144 次 stat 实测 0.31 ms，可以每次请求都做）。
 * - 原子写：临时文件 + rename，崩溃不会留半个文件。
 */
import fs from "node:fs";
import path from "node:path";
import { BOARDS_DIR, LEGACY_BOARDS_FILE } from "./config";
import type { Board, BoardListItem, BoardsFile } from "./types";
import { ApiError } from "./http";
import { recordBoardHistory, removeBoardHistory } from "./board-history";

const DATA_VERSION = "1.0.0";
const INDEX_FILE = "_index.json";
/** 画板 id 直接当文件名用，必须限死字符集（与 board-schema 的 BOARD_ID_RE 一致）。 */
const BOARD_FILE_RE = /^b_[a-z0-9_]+\.json$/;

interface CacheEntry {
  board: Board;
  mtimeMs: number;
  size: number;
}

let entries = new Map<string, CacheEntry>();
let order: string[] = [];
let cacheDir: string | null = null;
/** 目录签名：文件名 + mtime + size 拼起来，变了才需要重读 */
let scanSignature: string | null = null;
let fileView: BoardsFile | null = null;
/** 解析不了的板文件：不覆盖、不中断整个服务，记下来给 /api/health 暴露 */
let brokenFiles: string[] = [];

function boardFile(id: string): string {
  return path.join(BOARDS_DIR, `${id}.json`);
}

function statOf(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/**
 * 原子写：临时文件 + rename。**全仓所有落盘都走这一个口**——板文件、快照、
 * Issue、卡片包开关、规格、agent 指令、Runner 设置，它们对「写到一半崩了不能留半个文件」
 * 的要求完全一样，没理由各抄一份（抄出来的那几份还各自忘了清临时文件）。
 *
 * 临时文件名带 pid + 时间戳：同一个文件被并发写时两个 tmp 不会撞在一起
 * （固定叫 `<file>.tmp` 的写法会让后一个把前一个的半成品 rename 出去）。
 *
 * 失败时**一定要把 tmp 删掉**：writeFileSync 可能写了一半就 ENOSPC，
 * rename 可能撞上只读挂载。不清理的话数据目录里会攒下一堆 `.xxx.json.<pid>.tmp`
 * ——它们不匹配 `boards/b_*.json` 的扫描口径，永远不会被谁认领，也永远不会被谁删。
 * 清理本身再失败就吞掉：这时候要报给上层的是**原始那个错**，不是「删临时文件也失败了」。
 */
export function writeAtomic(file: string, content: string, { mode = 0o600 }: { mode?: number } = {}): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.writeFileSync(temp, content, { mode });
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 兜底清理失败不能盖掉原始错误
    }
    throw err;
  }
}

/* ── 迁移：单文件 → 一板一文件 ─────────────────────── */

/**
 * 旧的 boards.json 还在、而新目录还没有时，做一次迁移。
 * 先把所有板写进一个临时目录，再整目录 rename 过去——中途崩了也不会留下半套数据。
 * 原文件不删，改名留底（boards.legacy-<时间戳>.json）。
 */
function migrateIfNeeded(): void {
  if (fs.existsSync(BOARDS_DIR)) return;
  const legacy = statOf(LEGACY_BOARDS_FILE);
  if (!legacy) {
    fs.mkdirSync(BOARDS_DIR, { recursive: true });
    writeAtomic(path.join(BOARDS_DIR, INDEX_FILE), JSON.stringify({ version: DATA_VERSION, order: [] }, null, 2));
    return;
  }
  const payload = JSON.parse(fs.readFileSync(LEGACY_BOARDS_FILE, "utf8")) as BoardsFile;
  if (!Array.isArray(payload?.boards)) throw new Error("boards.json 格式无效（缺 boards 数组）");
  const staging = `${BOARDS_DIR}.migrating-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const ids: string[] = [];
  for (const board of payload.boards) {
    if (!board?.id || !BOARD_FILE_RE.test(`${board.id}.json`)) continue;
    fs.writeFileSync(path.join(staging, `${board.id}.json`), JSON.stringify(board), { mode: 0o600 });
    ids.push(board.id);
  }
  fs.writeFileSync(path.join(staging, INDEX_FILE), JSON.stringify({ version: DATA_VERSION, order: ids }, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(staging, BOARDS_DIR);
  const backup = path.join(
    path.dirname(LEGACY_BOARDS_FILE),
    `${path.basename(LEGACY_BOARDS_FILE, ".json")}.legacy-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  try {
    fs.renameSync(LEGACY_BOARDS_FILE, backup);
  } catch {
    /* 改名失败不影响新目录已经就位；下次启动因为目录已存在也不会重复迁移 */
  }
  console.log(`[board] 已迁移 ${ids.length} 块画板到 ${BOARDS_DIR}（原文件留底：${path.basename(backup)}）`);
}

/* ── 读 ───────────────────────────────────────────── */

function readIndexOrder(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(BOARDS_DIR, INDEX_FILE), "utf8"));
    return Array.isArray(raw?.order) ? raw.order.filter((id: unknown) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeIndex(): void {
  writeAtomic(path.join(BOARDS_DIR, INDEX_FILE), JSON.stringify({ version: DATA_VERSION, order }, null, 2));
}

/** 扫目录：返回 [id, stat] 列表与一个签名；签名没变就整批复用缓存。 */
function scan(): { found: Map<string, fs.Stats>; signature: string } {
  const found = new Map<string, fs.Stats>();
  const parts: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(BOARDS_DIR);
  } catch {
    return { found, signature: "" };
  }
  names.sort();
  for (const name of names) {
    if (!BOARD_FILE_RE.test(name)) continue;
    const stat = statOf(path.join(BOARDS_DIR, name));
    if (!stat?.isFile()) continue;
    const id = name.slice(0, -5);
    found.set(id, stat);
    parts.push(`${id}:${stat.mtimeMs}:${stat.size}`);
  }
  return { found, signature: parts.join("|") };
}

export function load(): BoardsFile {
  if (cacheDir !== BOARDS_DIR) {
    entries = new Map();
    order = [];
    scanSignature = null;
    fileView = null;
    brokenFiles = [];
    migrateIfNeeded();
    cacheDir = BOARDS_DIR;
  }
  const { found, signature } = scan();
  if (signature === scanSignature && fileView) return fileView;

  const broken: string[] = [];
  const next = new Map<string, CacheEntry>();
  for (const [id, stat] of found) {
    const cached = entries.get(id);
    // 只重读 mtime/size 变过的那些板，其余直接复用已解析好的对象
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      next.set(id, cached);
      continue;
    }
    try {
      const board = JSON.parse(fs.readFileSync(boardFile(id), "utf8")) as Board;
      if (!board || typeof board !== "object" || board.id !== id) throw new Error("画板文件内容与文件名不符");
      next.set(id, { board, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (err) {
      // 单块板坏掉不该让整个服务不可用：保留上一份可用副本（没有就跳过），且绝不覆盖坏文件
      broken.push(id);
      if (cached) next.set(id, cached);
      console.error(`[board] 画板文件读取失败，已跳过：${boardFile(id)} → ${String((err as Error)?.message || err)}`);
    }
  }

  entries = next;
  brokenFiles = broken;
  const indexOrder = readIndexOrder();
  const seen = new Set<string>();
  const nextOrder: string[] = [];
  for (const id of indexOrder) {
    if (entries.has(id) && !seen.has(id)) {
      seen.add(id);
      nextOrder.push(id);
    }
  }
  // 索引里没有的（外部直接丢进来的板文件）按 id 追加到末尾，不让它们凭空消失
  for (const id of entries.keys()) if (!seen.has(id)) nextOrder.push(id);
  order = nextOrder;
  scanSignature = signature;
  fileView = { version: DATA_VERSION, boards: order.map((id) => entries.get(id)!.board) };
  return fileView;
}

/** 解析失败的画板文件（给 /api/health 暴露，别让数据问题只留在日志里）。 */
export function brokenBoardFiles(): string[] {
  load();
  return [...brokenFiles];
}

export function list(): BoardListItem[] {
  return load().boards.map((board) => ({
    id: board.id,
    name: board.name,
    parentId: board.parentId ?? null,
    group: board.group || "",
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    counts: {
      cards: board.cards?.length || 0,
      edges: board.edges?.length || 0,
      tasks: (board.cards || []).filter((card) => card.type === "task").length,
      comments: board.comments?.length || 0,
      openComments: (board.comments || []).filter((comment) => !comment.resolved).length,
    },
  }));
}

export function get(id: string): Board | null {
  load();
  return entries.get(id)?.board || null;
}

export function requireBoard(id: string): Board {
  const board = get(id);
  if (!board) throw new ApiError("画板不存在", 404);
  return board;
}

/* ── 写 ───────────────────────────────────────────── */

function persist(board: Board): void {
  const file = boardFile(board.id);
  writeAtomic(file, `${JSON.stringify(board)}\n`);
  const stat = statOf(file);
  entries.set(board.id, { board, mtimeMs: stat?.mtimeMs ?? Date.now(), size: stat?.size ?? 0 });
  // 自己写完要把签名一起更新，否则下一次 load() 会以为是外部改动，白重读一遍
  scanSignature = null;
  fileView = null;
}

/**
 * 单块板的读-改-写事务：mutator 抛异常时回滚这块板的内存副本，不落盘。
 * 快照只针对这一块板（几 KB 到几百 KB），不是全库——这正是拆文件换来的。
 */
export function mutateBoard<T>(boardId: string, mutator: (board: Board, data: BoardsFile) => T, options: { history?: boolean } = {}): T {
  const data = load();
  const board = entries.get(boardId)?.board;
  if (!board) throw new ApiError("画板不存在", 404);
  const snapshot = JSON.stringify(board);
  let result: T;
  try {
    result = mutator(board, data);
    // Every committed revision is distinct, including two writes in one millisecond.
    const previousRevision = (JSON.parse(snapshot) as Board).updatedAt;
    board.updatedAt = Math.max(Date.now(), previousRevision + 1, board.updatedAt);
    // Disk failure is also a failed transaction; never keep an unsaved board in cache.
    persist(board);
  } catch (err) {
    const restored = JSON.parse(snapshot) as Board;
    const current = entries.get(boardId);
    entries.set(boardId, {
      board: restored,
      mtimeMs: current?.mtimeMs ?? 0,
      size: current?.size ?? 0,
    });
    fileView = null;
    throw err;
  }
  if (options.history !== false) recordBoardHistory(JSON.parse(snapshot) as Board, board);
  return result;
}

/** 新建画板：builder 能读到现有全部板（继承分组、查重名这类），返回的板会被写成新文件。 */
export function insertBoard(build: (data: BoardsFile) => Board): Board {
  const data = load();
  const board = build(data);
  if (!BOARD_FILE_RE.test(`${board.id}.json`)) throw new ApiError("画板 id 无效", 400);
  if (entries.has(board.id)) throw new ApiError("画板 id 已存在", 409);
  persist(board);
  order = [board.id, ...order];
  writeIndex();
  return board;
}

export function dropBoard(boardId: string): void {
  load();
  if (!entries.has(boardId)) throw new ApiError("画板不存在", 404);
  entries.delete(boardId);
  order = order.filter((id) => id !== boardId);
  fileView = null;
  scanSignature = null;
  try {
    fs.unlinkSync(boardFile(boardId));
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  writeIndex();
  // Step history is for an existing board; deleted-board recovery uses checkpoints.
  removeBoardHistory(boardId);
}

/** 测试钩子：丢弃内存缓存（冒烟脚本切换数据目录时用）。 */
export function resetCache(): void {
  entries = new Map();
  order = [];
  cacheDir = null;
  scanSignature = null;
  fileView = null;
  brokenFiles = [];
}
