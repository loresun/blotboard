"use client";

import { browserWorkspace, normalizeWorkspace } from "./storage-mode";
import {
  boardDetailLocal,
  boardListItem,
  browserId,
  createBrowserBoard,
  createBrowserCard,
  createBrowserComment,
  createBrowserEdge,
  mergeBrowserBoards,
  patchBrowserCard,
  touchBrowserBoard,
} from "./browser-board-domain";
import {
  makeBoardBundle,
  parseBoardBundle,
  parseBoardBundleText,
  remapBoards,
  type BoardBundle,
} from "./board-bundle";
import { cardSearchParts, cardSearchText, cardSnippet } from "./search-text";
import { CARD_META_BY_TYPE } from "./card-metas";
import { runLayout, type TidyMode } from "./layout";
import type {
  Board,
  BoardCard,
  BoardComment,
  BoardDetail,
  BoardEdge,
  BoardNavResult,
  BoardPreviewData,
  BoardSearchResult,
  BoardSettings,
  CardColor,
  CardType,
  EdgeKind,
  EdgeStyle,
  NavOrder,
  NavSort,
} from "./types";

const DB_NAME = "blotboard-browser-v1";
/** v2 起多了一张 assets 表：导进来的图片 / PDF / 音视频字节存在这里（见 putAssets / readAssets）。 */
const DB_VERSION = 2;
const META_STORE = "workspaces";
const BOARD_STORE = "boards";
const ASSET_STORE = "assets";
const WORKSPACE_INDEX = "workspace";
export const BROWSER_STORAGE_CHANGED = "blotboard:browser-storage-changed";

interface StoredBoard extends Board {
  workspace: string;
}

/**
 * 浏览器库里的附件字节。
 *
 * 以前这个库**只存卡片、不存字节**：一份带图的画板包导进来，卡片留着、图没了，
 * 界面上是「图片缺失」，再备份一次连 assets 表都是空的——用户手里那份「成功导入」的库
 * 已经把原始字节丢干净了，而 toast 说的是「已导入 1 块画板」。
 * 现在字节跟着板一起存进 IndexedDB：**导得进来、看得见、还导得出去**。
 *
 * `data` 存 ArrayBuffer 而不是 base64：省三分之一空间，也免得每次读都要解一遍码。
 */
interface StoredAsset {
  workspace: string;
  id: string;
  name: string;
  mediaType: string;
  bytes: number;
  data: ArrayBuffer;
}

interface WorkspaceMeta {
  id: string;
  order: string[];
  updatedAt: number;
}

/**
 * 恢复备份的三种语义：
 *  · merge（默认）同 id 由备份覆盖，其余本地板留着——「把备份并回来」；
 *  · replace 整个 workspace 换成备份里的那批——「回到那一刻」；
 *  · copy 一律当新板收下（板 / 卡 / 连线全换新 id）——「别人发我一块板」，
 *    这一种不会碰任何已有的板，所以是导入分享文件的默认走法。
 */
export type BrowserImportMode = "merge" | "replace" | "copy";

export interface BrowserWorkspaceSummary {
  name: string;
  boards: number;
  updatedAt: number;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("浏览器存储读取失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("浏览器存储事务失败"));
    transaction.onabort = () => reject(transaction.error || new Error("浏览器存储事务已取消"));
  });
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("此浏览器不支持 IndexedDB，无法使用浏览器存储"));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BOARD_STORE)) {
        const boards = db.createObjectStore(BOARD_STORE, { keyPath: ["workspace", "id"] });
        boards.createIndex(WORKSPACE_INDEX, "workspace", { unique: false });
      }
      // v1 → v2：只加表，一个字节的画板数据都不动（老库升上来照常打开）
      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        const assets = db.createObjectStore(ASSET_STORE, { keyPath: ["workspace", "id"] });
        assets.createIndex(WORKSPACE_INDEX, "workspace", { unique: false });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error("打不开浏览器存储"));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("浏览器存储升级被其他标签页阻塞，请关闭旧标签页后重试"));
    };
  });
  return databasePromise;
}

function withoutWorkspace(stored: StoredBoard): Board {
  const { workspace: _workspace, ...board } = stored;
  return structuredClone(board);
}

function stored(workspace: string, board: Board): StoredBoard {
  return { ...stripAssetUrls(structuredClone(board)), workspace };
}

function signal(workspace: string, boardId?: string): void {
  const detail = { workspace, boardId: boardId || null, at: Date.now() };
  window.dispatchEvent(new CustomEvent(BROWSER_STORAGE_CHANGED, { detail }));
  try {
    const channel = new BroadcastChannel(BROWSER_STORAGE_CHANGED);
    channel.postMessage(detail);
    channel.close();
  } catch {
    // BroadcastChannel is an enhancement; same-tab CustomEvent is sufficient.
  }
}

