/**
 * 改板安全网：**批量写入前的自动快照**（checkpoint）与回滚。
 *
 * 为什么要有：`PUT /whole`、信封落板、`POST /paste`、`POST /tidy`、批量改 / 批量删
 * 这些入口都是「一条命令改一大片」，直接覆盖 `<data>/boards/<id>.json`——
 * agent 写坏一块 200 张卡的板是真实风险，而画板本身只有「删卡撤销」这种单点回退。
 * 所以在每个批量入口动手**之前**，先把整块板原样存一份；出事就整块倒回去。
 *
 * 三条边界，写代码前先记住：
 *
 * 1. **绝不阻断主写入**。打点失败（磁盘满、目录只读、板文件正好读不出来）一律
 *    吞掉异常打一行日志，返回 null——安全网坏了是「这次没有回头路」，
 *    不该升级成「这次改不了板」。快照也不进 mutateBoard 的事务里，
 *    它只是在事务开始前照了张相。
 *
 * 2. **不跟 storage 的 mtime / stale 机制打架**。快照写在 `<data>/checkpoints/` 下，
 *    storage 的目录扫描只认 `<data>/boards/b_*.json`，两边看不见对方：
 *    打一次点不会改板文件的 mtime、不会 bump `board.updatedAt`、
 *    因此也不会让浏览器手上的版本号变 stale（照相不是改动）。
 *    反过来，**回滚是一次正常的写**——走 store.mutateBoard、照常 bump updatedAt，
 *    别的窗口下一跳轮询就会看到板变了并重拉，这正是想要的。
 *
 * 3. **单卡编辑不打点**。那条路本来就有编辑抽屉的自动保存与删除撤销；
 *    每改一个字存一份 800 KB 的板，安全网会先把磁盘吃光。
 *    纯几何（`PUT /state`，拖一次卡就写一次）同理不打点。
 *
 * 布局：
 *   <data>/checkpoints/<boardId>/<时间戳>-<原因>.json   整板快照（就是板文件本身的样子）
 *   <data>/checkpoints/<boardId>/index.json             清单缓存（时间 / 原因 / 计数 / 大小）
 *
 * 清单为什么要缓存：列表接口要显示「这份快照里有多少张卡」，而那只能从文件内容里数。
 * 最大的板 866 KB × 10 份 = 每次开抽屉解析 8 MB JSON。索引把它降成一次小文件读；
 * 索引丢了 / 对不上时按目录现算并补回去（自愈），所以手工删快照文件也不会读出幽灵条目。
 *
 * 板被删掉时**故意不清**对应的快照目录：那时候快照反而是最后一根稻草——
 * 把某份 `<时间戳>-<原因>.json` 拷回 `<data>/boards/<id>.json` 就能把整块板捞回来。
 * 但「故意留」不等于「永远留」：`prune` 只在打点时触发，板都没了就再没人往那个目录里写，
 * 于是它会一直躺着。所以另有一道**孤儿清理**（`sweepOrphanCheckpoints`），
 * 只收走「板不在了 **且** 目录已经 TTL 天没动过」的那些，TTL 由
 * `BLOTBOARD_CHECKPOINT_ORPHAN_TTL_DAYS` 定（默认 30 天，`0` = 永不清）。
 */
import fs from "node:fs";
import path from "node:path";
import { BOARDS_DIR, CHECKPOINTS_DIR, CHECKPOINT_KEEP, CHECKPOINT_ORPHAN_TTL_DAYS } from "./config";
import { BOARD_ID_RE } from "./normalize-base";
import { ApiError } from "./http";
import { writeAtomic } from "./storage";
import type { Board, BoardActivityAction } from "./types";

/** 打点的原因 = 触发它的那个批量入口，与工作日志的 action 同一套词表。 */
export type CheckpointReason = BoardActivityAction;

/** 文件名里的时间戳：ISO 去掉冒号和点，字典序 = 时间序（列表排序不用再解析日期）。 */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([a-z]+)\.json$/;
const INDEX_FILE = "index.json";

