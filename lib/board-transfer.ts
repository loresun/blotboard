/**
 * 画板包的两头（服务端）：**打包带走**与**收包立起来**。
 *
 * 格式本身与纯计算的那一半在 lib/board-bundle.ts；这里负责一切碰磁盘与真源的事——
 * 挑板、读附件字节、还原附件、把板写进 storage。
 *
 * 三条不能含糊的规矩：
 *  ① **导入永远是「新建板」**，绝不悄悄改动已有的板。同 id 撞上时由调用方选
 *     skip / replace / copy，默认 skip——「恢复备份」把别人今天的活覆盖掉是不可逆的。
 *  ② **副本要断干净外部引用**：copy 出来的任务卡不继承 Issue / 任务 id（那是**另一台机器**
 *     的主键，跟着复制过来，点一下「发起任务」就打到别人的工作项上了）。
 *     restore（同机恢复自己的备份）才保留。
 *  ③ **附件字节自带**：包里带 base64，或者（HTML 产物）从 `<img data-asset>` 里取。
 *     还原时走与上传同一套校验（签名 / 大小 / 白名单），本机重新分配 uploadId。
 */
import { UPLOADS_DIR } from "./config";
import { ApiError, badRequest } from "./http";
import * as store from "./storage";
import {
  BUNDLE_LIMITS,
  BundleFormatError,
  bundleUploadIds,
  makeBoardBundle,
  parseBoardBundle,
  remapBoards,
  type BoardBundle,
  type BundleAsset,
  type BundleBoard,
  type BundleVolume,
} from "./board-bundle";
import {
  COMMENT_ID_RE,
  EDGE_ID_RE,
  MAX_EDGE_LABEL,
  cleanText,
  newId,
  normalizeBoardSettings,
  normalizeCardInput,
  normalizeCommentInput,
  normalizeEdgeColor,
  normalizeEdgeKind,
  normalizeEdgeStyle,
  normalizeEdgeTags,
  normalizeEdgeWeight,
  normalizeEdgeWidth,
  normalizeViewport,
  passthroughCard,
} from "./board-schema";
import { pruneFrameLinks } from "./board-service";
import { captureCheckpoint } from "./checkpoints";
import { pushActivity } from "./board-activity";
import {
  mediaTypeForId,
  readUploadBytes,
  sanitizeUploadName,
  storeUploadBytes,
  uploadExists,
  uploadSize,
} from "./uploads";
import { uploadFormatFor } from "./upload-accept";
import type { Board, BoardActor, BoardCard, BoardComment, BoardEdge } from "./types";
import packageJson from "../package.json";

/* ── 挑板：ids / group / all，再按需要把「跟着走的板」拉进来 ── */

export interface SelectOptions {
  ids?: string[];
  group?: string | null;
  all?: boolean;
  /** 把子画板与被 board 卡指到的板一起带上（默认开） */
  children?: boolean;
}

/**
 * 这次要导哪几块板。**结果永远是完整的那一批**，不截断。
 *
 * `children` 默认开是有理由的：子画板卡指向的板不带走的话，对端点开那张卡就是死链——
 * 用户以为自己导的是「这块板」，实际导的是「这块板的一层皮」。
 *
 * 这里以前攒到 `BUNDLE_LIMITS.boards` 就 `break`，于是一个 201 块板的分组导出去只有 200 块、
 * HTTP 还是 200、notes 还是空的——**用户手里那份「成功的备份」是残的，而残不残只有真去恢复
 * 那天才知道**。挑板这一步不该管容量：它只回答「要哪些」，能不能装进一份包由
 * planBoardVolumes 回答，装不下就分卷（每卷都是完整可导入的包），绝不悄悄少给。
 * 环状引用（A 的板卡指 B、B 的板卡指回 A）由 picked 去重挡住，跟以前一样。
 */