async function readWorkspace(workspace = browserWorkspace()): Promise<{ meta: WorkspaceMeta; boards: Board[] }> {
  const db = await openDatabase();
  const tx = db.transaction([META_STORE, BOARD_STORE], "readonly");
  const meta = (await requestValue(tx.objectStore(META_STORE).get(workspace))) as WorkspaceMeta | undefined;
  const records = (await requestValue(tx.objectStore(BOARD_STORE).index(WORKSPACE_INDEX).getAll(workspace))) as StoredBoard[];
  await transactionDone(tx);
  const byId = new Map(records.map((record) => [record.id, withoutWorkspace(record)]));
  const order = meta?.order || [];
  const ordered = order.map((id) => byId.get(id)).filter((board): board is Board => Boolean(board));
  for (const board of byId.values()) if (!order.includes(board.id)) ordered.push(board);
  return { meta: meta || { id: workspace, order: ordered.map((board) => board.id), updatedAt: 0 }, boards: ordered };
}

async function writeWorkspace(workspace: string, boards: Board[]): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([META_STORE, BOARD_STORE], "readwrite");
  const boardStore = tx.objectStore(BOARD_STORE);
  const existing = (await requestValue(boardStore.index(WORKSPACE_INDEX).getAllKeys(workspace))) as IDBValidKey[];
  const keep = new Set(boards.map((board) => board.id));
  for (const key of existing) {
    const boardId = Array.isArray(key) ? String(key[1]) : "";
    if (!keep.has(boardId)) boardStore.delete(key);
  }
  for (const board of boards) boardStore.put(stored(workspace, board));
  tx.objectStore(META_STORE).put({ id: workspace, order: boards.map((board) => board.id), updatedAt: Date.now() } satisfies WorkspaceMeta);
  await transactionDone(tx);
  signal(workspace);
}

/* ── 附件字节：图片 / PDF / 音视频跟着板一起存 ────── */

function base64ToBuffer(base64: string): ArrayBuffer | null {
  try {
    const binary = atob(base64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return bytes.length ? bytes.buffer : null;
  } catch {
    return null;
  }
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // 分块喂给 fromCharCode：一次性 apply 一个几 MB 的数组会爆调用栈
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

/** 「排版导出 HTML」里的图片是 data URI（`<img data-asset>`），跟包里的 base64 同价。 */
function decodeDataUri(uri: string): { data: ArrayBuffer; mediaType: string } | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
  if (!match) return null;
  let data: ArrayBuffer | null;
  if (match[2]) data = base64ToBuffer(match[3]);
  else {
    try {
      // 非 base64 的 data URI 是百分号编码的文本：走 TextEncoder，btoa 处理不了非 Latin-1
      const bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
      data = bytes.length ? (bytes.buffer as ArrayBuffer) : null;
    } catch {
      data = null;
    }
  }
  return data ? { data, mediaType: match[1] } : null;
}

/** 这个 workspace 的板一共引用了哪些上传件（口径与服务端 bundleUploadIds 一致）。 */
function referencedUploadIds(boards: { cards: BoardCard[] }[]): Set<string> {
  const ids = new Set<string>();
  for (const board of boards) for (const card of board.cards || []) if (card.file?.uploadId) ids.add(card.file.uploadId);
  return ids;
}

/**
 * 按 id 取字节。**点名要哪几个就只读哪几个**——整个 workspace 的附件可能有几百 MB，
 * 而开一块板只用得上它自己引用的那几张图；`getAll` 一把梭等于每次开板都把整库字节读进内存。
 */
async function readAssets(workspace: string, ids: Set<string>): Promise<Map<string, StoredAsset>> {
  if (!ids.size) return new Map();
  const db = await openDatabase();
  const tx = db.transaction(ASSET_STORE, "readonly");
  const store = tx.objectStore(ASSET_STORE);
  const found = await Promise.all(
    [...ids].map((id) => requestValue(store.get([workspace, id])) as Promise<StoredAsset | undefined>),
  );
  await transactionDone(tx);
  const map = new Map<string, StoredAsset>();
  for (const record of found) if (record) map.set(record.id, record);
  return map;
}

async function putAssets(workspace: string, assets: StoredAsset[]): Promise<void> {
  if (!assets.length) return;
  const db = await openDatabase();
  const tx = db.transaction(ASSET_STORE, "readwrite");
  for (const asset of assets) tx.objectStore(ASSET_STORE).put(asset);
  await transactionDone(tx);
  for (const asset of assets) forgetAssetUrl(workspace, asset.id);
}

/**
 * 清掉没有任何卡片再引用的字节。
 *
 * 只在**板级**写入（建板 / 删板 / 导入）之后跑，判据是「整个 workspace 的板都不再引用它」——
 * 删掉一块板不该带走另一块板还在用的那张图。卡片级的编辑走 mutateBoard，不碰这里。
 */
async function pruneAssets(workspace: string, keep: Set<string>): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(ASSET_STORE, "readwrite");
  const store = tx.objectStore(ASSET_STORE);
  const keys = (await requestValue(store.index(WORKSPACE_INDEX).getAllKeys(workspace))) as IDBValidKey[];
  const dropped: string[] = [];
  for (const key of keys) {
    const id = Array.isArray(key) ? String(key[1]) : "";
    if (id && !keep.has(id)) {
      store.delete(key);
      dropped.push(id);
    }
  }
  await transactionDone(tx);
  for (const id of dropped) forgetAssetUrl(workspace, id);
}