export interface CheckpointInfo {
  /** 时间戳字符串，同时是这份快照的 id（API 路径里用它） */
  stamp: string;
  reason: CheckpointReason | string;
  /** 毫秒时间戳（stamp 解析出来的，前端直接格式化） */
  at: number;
  counts: { cards: number; edges: number; comments: number };
  bytes: number;
}

interface IndexFile {
  version: 1;
  items: CheckpointInfo[];
}

export function checkpointsEnabled(): boolean {
  return CHECKPOINT_KEEP > 0;
}

export function checkpointKeep(): number {
  return CHECKPOINT_KEEP;
}

function boardDir(boardId: string): string {
  return path.join(CHECKPOINTS_DIR, boardId);
}

/** stamp → 毫秒。格式是自己写出去的，解析失败就返回 0（列表照样能显示，只是时间为空）。 */
function stampToMs(stamp: string): number {
  const iso = stamp.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z",
  );
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function msToStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, "-");
}

/** 路径参数一律先过闸：boardId / stamp 直接拼进文件路径，不能让 `..` 混进来。 */
export function assertStamp(stamp: string): string {
  if (!STAMP_RE.test(stamp || "")) throw new ApiError("快照 id 无效", 400);
  return stamp;
}

function assertBoardDirId(boardId: string): string {
  if (!BOARD_ID_RE.test(boardId || "")) throw new ApiError("画板 id 无效", 400);
  return boardId;
}

/* ── 索引 ─────────────────────────────────────────── */

function readIndex(dir: string): Map<string, CheckpointInfo> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), "utf8")) as IndexFile;
    const map = new Map<string, CheckpointInfo>();
    for (const item of raw?.items || []) {
      if (item && typeof item.stamp === "string") map.set(item.stamp, item);
    }
    return map;
  } catch {
    return new Map();
  }
}

function writeIndex(dir: string, items: CheckpointInfo[]): void {
  writeAtomic(path.join(dir, INDEX_FILE), `${JSON.stringify({ version: 1, items } satisfies IndexFile, null, 2)}\n`);
}

/** 索引里没有这份快照时现算一条（手工放进去的、或索引丢了）。 */
function measure(file: string, stamp: string, reason: string, bytes: number): CheckpointInfo {
  let counts = { cards: 0, edges: 0, comments: 0 };
  try {
    const board = JSON.parse(fs.readFileSync(file, "utf8")) as Board;
    counts = {
      cards: board?.cards?.length || 0,
      edges: board?.edges?.length || 0,
      comments: board?.comments?.length || 0,
    };
  } catch {
    /* 读不出来就当空的：列表要能显示出这份坏快照，用户才知道它在那儿 */
  }
  return { stamp, reason, at: stampToMs(stamp), counts, bytes };
}

/**
 * 扫一块板的快照目录，返回**按时间倒序**的清单（最新在前）。
 * 目录是真源，索引只是加速；对不上就按目录重写索引。
 */
export function listCheckpoints(boardId: string): CheckpointInfo[] {
  if (!checkpointsEnabled()) return [];
  const dir = boardDir(assertBoardDirId(boardId));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const cached = readIndex(dir);
  const items: CheckpointInfo[] = [];
  let indexStale = false;
  for (const name of names) {
    const match = FILE_RE.exec(name);
    if (!match) continue;
    const [, stamp, reason] = match;
    let bytes = 0;
    try {
      bytes = fs.statSync(path.join(dir, name)).size;
    } catch {
      continue;
    }
    const hit = cached.get(stamp);
    if (hit && hit.reason === reason && hit.bytes === bytes) {
      items.push(hit);
      continue;
    }
    indexStale = true;
    items.push(measure(path.join(dir, name), stamp, reason, bytes));
  }
  items.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  // 索引里多出来的条目（文件被手工删了）也算不一致：一起写回去
  if (indexStale || cached.size !== items.length) {
    try {
      writeIndex(dir, items);
    } catch {
      /* 索引写不动不影响读（下次再算一遍） */
    }
  }
  return items;
}