export function selectBoards(options: SelectOptions = {}): Board[] {
  const wantChildren = options.children !== false;
  const all = store.load().boards;
  const byId = new Map(all.map((board) => [board.id, board]));
  const childrenOf = new Map<string, Board[]>();
  if (wantChildren) {
    for (const board of all) {
      if (!board.parentId) continue;
      const siblings = childrenOf.get(board.parentId);
      if (siblings) siblings.push(board);
      else childrenOf.set(board.parentId, [board]);
    }
  }

  let seeds: Board[];
  if (options.ids?.length) {
    seeds = options.ids.map((id) => {
      const board = byId.get(id);
      if (!board) throw new ApiError(`画板不存在：${id}`, 404);
      return board;
    });
  } else if (options.group !== undefined && options.group !== null) {
    const group = String(options.group);
    seeds = all.filter((board) => (board.group || "") === group);
    if (!seeds.length) throw new ApiError(`分组里没有画板：${group || "未分组"}`, 404);
  } else if (options.all) {
    seeds = all;
  } else {
    throw badRequest("要导哪些板：给 ids（逗号分隔）、group（整个分组）或 all=1（整个库）");
  }

  const picked = new Map<string, Board>();
  const queue = [...seeds];
  while (queue.length) {
    const board = queue.shift()!;
    if (picked.has(board.id)) continue;
    picked.set(board.id, board);
    if (!wantChildren) continue;
    for (const child of childrenOf.get(board.id) || []) queue.push(child);
    for (const card of board.cards || []) {
      const target = card.boardRef?.boardId ? byId.get(card.boardRef.boardId) : null;
      if (target) queue.push(target);
    }
  }
  return [...picked.values()];
}

/* ── 分卷：装不下就分几份，绝不少给 ────────────── */

export interface VolumePlan {
  /** 整套一共多少块板 */
  total: number;
  /** 一份包最多装多少块 */
  limit: number;
  /** 一共几卷（total 为 0 时也算 1 卷：一份空包也是个完整答案） */
  volumes: number;
  /** 每一卷的范围，给调用方拼取回地址用 */
  slices: { index: number; offset: number; count: number }[];
}

/**
 * 这批板要分几卷。
 *
 * 顺序就是 selectBoards 的顺序（store 的板序 + 广度优先的子板扩展），**同样的入参每次同样的分卷**——
 * 不稳定的话「昨天的第 2 卷」和「今天的第 2 卷」装的不是同一批板，逐卷备份就没有意义了。
 */
export function planBoardVolumes(total: number, limit = BUNDLE_LIMITS.boards): VolumePlan {
  const size = Math.max(1, limit);
  const volumes = Math.max(1, Math.ceil(total / size));
  const slices = Array.from({ length: volumes }, (_unused, at) => ({
    index: at + 1,
    offset: at * size,
    count: Math.min(size, Math.max(0, total - at * size)),
  }));
  return { total, limit: size, volumes, slices };
}

/** 取第 index 卷（从 1 数）。越界当场报错，不静默给空包。 */
export function boardVolumeSlice<T>(boards: T[], index: number, limit = BUNDLE_LIMITS.boards): T[] {
  const plan = planBoardVolumes(boards.length, limit);
  if (!Number.isInteger(index) || index < 1 || index > plan.volumes) {
    throw badRequest(`volume 只能是 1–${plan.volumes}（这批一共 ${plan.total} 块板，每卷最多 ${plan.limit} 块）`);
  }
  const slice = plan.slices[index - 1];
  return boards.slice(slice.offset, slice.offset + slice.count);
}

/* ── 打包 ─────────────────────────────────────── */

export interface BuildBundleOptions {
  /** 把附件字节打进包里（默认开；HTML 产物那条路传 false，图片已经在正文里了） */
  assets?: boolean;
  /** 附件总字节上限，超了就只留引用 */
  assetsMaxBytes?: number;
  origin?: string;
  now?: number;
  /** 这是整套备份的第几卷（不分卷时不传） */
  volume?: BundleVolume;
}