/**
 * 字节 → 可以直接塞进 `<img src>` 的地址。
 *
 * 一个附件一条 object URL，建一次就留着：卡面每次重渲都新建一条的话，页面开半天就攒出几百条
 * 永不释放的引用。真正需要作废的只有「这份字节没了 / 换了」，那两处显式 forget。
 */
const assetUrls = new Map<string, string>();

function assetUrlKey(workspace: string, id: string): string {
  // workspace 名已被 normalizeWorkspace 限死在 [字母数字_-]，冒号不可能出现在里面，拼不出歧义
  return `${workspace}::${id}`;
}

function forgetAssetUrl(workspace: string, id: string): void {
  const key = assetUrlKey(workspace, id);
  const url = assetUrls.get(key);
  if (!url) return;
  assetUrls.delete(key);
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* 页面正在卸载之类：撤销失败不影响任何人 */
  }
}

function assetUrlFor(workspace: string, asset: StoredAsset): string {
  const key = assetUrlKey(workspace, asset.id);
  const known = assetUrls.get(key);
  if (known) return known;
  const url = URL.createObjectURL(new Blob([asset.data], { type: asset.mediaType || "application/octet-stream" }));
  assetUrls.set(key, url);
  return url;
}

/**
 * 读出来的板补上附件地址。**只在下发给界面的那条路上做**——
 * object URL 是这一次页面会话里的临时地址，存进 IndexedDB 或写进导出文件都是垃圾数据
 * （stored() 与 exportBoardJson 会把它剥掉）。
 */
async function withAssetUrls<T extends Board>(workspace: string, board: T): Promise<T> {
  const wanted = referencedUploadIds([board]);
  const assets = await readAssets(workspace, wanted);
  if (!assets.size) return board;
  board.cards = board.cards.map((card) => {
    const id = card.file?.uploadId;
    const asset = id ? assets.get(id) : null;
    if (!asset) return card;
    const url = assetUrlFor(workspace, asset);
    return { ...card, file: { ...card.file, url, previewUrl: card.file?.kind === "image" ? url : null } };
  });
  return board;
}

/** 存回去 / 导出去之前把临时地址剥掉（真源只有 uploadId）。 */
function stripAssetUrls(board: Board): Board {
  board.cards = board.cards.map((card) => {
    if (!card.file || (card.file.url === undefined && card.file.previewUrl === undefined)) return card;
    const { url: _url, previewUrl: _previewUrl, ...file } = card.file;
    return { ...card, file };
  });
  return board;
}

const localLocks = new Map<string, Promise<unknown>>();

async function withWorkspaceLock<T>(workspace: string, action: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(`blotboard:${workspace}`, { mode: "exclusive" }, action);
  }
  const previous = localLocks.get(workspace) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  localLocks.set(workspace, current);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (localLocks.get(workspace) === current) localLocks.delete(workspace);
  }
}

async function mutateBoard<T>(boardId: string, mutate: (board: Board) => T | Promise<T>, workspace = browserWorkspace()): Promise<{ result: T; board: Board }> {
  return withWorkspaceLock(workspace, async () => {
    const db = await openDatabase();
    const readTx = db.transaction(BOARD_STORE, "readonly");
    const record = (await requestValue(readTx.objectStore(BOARD_STORE).get([workspace, boardId]))) as StoredBoard | undefined;
    await transactionDone(readTx);
    if (!record) throw new Error("画板不存在");
    const board = withoutWorkspace(record);
    // Layout may dynamically import dagre. Never hold an IndexedDB transaction
    // open across this await; browsers are allowed to auto-commit an idle tx.
    const result = await mutate(board);
    touchBrowserBoard(board);
    const writeTx = db.transaction(BOARD_STORE, "readwrite");
    writeTx.objectStore(BOARD_STORE).put(stored(workspace, board));
    await transactionDone(writeTx);
    signal(workspace, boardId);
    return { result, board };
  });
}

function revised<T>(board: Board, value: T): T & { updatedAt: number; stale: false } {
  return Object.assign(value as object, { updatedAt: board.updatedAt, stale: false }) as T & { updatedAt: number; stale: false };
}

function getCard(board: Board, cardId: string): BoardCard {
  const card = board.cards.find((item) => item.id === cardId);
  if (!card) throw new Error("卡片不存在");
  return card;
}

function getEdge(board: Board, edgeId: string): BoardEdge {
  const edge = board.edges.find((item) => item.id === edgeId);
  if (!edge) throw new Error("连线不存在");
  return edge;
}

function getComment(board: Board, commentId: string): BoardComment {
  const comment = (board.comments || []).find((item) => item.id === commentId);
  if (!comment) throw new Error("评论不存在");
  return comment;
}