/* ── 打点 ─────────────────────────────────────────── */

/**
 * 给这块板照一张相，返回快照 id（stamp）；功能关掉或出任何问题都返回 null。
 *
 * **绝不抛异常**——调用方拿到 null 只意味着「这次没有回头路」，主写入照常进行。
 * 参数收的是板对象而不是 id：调用方本来就刚从 storage 拿过它，
 * 这里再读一次文件既慢又可能读到不一致的一版。
 */
export function captureCheckpoint(board: Board, reason: CheckpointReason): string | null {
  if (!checkpointsEnabled()) return null;
  try {
    if (!BOARD_ID_RE.test(board?.id || "")) return null;
    const dir = boardDir(board.id);
    fs.mkdirSync(dir, { recursive: true });
    // 同一毫秒内连着打两次同类型的点会撞名（批量脚本能做到）：往后挪一毫秒，别互相覆盖
    let ms = Date.now();
    let stamp = msToStamp(ms);
    while (fs.existsSync(path.join(dir, `${stamp}-${reason}.json`))) {
      ms += 1;
      stamp = msToStamp(ms);
    }
    const file = path.join(dir, `${stamp}-${reason}.json`);
    const content = `${JSON.stringify(board)}\n`;
    writeAtomic(file, content);
    const info: CheckpointInfo = {
      stamp,
      reason,
      at: ms,
      counts: {
        cards: board.cards?.length || 0,
        edges: board.edges?.length || 0,
        comments: board.comments?.length || 0,
      },
      bytes: Buffer.byteLength(content),
    };
    prune(dir, info);
    return stamp;
  } catch (err) {
    // 安全网坏了不该把主写入一起拖下水（本模块抬头第 1 条）
    console.error(`[board] 写快照失败，本次改动没有回滚点：${board?.id} → ${String((err as Error)?.message || err)}`);
    return null;
  }
}

/** 保留最近 KEEP 份，多的删最旧；顺手把索引写成当前状态。 */
function prune(dir: string, fresh: CheckpointInfo): void {
  const kept: CheckpointInfo[] = [fresh];
  const cached = readIndex(dir);
  for (const name of fs.readdirSync(dir)) {
    const match = FILE_RE.exec(name);
    if (!match || match[1] === fresh.stamp) continue;
    const [, stamp, reason] = match;
    const hit = cached.get(stamp);
    let bytes = 0;
    try {
      bytes = fs.statSync(path.join(dir, name)).size;
    } catch {
      continue;
    }
    kept.push(hit && hit.reason === reason && hit.bytes === bytes ? hit : measure(path.join(dir, name), stamp, reason, bytes));
  }
  kept.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  for (const gone of kept.splice(CHECKPOINT_KEEP)) {
    try {
      fs.unlinkSync(path.join(dir, `${gone.stamp}-${gone.reason}.json`));
    } catch {
      /* 已经不在了就算了 */
    }
  }
  writeIndex(dir, kept);
}

/* ── 读 / 删 ──────────────────────────────────────── */

/** 取一份快照的整板内容；不存在返回 null（调用方转 404）。 */
export function readCheckpoint(boardId: string, stamp: string): Board | null {
  if (!checkpointsEnabled()) return null;
  const dir = boardDir(assertBoardDirId(boardId));
  assertStamp(stamp);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const name = names.find((entry) => {
    const match = FILE_RE.exec(entry);
    return match && match[1] === stamp;
  });
  if (!name) return null;
  try {
    const board = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Board;
    return board && typeof board === "object" ? board : null;
  } catch (err) {
    throw new ApiError("快照文件读不出来，请检查快照格式与存储权限", 500);
  }
}