export function buildBoardBundle(boards: Board[], options: BuildBundleOptions = {}): BoardBundle {
  const {
    assets: withAssets = true,
    assetsMaxBytes = BUNDLE_LIMITS.assetBytes,
    origin,
    now = Date.now(),
    volume,
  } = options;
  const notes: string[] = [];
  const packed: BundleAsset[] = [];

  if (volume && volume.total > 1) {
    notes.push(
      `这是分卷备份的第 ${volume.index} / ${volume.total} 卷（整套 ${volume.totalBoards} 块画板，本卷 ${boards.length} 块）：` +
        "每一卷都能单独导入，但要恢复完整的库得把每一卷都导一遍；跨卷的子画板引用要等对应那卷导进来才连得上",
    );
  }

  const wanted = bundleUploadIds(boards);
  if (wanted.length) {
    // 先按大小挑，再读字节：200 MB 的视频没必要先进内存再被放弃
    let budget = assetsMaxBytes;
    let skipped = 0;
    for (const id of wanted) {
      const size = uploadSize(id);
      if (size === null) {
        notes.push(`附件已不在本机，包里只留了引用：${id}`);
        continue;
      }
      const name = uploadNameOf(boards, id) || id;
      const entry: BundleAsset = { id, name, mediaType: mediaTypeForId(id), bytes: size };
      if (!withAssets) {
        packed.push(entry);
        continue;
      }
      if (size > budget) {
        skipped += 1;
        packed.push(entry);
        continue;
      }
      const read = readUploadBytes(id);
      if (!read) {
        notes.push(`附件读不出来，包里只留了引用：${id}`);
        packed.push(entry);
        continue;
      }
      budget -= size;
      packed.push({ ...entry, mediaType: read.mediaType || entry.mediaType, data: read.bytes.toString("base64") });
    }
    if (skipped) {
      notes.push(
        `有 ${skipped} 个附件超出这份包的容量上限（${Math.round(assetsMaxBytes / (1024 * 1024))} MB）没有打包：` +
          "导入侧会保留卡片，但图 / 文件要在那边重新上传",
      );
    }
  }

  return makeBoardBundle(boards.map(bundleBoardOf), {
    generator: `blotboard/${packageJson.version}`,
    origin,
    now,
    assets: packed,
    notes,
    ...(volume ? { volume } : {}),
  });
}

/** 板 → 包里的板：去掉 activity（服务端单向写的日志，换台机器它没有落脚点）。 */
function bundleBoardOf(board: Board): BundleBoard {
  return {
    id: board.id,
    name: board.name,
    parentId: board.parentId ?? null,
    group: board.group || "",
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    viewport: board.viewport,
    settings: normalizeBoardSettings(board.settings),
    cards: board.cards || [],
    edges: board.edges || [],
    comments: board.comments || [],
  };
}

function uploadNameOf(boards: { cards: BoardCard[] }[], uploadId: string): string {
  for (const board of boards) {
    for (const card of board.cards) {
      if (card.file?.uploadId === uploadId && card.file.name) return card.file.name;
    }
  }
  return "";
}

/* ── 收包 ─────────────────────────────────────── */

export type ImportMode = "copy" | "restore";
export type ImportConflict = "skip" | "replace" | "copy";

export interface ImportOptions {
  /** copy（默认）= 一律当新板导入；restore = 尽量保住原 id，用来恢复自己的备份 */
  mode?: ImportMode;
  /** restore 撞上同 id 时怎么办：skip（默认）/ replace（覆盖那块板）/ copy（另存一块） */
  onConflict?: ImportConflict;
  /** 统一改分组；不传就沿用包里写的 */
  group?: string;
  actor?: BoardActor;
  /** HTML 产物里取到的图片字节（uploadId → data URI） */
  htmlAssets?: Map<string, string>;
}

export interface ImportedBoard {
  id: string;
  name: string;
  group: string;
  /** 它在包里原来的 id：调用方按这个把「导进来的」跟「包里的」对上号 */
  sourceId: string;
  cards: number;
  edges: number;
  comments: number;
  replaced: boolean;
}

export interface ImportResult {
  mode: ImportMode;
  onConflict: ImportConflict;
  imported: ImportedBoard[];
  skipped: { id: string; name: string; reason: string }[];
  assets: { restored: number; reused: number; missing: number };
  notes: string[];
}

function decodeDataUri(uri: string): { bytes: Buffer; mediaType: string } | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
  if (!match) return null;
  try {
    const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return bytes.length ? { bytes, mediaType: match[1] } : null;
  } catch {
    return null;
  }
}