function patchEdgeValue(edge: BoardEdge, patch: Record<string, any>): BoardEdge {
  const next = { ...edge };
  if (patch.label !== undefined) next.label = String(patch.label || "").trim().slice(0, 120);
  if (patch.kind !== undefined) next.kind = (["rel", "blocks", "enables", "references", "produces"] as string[]).includes(patch.kind) ? patch.kind as EdgeKind : next.kind;
  if (patch.color !== undefined) next.color = patch.color === null || (["amber", "blue", "green", "violet", "rose", "slate"] as unknown[]).includes(patch.color) ? patch.color as CardColor | null : next.color;
  if (patch.style !== undefined) next.style = patch.style === null || (["solid", "dashed", "dotted"] as unknown[]).includes(patch.style) ? patch.style as EdgeStyle | null : next.style;
  if (patch.width !== undefined) next.width = patch.width === null ? null : Math.min(3, Math.max(1, Math.round(Number(patch.width) || 2)));
  if (patch.weight !== undefined) next.weight = patch.weight === null ? null : Math.min(5, Math.max(1, Math.round(Number(patch.weight) || 3)));
  if (patch.tags !== undefined) next.tags = Array.isArray(patch.tags) ? [...new Set(patch.tags.map(String))].slice(0, 6) : [];
  return next;
}