/** 删一份快照；返回是否真的删掉了。 */
export function deleteCheckpoint(boardId: string, stamp: string): boolean {
  const dir = boardDir(assertBoardDirId(boardId));
  assertStamp(stamp);
  let removed = false;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    const match = FILE_RE.exec(name);
    if (!match || match[1] !== stamp) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed = true;
    } catch {
      /* 并发删掉了 */
    }
  }
  // 重扫一次顺便把索引写正（listCheckpoints 自愈）
  if (removed) listCheckpoints(boardId);
  return removed;
}

/* ── 孤儿清理 ─────────────────────────────────────── */

interface OrphanSweepState {
  swept: boolean;
}

/** 进程级一次性标记；Next 生产构建里每条路由是独立 bundle，模块级变量在路由之间不是同一份 */
function sweepState(): OrphanSweepState {
  const g = globalThis as any;
  if (!g.__blotboardCheckpointSweep) g.__blotboardCheckpointSweep = { swept: false };
  return g.__blotboardCheckpointSweep as OrphanSweepState;
}

/**
 * 收走「板已经不在了」的快照目录，返回删掉的目录数。
 *
 * 判定两条**都**要满足：
 *  · `<data>/boards/<id>.json` 不存在——板还在的话这目录是活的安全网，一份都不能动；
 *  · 目录 mtime 距今超过 TTL——板刚删掉的那几天，快照正是「删错了还能捞回来」的唯一依据。
 *    用目录 mtime 而不是文件名里的时间戳：目录 mtime 在最后一次增删快照时就冻住了，
 *    而板既然已经删了，之后不会再有人往里写，所以它恰好等于「这摊东西闲置了多久」。
 *
 * `TTL = 0` 直接返回 0（永不清）；整块功能关掉（KEEP=0）时也不扫——
 * 那种部署根本没打过点，目录里要么空要么是上一次开着时留下的，删它没有授权。
 *
 * **绝不抛异常**（本模块抬头第 1 条）：清理是后台便利，失败只该少删几个目录，
 * 不该把触发它的那个请求带下水。
 */
export function sweepOrphanCheckpoints(): number {
  if (!checkpointsEnabled() || CHECKPOINT_ORPHAN_TTL_DAYS <= 0) return 0;
  let names: string[];
  try {
    names = fs.readdirSync(CHECKPOINTS_DIR);
  } catch {
    return 0; // 还没打过点，目录不存在
  }
  const cutoff = Date.now() - CHECKPOINT_ORPHAN_TTL_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    // 只碰形如 b_xxx 的目录：别人手工放进来的东西不归我们删
    if (!BOARD_ID_RE.test(name)) continue;
    const dir = path.join(CHECKPOINTS_DIR, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      if (fs.existsSync(path.join(BOARDS_DIR, `${name}.json`))) continue;
      if (fs.statSync(dir).mtimeMs > cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
      console.log(`[board] 清掉孤儿快照目录（板已删且闲置超过 ${CHECKPOINT_ORPHAN_TTL_DAYS} 天）：${name}`);
    } catch (err) {
      console.error(`[board] 孤儿快照目录清理失败（跳过）：${name} → ${String((err as Error)?.message || err)}`);
    }
  }
  return removed;
}

/**
 * 进程内跑一次孤儿清理（第一次有人列画板时懒触发）。
 *
 * 不放进 server.mjs：那是 .mjs，进不来 TS 模块；也不想让它挤在启动主路径上
 * （数据目录大的话 readdir + 逐个 stat 要走一小会儿，用户在等首页）。
 * 懒触发的效果等价——反正没人用这个服务的时候，磁盘多躺几个目录没有代价。
 * 与 ACP 的 `ensureStartupSweep` 同一套路数。
 */
export function ensureOrphanSweep(): void {
  const state = sweepState();
  if (state.swept) return;
  state.swept = true;
  try {
    sweepOrphanCheckpoints();
  } catch (err) {
    console.error(`[board] 孤儿快照清理没跑起来：${String((err as Error)?.message || err)}`);
  }
}