/**
 * 还原附件：本机已经有的就直接用，包里带了字节的落盘换新 id，两样都没有的记一笔缺件。
 *
 * 「本机已经有」不是特例而是常态——同一台机器上导出再导入（复制一块板）时，
 * 上传件根本没走过，重新落一份只是白占磁盘。
 */
function restoreAssets(
  boards: BundleBoard[],
  bundleAssets: BundleAsset[],
  htmlAssets: Map<string, string>,
  notes: string[],
): { map: Map<string, string>; stats: ImportResult["assets"] } {
  const byId = new Map(bundleAssets.map((asset) => [asset.id, asset]));
  const map = new Map<string, string>();
  const stats = { restored: 0, reused: 0, missing: 0 };

  for (const id of bundleUploadIds(boards)) {
    if (uploadExists(id)) {
      map.set(id, id);
      stats.reused += 1;
      continue;
    }
    const asset = byId.get(id);
    const fromHtml = htmlAssets.get(id);
    const decoded = asset?.data
      ? { bytes: Buffer.from(asset.data, "base64"), mediaType: asset.mediaType }
      : fromHtml
        ? decodeDataUri(fromHtml)
        : null;
    if (!decoded?.bytes.length) {
      stats.missing += 1;
      notes.push(`附件没跟着这份文件过来：${asset?.name || id}（卡片留着，图 / 文件要重新上传）`);
      continue;
    }
    const mediaType = decoded.mediaType || asset?.mediaType || mediaTypeForId(id);
    // 名字要能过上传白名单（扩展名 + MIME 对得上）；对不上就退回用 id 当名字——
    // id 的后缀是本服务自己生成的，一定是规范扩展名
    const candidate = sanitizeUploadName(asset?.name || id, id);
    const name = uploadFormatFor(candidate, mediaType) ? candidate : id;
    try {
      const stored = storeUploadBytes(name, mediaType, decoded.bytes);
      map.set(id, stored.id);
      stats.restored += 1;
    } catch (err) {
      stats.missing += 1;
      notes.push(`附件还原失败：${name}——${err instanceof ApiError ? err.message : String(err)}`);
    }
  }
  return { map, stats };
}

/** 任务卡上属于**另一台机器**的引用：副本不继承（红线：Issue / 任务真源只有一处）。 */
function detachTaskLinks(card: BoardCard): void {
  if (card.type !== "task" || !card.task) return;
  card.task = {
    ...card.task,
    issueId: null,
    issueNumber: null,
    taskId: null,
    taskStatus: null,
    issueSyncedAt: null,
    issueSyncHash: null,
    issueSyncError: null,
  };
}

function buildCards(raw: BoardCard[], uploads: Map<string, string>, fresh: boolean, notes: string[]): BoardCard[] {
  const cards: BoardCard[] = [];
  const taken = new Set<string>();
  for (const item of raw) {
    const input: Record<string, any> = { ...item };
    if (input.file?.uploadId) {
      const mapped = uploads.get(input.file.uploadId);
      // 映射不到就原样留着：卡片本身是完整的，图裂了总比整张卡没了强（透传铁律的同一口径）
      if (mapped) input.file = { ...input.file, uploadId: mapped };
    }
    let card: BoardCard;
    try {
      card = normalizeCardInput(input, { uploadsDir: UPLOADS_DIR });
    } catch (err) {
      // 单张卡不合规只降级这一张（原样透传保存），不打回整块板——与 whole 同一条兜底
      card = passthroughCard(input, input.type ? String(input.type) : "text");
      if (err instanceof ApiError) notes.push(`卡片「${card.title || card.id}」按原样收下（${err.message}）`);
    }
    if (fresh) detachTaskLinks(card);
    if (taken.has(card.id)) continue;
    taken.add(card.id);
    cards.push(card);
  }
  return cards;
}