export const browserBoards = {
  workspace: browserWorkspace,

  async listWorkspaces(): Promise<BrowserWorkspaceSummary[]> {
    const db = await openDatabase();
    const tx = db.transaction([META_STORE, BOARD_STORE], "readonly");
    const metas = (await requestValue(tx.objectStore(META_STORE).getAll())) as WorkspaceMeta[];
    const records = (await requestValue(tx.objectStore(BOARD_STORE).getAll())) as StoredBoard[];
    await transactionDone(tx);
    const byName = new Map<string, BrowserWorkspaceSummary>();
    for (const meta of metas) byName.set(meta.id, { name: meta.id, boards: 0, updatedAt: meta.updatedAt || 0 });
    for (const board of records) {
      const summary = byName.get(board.workspace) || { name: board.workspace, boards: 0, updatedAt: 0 };
      summary.boards += 1;
      summary.updatedAt = Math.max(summary.updatedAt, board.updatedAt || board.createdAt || 0);
      byName.set(board.workspace, summary);
    }
    return [...byName.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  },

  async createWorkspace(rawName: string): Promise<BrowserWorkspaceSummary> {
    const name = normalizeWorkspace(rawName);
    const db = await openDatabase();
    const tx = db.transaction(META_STORE, "readwrite");
    const metaStore = tx.objectStore(META_STORE);
    const existing = (await requestValue(metaStore.get(name))) as WorkspaceMeta | undefined;
    if (!existing) metaStore.put({ id: name, order: [], updatedAt: Date.now() } satisfies WorkspaceMeta);
    await transactionDone(tx);
    signal(name);
    const current = await readWorkspace(name);
    return {
      name,
      boards: current.boards.length,
      updatedAt: Math.max(current.meta.updatedAt || 0, ...current.boards.map((board) => board.updatedAt || 0)),
    };
  },

  async listBoards() {
    return (await readWorkspace()).boards.map(boardListItem);
  },

  async getBoard(boardId: string): Promise<BoardDetail> {
    const workspace = browserWorkspace();
    const board = (await readWorkspace(workspace)).boards.find((item) => item.id === boardId);
    if (!board) throw new Error("画板不存在");
    // 附件地址是**读出来才补**的：库里存的只有 uploadId 和字节
    return boardDetailLocal(await withAssetUrls(workspace, board));
  },

  async getBoardSince(boardId: string, since?: number | null): Promise<BoardDetail | null> {
    const board = await this.getBoard(boardId);
    return since && board.updatedAt === since ? null : board;
  },

  async createBoard(name: string, options: { parentId?: string; group?: string } = {}) {
    const workspace = browserWorkspace();
    // 整份板列表的读-改-写必须拿锁：writeWorkspace 会把不在列表里的板删掉，
    // 两个并发的写各自基于旧列表算出结果，后写的那个等于把先写的那块板抹了
    return withWorkspaceLock(workspace, async () => {
      const current = await readWorkspace(workspace);
      const board = createBrowserBoard(name, options);
      if (board.parentId && !current.boards.some((item) => item.id === board.parentId)) board.parentId = null;
      await writeWorkspace(workspace, [...current.boards, board]);
      return boardListItem(board);
    });
  },

  async patchBoard(boardId: string, patch: Record<string, any>) {
    const { board } = await mutateBoard(boardId, (draft) => {
      if (patch.name !== undefined) {
        const name = String(patch.name || "").trim().slice(0, 60);
        if (!name) throw new Error("画板名称不能为空");
        draft.name = name;
      }
      if (patch.group !== undefined) draft.group = String(patch.group || "").trim().slice(0, 40);
      if (patch.parentId !== undefined) draft.parentId = /^b_[a-z0-9_]+$/.test(String(patch.parentId || "")) ? String(patch.parentId) : null;
      if (patch.settings !== undefined) draft.settings = { ...(draft.settings || {}), ...structuredClone(patch.settings) } as BoardSettings;
    });
    return boardListItem(board);
  },

  async renameBoard(boardId: string, name: string) {
    await this.patchBoard(boardId, { name });
    return this.getBoard(boardId);
  },

  async patchBoardSettings(boardId: string, settings: Partial<BoardSettings>) {
    await this.patchBoard(boardId, { settings });
    return this.getBoard(boardId);
  },

  async deleteBoard(boardId: string) {
    const workspace = browserWorkspace();
    return withWorkspaceLock(workspace, async () => {
      const current = await readWorkspace(workspace);
      if (!current.boards.some((board) => board.id === boardId)) throw new Error("画板不存在");
      const boards = current.boards.filter((board) => board.id !== boardId).map((board) => board.parentId === boardId ? { ...board, parentId: null } : board);
      await writeWorkspace(workspace, boards);
      // 没有任何一块板再引用的字节才清；别的板还在用的那张图留着
      await pruneAssets(workspace, referencedUploadIds(boards));
      return { removed: boardId };
    });
  },

  async saveState(boardId: string, payload: { viewport?: any; cards?: any[] }) {
    const { board, result } = await mutateBoard(boardId, (draft) => {
      if (payload.viewport) draft.viewport = {
        x: Number(payload.viewport.x) || 0,
        y: Number(payload.viewport.y) || 0,
        zoom: Math.min(4, Math.max(0.1, Number(payload.viewport.zoom) || 1)),
      };
      const geometry = new Map((payload.cards || []).map((item) => [String(item.id), item]));
      let applied = 0;
      draft.cards = draft.cards.map((card) => {
        const next = geometry.get(card.id);
        if (!next) return card;
        applied += 1;
        return patchBrowserCard(card, next);
      });
      return { applied };
    });
    return revised(board, result);
  },

  async createCard(boardId: string, payload: Record<string, any>) {
    const { board, result: card } = await mutateBoard(boardId, (draft) => {
      const created = createBrowserCard(payload);
      if (created.frameId && !draft.cards.some((item) => item.id === created.frameId && item.type === "frame")) throw new Error("分组框不存在");
      draft.cards.push(created);
      return created;
    });
    return revised(board, { card });
  },

  async patchCard(boardId: string, cardId: string, patch: Record<string, any>) {
    const { board, result: card } = await mutateBoard(boardId, (draft) => {
      const index = draft.cards.findIndex((item) => item.id === cardId);
      if (index < 0) throw new Error("卡片不存在");
      const next = patchBrowserCard(draft.cards[index], patch);
      if (next.frameId && !draft.cards.some((item) => item.id === next.frameId && item.type === "frame")) throw new Error("分组框不存在");
      draft.cards[index] = next;
      return next;
    });
    return revised(board, { card });
  },

  async patchCardsBulk(boardId: string, ids: string[], patch: Record<string, any>) {
    const wanted = new Set(ids);
    const { board, result: cards } = await mutateBoard(boardId, (draft) => {
      const changed: BoardCard[] = [];
      draft.cards = draft.cards.map((card) => {
        if (!wanted.has(card.id)) return card;
        const next = patchBrowserCard(card, patch);
        changed.push(next);
        return next;
      });
      return changed;
    });
    return revised(board, { cards, updated: cards.length });
  },

  async deleteCard(boardId: string, cardId: string) {
    const result = await this.deleteCardsBulk(boardId, [cardId]);
    return { ...result, removed: cardId };
  },

  async deleteCardsBulk(boardId: string, ids: string[]) {
    const wanted = new Set(ids);
    const { board, result: removed } = await mutateBoard(boardId, (draft) => {
      const found = draft.cards.filter((card) => wanted.has(card.id)).map((card) => card.id);
      const edgeIds = new Set(draft.edges.filter((edge) => wanted.has(edge.from) || wanted.has(edge.to)).map((edge) => edge.id));
      draft.cards = draft.cards.filter((card) => !wanted.has(card.id)).map((card) => wanted.has(card.frameId || "") ? { ...card, frameId: null } : card);
      draft.edges = draft.edges.filter((edge) => !edgeIds.has(edge.id));
      draft.comments = (draft.comments || []).filter((comment) => !(comment.target === "card" && wanted.has(comment.targetId || "")) && !(comment.target === "edge" && edgeIds.has(comment.targetId || "")));
      return found;
    });
    return revised(board, { removed });
  },

  async pasteCards(boardId: string, payload: { cards: Record<string, any>[]; edges?: Record<string, any>[]; at?: { x: number; y: number } | null }) {
    const { board, result } = await mutateBoard(boardId, (draft) => {
      const idMap = new Map<string, string>();
      const cards = payload.cards.map((raw) => {
        const oldId = String(raw.id || "");
        const card = createBrowserCard({ ...raw, id: undefined });
        if (oldId) idMap.set(oldId, card.id);
        return card;
      });
      if (payload.at && cards.length) {
        const minX = Math.min(...cards.map((card) => card.x));
        const minY = Math.min(...cards.map((card) => card.y));
        for (const card of cards) {
          card.x += payload.at.x - minX;
          card.y += payload.at.y - minY;
          if (card.frameId) card.frameId = idMap.get(card.frameId) || null;
        }
      }
      const allCards = [...draft.cards, ...cards];
      const edges = (payload.edges || []).flatMap((raw) => {
        const from = idMap.get(String(raw.from || ""));
        const to = idMap.get(String(raw.to || ""));
        return from && to ? [createBrowserEdge({ ...raw, id: undefined, from, to }, allCards)] : [];
      });
      draft.cards.push(...cards);
      draft.edges.push(...edges);
      return { cards, edges };
    });
    return revised(board, result);
  },

  async createEdge(boardId: string, payload: Record<string, any>) {
    const { board, result: edge } = await mutateBoard(boardId, (draft) => {
      if (draft.edges.some((item) => item.from === payload.from && item.to === payload.to)) throw new Error("连线已存在");
      const created = createBrowserEdge(payload, draft.cards);
      draft.edges.push(created);
      return created;
    });
    return revised(board, { edge });
  },

  async patchEdge(boardId: string, edgeId: string, patch: Record<string, any>) {
    const { board, result: edge } = await mutateBoard(boardId, (draft) => {
      const index = draft.edges.findIndex((item) => item.id === edgeId);
      if (index < 0) throw new Error("连线不存在");
      draft.edges[index] = patchEdgeValue(draft.edges[index], patch);
      return draft.edges[index];
    });
    return revised(board, { edge });
  },

  async deleteEdge(boardId: string, edgeId: string) {
    const { board } = await mutateBoard(boardId, (draft) => {
      getEdge(draft, edgeId);
      draft.edges = draft.edges.filter((edge) => edge.id !== edgeId);
      draft.comments = (draft.comments || []).filter((comment) => !(comment.target === "edge" && comment.targetId === edgeId));
    });
    return revised(board, {});
  },

  async createComment(boardId: string, payload: Record<string, any>) {
    const { board, result: comment } = await mutateBoard(boardId, (draft) => {
      const created = createBrowserComment(payload, draft);
      (draft.comments ||= []).push(created);
      return created;
    });
    return revised(board, { comment });
  },

  async patchComment(boardId: string, commentId: string, patch: Record<string, any>) {
    const { board, result: comment } = await mutateBoard(boardId, (draft) => {
      const current = getComment(draft, commentId);
      if (patch.text !== undefined) {
        const body = String(patch.text || "").trim().slice(0, 2000);
        if (!body) throw new Error("评论内容不能为空");
        current.text = body;
      }
      if (patch.resolved !== undefined && current.resolved !== (patch.resolved === true)) {
        current.resolved = patch.resolved === true;
        current.resolvedAt = current.resolved ? Date.now() : null;
      }
      if (patch.x !== undefined) current.x = Number.isFinite(Number(patch.x)) ? Math.round(Number(patch.x)) : null;
      if (patch.y !== undefined) current.y = Number.isFinite(Number(patch.y)) ? Math.round(Number(patch.y)) : null;
      current.updatedAt = Date.now();
      return structuredClone(current);
    });
    return revised(board, { comment });
  },

  async replyComment(boardId: string, commentId: string, replyText: string) {
    const { board, result: comment } = await mutateBoard(boardId, (draft) => {
      const current = getComment(draft, commentId);
      const body = String(replyText || "").trim().slice(0, 2000);
      if (!body) throw new Error("回复内容不能为空");
      current.replies.push({ id: browserId("cr"), text: body, createdBy: "user", createdAt: Date.now() });
      current.updatedAt = Date.now();
      return structuredClone(current);
    });
    return revised(board, { comment });
  },

  async deleteComment(boardId: string, commentId: string) {
    const { board } = await mutateBoard(boardId, (draft) => {
      getComment(draft, commentId);
      draft.comments = (draft.comments || []).filter((comment) => comment.id !== commentId);
    });
    return revised(board, {});
  },

  async replaceWhole(boardId: string, payload: any) {
    const source = payload?.board && typeof payload.board === "object" ? payload.board : payload;
    const { board } = await mutateBoard(boardId, (draft) => {
      if (!source || !Array.isArray(source.cards) || !Array.isArray(source.edges)) throw new Error("整板数据格式无效");
      draft.viewport = structuredClone(source.viewport || draft.viewport);
      draft.settings = structuredClone(source.settings || draft.settings);
      draft.cards = source.cards.map((card: Record<string, any>) => createBrowserCard(card));
      const ids = new Set(draft.cards.map((card) => card.id));
      draft.edges = source.edges.filter((edge: Record<string, any>) => ids.has(String(edge.from)) && ids.has(String(edge.to))).map((edge: Record<string, any>) => createBrowserEdge(edge, draft.cards));
      if (Array.isArray(source.comments)) draft.comments = structuredClone(source.comments);
    });
    return boardDetailLocal(board);
  },

  async tidyBoard(boardId: string, mode: string) {
    const { result, board } = await mutateBoard(boardId, async (draft) => {
      const positions = await runLayout(draft.cards, draft.edges, mode as TidyMode);
      const byId = new Map(positions.map((item) => [item.id, item]));
      let changed = 0;
      draft.cards = draft.cards.map((card) => {
        const position = byId.get(card.id);
        if (!position || (position.x === card.x && position.y === card.y)) return card;
        changed += 1;
        return { ...card, x: position.x, y: position.y, updatedAt: Date.now() };
      });
      return { moved: positions.length, changed };
    });
    return revised(board, result);
  },

  async boardPreview(boardId: string): Promise<BoardPreviewData> {
    const board = await this.getBoard(boardId);
    const byId = new Map(board.cards.map((card) => [card.id, card]));
    return {
      id: board.id,
      name: board.name,
      updatedAt: board.updatedAt,
      counts: { cards: board.cards.length, edges: board.edges.length },
      cards: board.cards.map(({ id, type, color, x, y, w, h, title }) => ({ id, type, color, x, y, w, h, title })),
      edges: board.edges.flatMap((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        return from && to ? [{ x1: from.x + from.w / 2, y1: from.y + from.h / 2, x2: to.x + to.w / 2, y2: to.y + to.h / 2 }] : [];
      }),
    };
  },

  async searchBoards(query: string): Promise<BoardSearchResult> {
    const keyword = query.trim().toLowerCase().slice(0, 120);
    const hits = (await readWorkspace()).boards.flatMap((board) => {
      const nameHit = `${board.name} ${board.group || ""}`.toLowerCase().includes(keyword);
      const cards = board.cards.filter((card) => cardSearchText(card).includes(keyword));
      return nameHit || cards.length ? [{ id: board.id, name: board.name, group: board.group || "", parentId: board.parentId ?? null, updatedAt: board.updatedAt, nameHit, cardTotal: cards.length, cards: cards.slice(0, 8).map((card) => ({ id: card.id, type: card.type, title: card.title || CARD_META_BY_TYPE[card.type]?.fallbackTitle || "卡片", snippet: cardSnippet(card, keyword) })) }] : [];
    });
    hits.sort((a, b) => Number(b.nameHit) - Number(a.nameHit) || b.cardTotal - a.cardTotal || b.updatedAt - a.updatedAt);
    return { query: query.trim(), boards: hits.slice(0, 30), totalBoards: hits.length, totalCards: hits.reduce((sum, hit) => sum + hit.cardTotal, 0) };
  },

  async cardIndex(options: { group?: string | null; boardId?: string | null; query?: string; types?: CardType[]; sort?: NavSort; order?: NavOrder; limit?: number; offset?: number } = {}): Promise<BoardNavResult> {
    const keyword = String(options.query || "").trim().toLowerCase();
    const wanted = new Set(options.types || []);
    const typeCounts: Partial<Record<CardType, number>> = {};
    const hits: { board: Board; card: BoardCard; time: number }[] = [];
    for (const board of (await readWorkspace()).boards) {
      if (options.boardId && board.id !== options.boardId) continue;
      if (options.group !== null && options.group !== undefined && (board.group || "") !== options.group) continue;
      for (const card of board.cards) {
        if (keyword && !cardSearchText(card).includes(keyword)) continue;
        typeCounts[card.type] = (typeCounts[card.type] || 0) + 1;
        if (wanted.size && !wanted.has(card.type)) continue;
        hits.push({ board, card, time: options.sort === "created" ? card.createdAt : card.updatedAt || card.createdAt });
      }
    }
    hits.sort((a, b) => (options.order === "asc" ? a.time - b.time : b.time - a.time));
    const limit = Math.min(400, Math.max(1, Number(options.limit) || 120));
    const offset = Math.max(0, Number(options.offset) || 0);
    const cards = hits.slice(offset, offset + limit).map(({ board, card }) => ({
      id: card.id, type: card.type, color: card.color, title: card.title || "",
      preview: (keyword ? cardSnippet(card, keyword, 42) : cardSearchParts(card).filter((part) => part !== card.title).join(" ")).slice(0, 110),
      createdAt: card.createdAt, updatedAt: card.updatedAt || card.createdAt,
      boardId: board.id, boardName: board.name, group: board.group || "",
      taskStatus: card.type === "task" ? card.task?.status || null : null,
    }));
    return { cards, total: hits.length, limit, offset, typeCounts };
  },

  async exportBoardJson(boardId: string) {
    // 下载下来的 JSON 里不该有 object URL：那是这一次页面会话的临时地址，换个标签页就失效
    return stripAssetUrls(structuredClone(await this.getBoard(boardId)) as Board);
  },

  /**
   * 备份 / 导出：产物是**与服务端同一种画板包**（lib/board-bundle.ts），
   * 所以浏览器库导出的文件能直接导进服务端库，反过来也一样。
   * 不给 selection 就是整个 workspace（原来的「备份整库」）。
   *
   * **附件字节跟着出去**：这个库里存着的图片 / PDF / 音视频原样打进 assets（base64），
   * 跟服务端那份包一个形状。以前这里写死不带附件，于是「导进来 → 再备份」两步就把字节
   * 洗干净了——文件看着正常，图永远回不来。
   */
  async exportBundle(selection: { ids?: string[]; group?: string; all?: boolean } = {}): Promise<BoardBundle> {
    const workspace = browserWorkspace();
    const all = (await readWorkspace(workspace)).boards;
    const wanted = selection.ids?.length
      ? all.filter((board) => selection.ids!.includes(board.id))
      : selection.group !== undefined
        ? all.filter((board) => (board.group || "") === selection.group)
        : all;
    const boards = wanted.map(({ activity: _activity, ...board }) => stripAssetUrls(board as Board));
    const referenced = referencedUploadIds(boards);
    const stored = await readAssets(workspace, referenced);
    const assets = [...stored.values()].map((asset) => ({
      id: asset.id,
      name: asset.name,
      mediaType: asset.mediaType,
      bytes: asset.bytes,
      data: bufferToBase64(asset.data),
    }));
    const missing = [...referenced].filter((id) => !stored.has(id));
    const notes = missing.length
      ? [`有 ${missing.length} 个附件的字节不在这个浏览器库里（卡片带着，图 / 文件要到那边重新上传）：${missing.slice(0, 5).join("、")}`]
      : [];
    return makeBoardBundle(boards, { generator: `blotboard-browser/${workspace}`, assets, notes });
  },

  /**
   * 收一份画板包 / 旧备份 / 单块板 JSON / 导出的 HTML。
   *
   * 两件以前没做、而「成功」toast 又把它盖住了的事：
   *  ① **附件字节落库**（包里的 base64 与 HTML 产物里的 `<img data-asset>` 都收），
   *     不然导进来的图片卡只剩一句「图片缺失」，再导出去连引用都没了；
   *  ② **整份板列表的读-改-写拿锁**，不然它跟同时在跑的建板 / 删板互相覆盖——
   *     writeWorkspace 会删掉不在列表里的板，后写的那个等于把前一个的成果抹了。
   * 返回值带上附件统计与 notes，让调用方能**如实**告诉用户这次到底进来了什么。
   */
  async importBundle(input: unknown, mode: BrowserImportMode = "merge") {
    // 宽进：新的画板包、旧的浏览器备份、单块板 JSON、导出的 HTML 都从这一个口子进
    const parsed = typeof input === "string" ? parseBoardBundleText(input) : { bundle: parseBoardBundle(input), htmlAssets: new Map<string, string>() };
    const bundle = parsed.bundle;
    const workspace = browserWorkspace();
    return withWorkspaceLock(workspace, async () => {
      const current = await readWorkspace(workspace);
      const incoming =
        mode === "copy"
          ? remapBoards(bundle.boards, {
              boardIds: new Map(bundle.boards.map((board) => [board.id, browserId("b")])),
              freshIds: true,
              newId: (prefix) => browserId(prefix),
            })
          : bundle.boards;
      const restored = incoming.map((board) => stripAssetUrls({ ...board, activity: [] } as Board));
      const boards =
        mode === "copy" ? [...current.boards, ...restored] : mergeBrowserBoards(current.boards, restored, mode === "replace");

      /* 附件：包里带字节的落库，本库已经有的复用，两样都没有的如实记一笔缺件 */
      const wanted = referencedUploadIds(restored);
      const have = await readAssets(workspace, wanted);
      const byId = new Map((bundle.assets || []).map((asset) => [asset.id, asset]));
      const fresh: StoredAsset[] = [];
      const stats = { stored: 0, reused: 0, missing: 0 };
      const notes = [...(bundle.notes || [])];
      for (const id of wanted) {
        if (have.has(id)) {
          stats.reused += 1;
          continue;
        }
        const asset = byId.get(id);
        const fromHtml = parsed.htmlAssets.get(id);
        const decoded = asset?.data
          ? { data: base64ToBuffer(asset.data), mediaType: asset.mediaType }
          : fromHtml
            ? decodeDataUri(fromHtml)
            : null;
        if (!decoded?.data) {
          stats.missing += 1;
          notes.push(`附件没跟着这份文件过来：${asset?.name || id}（卡片留着，图 / 文件在这个库里显示为缺失）`);
          continue;
        }
        fresh.push({
          workspace,
          id,
          name: asset?.name || id,
          mediaType: decoded.mediaType || asset?.mediaType || "application/octet-stream",
          bytes: decoded.data.byteLength,
          data: decoded.data,
        });
        stats.stored += 1;
      }

      await writeWorkspace(workspace, boards);
      await putAssets(workspace, fresh);
      // replace（整库恢复）会删掉备份里没有的板：它们独占的字节跟着走
      if (mode === "replace") await pruneAssets(workspace, referencedUploadIds(boards));
      return {
        workspace,
        imported: restored.length,
        total: boards.length,
        mode,
        boardIds: restored.map((board) => board.id),
        assets: stats,
        notes,
      };
    });
  },

  async putBoard(input: unknown) {
    const raw = input as Board;
    if (!raw || !/^b_[a-z0-9_]+$/.test(String(raw.id || "")) || !Array.isArray(raw.cards) || !Array.isArray(raw.edges)) throw new Error("画板结构无效");
    const workspace = browserWorkspace();
    return withWorkspaceLock(workspace, async () => {
      const current = await readWorkspace(workspace);
      const existing = current.boards.findIndex((board) => board.id === raw.id);
      const board = stripAssetUrls(structuredClone(raw));
      touchBrowserBoard(board);
      if (existing >= 0) current.boards[existing] = board;
      else current.boards.push(board);
      await writeWorkspace(workspace, current.boards);
      return boardDetailLocal(await withAssetUrls(workspace, structuredClone(board)));
    });
  },
};