function buildEdges(raw: BoardEdge[], cardIds: Set<string>): BoardEdge[] {
  const edges: BoardEdge[] = [];
  const taken = new Set<string>();
  for (const item of raw) {
    const from = String(item.from || "");
    const to = String(item.to || "");
    if (!cardIds.has(from) || !cardIds.has(to) || from === to) continue;
    if (edges.some((edge) => edge.from === from && edge.to === to)) continue;
    // 连线 id 保住：挂在连线上的评论要认得回来（whole 那条路也已经保 id，见 lib/board-service.ts）
    const id = EDGE_ID_RE.test(String(item.id || "")) && !taken.has(String(item.id)) ? String(item.id) : newId("e");
    taken.add(id);
    edges.push({
      id,
      from,
      to,
      label: cleanText(item.label, MAX_EDGE_LABEL),
      kind: normalizeEdgeKind(item.kind),
      color: normalizeEdgeColor(item.color),
      style: normalizeEdgeStyle(item.style),
      width: normalizeEdgeWidth(item.width),
      weight: normalizeEdgeWeight(item.weight),
      tags: normalizeEdgeTags(item.tags),
      createdBy: item.createdBy === "agent" ? "agent" : "user",
      createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
    });
  }
  return edges;
}

/**
 * 评论：落脚点还在的才收。
 *
 * 时间戳走「归一化之后再补回来」这条路：normalizeCommentInput 是给**新写的**评论用的，
 * 它把 createdAt 定成此刻；而导入是搬运，一条三个月前的批注不该显示成刚写的。
 */
function buildComments(raw: BoardComment[], cardIds: Set<string>, edgeIds: Set<string>): BoardComment[] {
  const comments: BoardComment[] = [];
  const taken = new Set<string>();
  for (const item of raw) {
    if (item.target === "card" && !(item.targetId && cardIds.has(item.targetId))) continue;
    if (item.target === "edge" && !(item.targetId && edgeIds.has(item.targetId))) continue;
    let comment: BoardComment;
    try {
      comment = normalizeCommentInput(item, { cardIds, edgeIds });
    } catch {
      continue; // 空正文这类：一条坏评论不该拦下整块板
    }
    if (COMMENT_ID_RE.test(String(item.id || "")) && !taken.has(String(item.id))) comment.id = String(item.id);
    taken.add(comment.id);
    if (Number.isFinite(Number(item.createdAt))) comment.createdAt = Number(item.createdAt);
    if (Number.isFinite(Number(item.updatedAt))) comment.updatedAt = Number(item.updatedAt);
    if (comment.resolved && Number.isFinite(Number(item.resolvedAt))) comment.resolvedAt = Number(item.resolvedAt);
    comments.push(comment);
  }
  return comments;
}

/** 一块板的完整重建（卡 → 线 → 评论 → 清悬空归属）。 */
function materialize(raw: BundleBoard, uploads: Map<string, string>, fresh: boolean, notes: string[]): Board {
  const cards = buildCards(raw.cards, uploads, fresh, notes);
  const cardIds = new Set(cards.map((card) => card.id));
  const edges = buildEdges(raw.edges, cardIds);
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const comments = buildComments(raw.comments || [], cardIds, edgeIds);
  const now = Date.now();
  const board: Board = {
    id: raw.id,
    name: cleanText(raw.name, 60, { fallback: "未命名画板" }),
    parentId: raw.parentId ?? null,
    group: cleanText(raw.group, 40, { fallback: "" }),
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now,
    updatedAt: now,
    viewport: normalizeViewport(raw.viewport),
    settings: normalizeBoardSettings(raw.settings),
    cards,
    edges,
    comments,
  };
  pruneFrameLinks(board);
  return board;
}

/**
 * 收一份画板包：解析 → 规划 id → 还原附件 → 逐块落库。
 *
 * 入参是**已经解析好**的包（HTTP 那层要先决定这份 body 是 JSON 还是 HTML），
 * 所以这里不认文本。
 */
export function importBoardBundle(input: unknown, options: ImportOptions = {}): ImportResult {
  const { mode = "copy", onConflict = "skip", actor = "user", htmlAssets = new Map<string, string>() } = options;
  let bundle: BoardBundle;
  try {
    bundle = parseBoardBundle(input);
  } catch (err) {
    throw err instanceof BundleFormatError ? badRequest(err.message) : err;
  }

  const notes = [...(bundle.notes || [])];
  const existing = new Set(store.list().map((board) => board.id));

  /* ① 规划：每块板落在哪个 id 上，谁被跳过 */
  const boardIds = new Map<string, string>();
  const skipped: ImportResult["skipped"] = [];
  const plans: { source: BundleBoard; targetId: string; replace: boolean }[] = [];
  for (const board of bundle.boards) {
    const keep = mode === "restore" && board.id;
    if (!keep) {
      const target = newId("b");
      if (board.id) boardIds.set(board.id, target);
      plans.push({ source: board, targetId: target, replace: false });
      continue;
    }
    if (!existing.has(board.id)) {
      plans.push({ source: board, targetId: board.id, replace: false });
      continue;
    }
    if (onConflict === "skip") {
      skipped.push({ id: board.id, name: board.name, reason: "本机已有同 id 的画板（onDuplicate=replace 覆盖 / copy 另存一块）" });
      continue;
    }
    if (onConflict === "replace") {
      plans.push({ source: board, targetId: board.id, replace: true });
      continue;
    }
    const target = newId("b");
    boardIds.set(board.id, target);
    plans.push({ source: board, targetId: target, replace: false });
  }
  if (!plans.length) {
    return { mode, onConflict, imported: [], skipped, assets: { restored: 0, reused: 0, missing: 0 }, notes };
  }

  /* ② 换了板 id 就等于「这是副本」：卡片 / 连线 id 一起换，免得两块板共用同一批 id */
  const fresh = boardIds.size > 0;
  const remapped = remapBoards(
    plans.map((plan) => plan.source),
    { boardIds, freshIds: fresh, newId: (prefix) => newId(prefix) },
  );

  /* ③ 附件：本机已有的复用，包里带字节的落盘 */
  const { map: uploads, stats } = restoreAssets(remapped, bundle.assets || [], htmlAssets, notes);

  /* ④ 逐块落库 */
  const imported: ImportedBoard[] = [];
  const liveIds = new Set([...existing, ...plans.map((plan) => plan.targetId)]);
  remapped.forEach((raw, index) => {
    const plan = plans[index];
    const board = materialize({ ...raw, id: plan.targetId }, uploads, fresh, notes);
    if (options.group !== undefined) board.group = cleanText(options.group, 40, { fallback: "" });
    // 父板不在这台机器上就当顶层板：留着一个指不到的 parentId，左栏会把它藏进不存在的层级里
    if (board.parentId && !liveIds.has(board.parentId)) board.parentId = null;
    if (board.parentId === board.id) board.parentId = null;

    const summary =
      `导入画板：卡片 ${board.cards.length} 张、连线 ${board.edges.length} 条` +
      (board.comments?.length ? `、评论 ${board.comments.length} 条` : "");

    if (plan.replace) {
      const before = store.requireBoard(plan.targetId);
      // 覆盖是不可逆的那一档：动手前先照相（安全网不上主路径，失败只降级）
      const checkpoint = captureCheckpoint(before, "import");
      store.mutateBoard(plan.targetId, (target) => {
        target.name = board.name;
        target.group = board.group;
        target.parentId = board.parentId ?? null;
        target.viewport = board.viewport;
        target.settings = board.settings;
        target.cards = board.cards;
        target.edges = board.edges;
        target.comments = board.comments;
        pushActivity(target, {
          actor,
          action: "import",
          summary: `${summary}（覆盖原有内容）`,
          counts: { cards: board.cards.length, edges: board.edges.length },
          checkpoint,
        });
      });
    } else {
      store.insertBoard(() => {
        pushActivity(board, {
          actor,
          action: "import",
          summary,
          counts: { cards: board.cards.length, edges: board.edges.length },
          checkpoint: null,
        });
        return board;
      });
    }
    imported.push({
      id: plan.targetId,
      name: board.name,
      group: board.group || "",
      sourceId: plan.source.id || "",
      cards: board.cards.length,
      edges: board.edges.length,
      comments: board.comments?.length || 0,
      replaced: plan.replace,
    });
  });

  if (fresh) {
    notes.push("导入的是副本：卡片 / 连线换了新 id，任务卡不继承来源机器上的 Issue 与任务 id");
  }
  return { mode, onConflict, imported, skipped, assets: stats, notes };
}
