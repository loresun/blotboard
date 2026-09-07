/** Persistent bounded field deltas. This is edit history, not a second board store. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR } from './config';
import { BOARD_ID_RE } from './normalize-base';
import { ApiError } from './http';
import type { Board } from './types';
import type { BoardHistoryState } from './board-history-types';

export const HISTORY_LIMIT = 100;
export const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const COLLECTIONS = ['cards', 'edges', 'comments'] as const;
type Collection = typeof COLLECTIONS[number];
type Entity = Record<string, unknown> & { id: string };
type Values = Record<string, unknown>;
interface Delta { collection: Collection; id: string; before: Values | null; after: Values | null }
interface Entry {
  id: string; at: number; label: string; mergeKey: string | null;
  beforeHash: string; afterHash: string; deltas: Delta[];
  orders: Partial<Record<Collection, { before: string[]; after: string[] }>>;
  meta: { before: Values; after: Values };
}
interface Journal { version: 1; cursor: number; entries: Entry[]; warning: string | null }
const runtimeWarnings = new Map<string, string>();
const TASK_LEDGER_KEYS = ['issueSyncedAt', 'issueSyncHash', 'issueSyncError', 'taskStatus'];
const cleanEntity = (value: Entity): Entity => {
  const { updatedAt: _updatedAt, ...rest } = value;
  if (rest.task && typeof rest.task === 'object') {
    rest.task = Object.fromEntries(Object.entries(rest.task).filter(([key]) => !TASK_LEDGER_KEYS.includes(key)));
  }
  return rest as Entity;
};
function taskBoundary(before: Board, after: Board): boolean {
  const previous = new Map(before.cards.map((card) => [card.id, card]));
  return after.cards.some((card) => {
    const old = previous.get(card.id);
    if (!old) return false; // undoing deletion must still restore the original references
    for (const key of ['issueId', 'issueNumber', 'taskId', 'issuedAt']) {
      if (!equal((old.task as unknown as Values | undefined)?.[key] ?? null, (card.task as unknown as Values | undefined)?.[key] ?? null)) return true;
    }
    return Boolean(old.task?.taskId || card.task?.taskId) && old.task?.status !== card.task?.status;
  });
}
function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Values)[key])}`).join(',')}}`;
}
const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
function metadata(board: Board): Values {
  return Object.fromEntries(['name', 'group', 'parentId', 'settings'].filter((key) => Object.hasOwn(board, key)).map((key) => [key, (board as unknown as Values)[key]]));
}
export function historyHash(board: Board): string {
  const value = { ...metadata(board), ...Object.fromEntries(COLLECTIONS.map((key) => [key, (board[key] || []).map((item) => cleanEntity(item as unknown as Entity))])) };
  return createHash('sha256').update(stable(value)).digest('hex');
}
function journalFile(boardId: string): string {
  if (!BOARD_ID_RE.test(boardId)) throw new ApiError('画板 id 无效', 400);
  return path.join(DATA_DIR, 'history', `${boardId}.json`);
}
const empty = (warning: string | null = null): Journal => ({ version: 1, cursor: 0, entries: [], warning });
function readJournal(boardId: string): Journal {
  try {
    const file = journalFile(boardId);
    if (fs.statSync(file).size > HISTORY_MAX_BYTES) return empty('历史文件超过容量限制，旧撤销链不可用；后续编辑会建立新记录。');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as Journal;
    if (journal.version !== 1 || !Array.isArray(journal.entries) || journal.entries.length > HISTORY_LIMIT || !Number.isInteger(journal.cursor) || journal.cursor < 0 || journal.cursor > journal.entries.length) throw new Error('invalid history');
    return journal;
  } catch (error: any) {
    return empty(error?.code === 'ENOENT' ? null : '历史记录无法读取，旧撤销链不可用；后续编辑会建立新记录。');
  }
}
function writeJournal(boardId: string, journal: Journal): void {
  const file = journalFile(boardId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(journal), { mode: 0o600 });
    fs.renameSync(temp, file);
    runtimeWarnings.delete(boardId);
  } finally { try { fs.unlinkSync(temp); } catch { /* renamed or never created */ } }
}
/** Recover an interrupted undo/redo, or detach history after an out-of-band edit. */
function reconcile(journal: Journal, hash: string): Journal {
  if (!journal.entries.length) return journal;
  const expected = journal.cursor ? journal.entries[journal.cursor - 1].afterHash : journal.entries[0].beforeHash;
  if (expected === hash) return journal;
  // Persisting the board and cursor uses two atomic files. A crash between them
  // can leave the board exactly one step ahead/behind; recognize that state.
  const back = journal.cursor > 0 && journal.entries[journal.cursor - 1].beforeHash === hash;
  const forward = journal.cursor < journal.entries.length && journal.entries[journal.cursor].afterHash === hash;
  if (back !== forward) return { ...journal, cursor: journal.cursor + (back ? -1 : 1) };
  return empty('画板存在历史之外的修改，已停止旧撤销链以保护当前内容；后续编辑会建立新记录。');
}
function difference(before: Values, after: Values): { before: Values; after: Values } {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !equal(before[key], after[key]));
  return {
    before: Object.fromEntries(keys.filter((key) => Object.hasOwn(before, key)).map((key) => [key, before[key]])),
    after: Object.fromEntries(keys.filter((key) => Object.hasOwn(after, key)).map((key) => [key, after[key]])),
  };
}
function makeEntry(before: Board, after: Board): Entry | null {
  const beforeHash = historyHash(before), afterHash = historyHash(after);
  if (beforeHash === afterHash) return null; // viewport, activity and timestamps are not edits
  const deltas: Delta[] = [], orders: Entry['orders'] = {};
  for (const collection of COLLECTIONS) {
    const oldRaw = new Map((before[collection] || []).map((item) => [item.id, item as unknown as Entity]));
    const newRaw = new Map((after[collection] || []).map((item) => [item.id, item as unknown as Entity]));
    const oldItems = [...oldRaw.values()].map(cleanEntity);
    const newItems = [...newRaw.values()].map(cleanEntity);
    const oldMap = new Map(oldItems.map((item) => [item.id, item])), newMap = new Map(newItems.map((item) => [item.id, item]));
    const oldOrder = oldItems.map((item) => item.id), newOrder = newItems.map((item) => item.id);
    if (!equal(oldOrder, newOrder)) orders[collection] = { before: oldOrder, after: newOrder };
    for (const id of new Set([...oldMap.keys(), ...newMap.keys()])) {
      const oldItem = oldMap.get(id), newItem = newMap.get(id);
      if (equal(oldItem, newItem)) continue;
      // Insert/delete stores the original full entity, including timestamps and
      // task bookkeeping; editing stores only fields that are actually changed.
      const changed = oldItem && newItem ? difference(oldItem, newItem) : { before: oldRaw.get(id) || null, after: newRaw.get(id) || null };
      deltas.push({ collection, id, ...changed });
    }
  }
  const meta = difference(metadata(before), metadata(after));
  const keys = deltas.flatMap((delta) => Object.keys(delta.after || delta.before || {}));
  const structural = deltas.some((delta) => delta.before === null || delta.after === null);
  const geometry = deltas.length > 0 && !structural && deltas.every((delta) => delta.collection === 'cards') && keys.every((key) => ['x', 'y', 'w', 'h', 'z', 'frameId'].includes(key));
  const activity = after.activity?.[0];
  const freshActivity = activity && !equal(activity, before.activity?.[0]) ? activity : null;
  const label = freshActivity?.summary || (geometry ? `移动 / 整理 ${deltas.length} 张卡片` : structural ? '新增 / 删除画板内容' : deltas.length ? `编辑 ${deltas.length} 项内容` : '修改画板信息');
  const mergeKey = !freshActivity && !geometry && !structural && deltas.length === 1 && deltas[0].collection === 'cards' && !Object.keys(meta.before).length && !Object.keys(meta.after).length
    ? `card:${deltas[0].id}:${[...new Set([...Object.keys(deltas[0].before || {}), ...Object.keys(deltas[0].after || {})])].sort().join(',')}` : null;
  return { id: randomUUID(), at: Date.now(), label: label.slice(0, 200), beforeHash, afterHash, deltas, orders, meta, mergeKey };
}
/** Never turn a committed board write into a failure if its secondary history cannot persist. */
export function recordBoardHistory(before: Board, after: Board): void {
  try {
    if (taskBoundary(before, after)) {
      writeJournal(after.id, empty('任务关联或执行状态发生变化，旧撤销链已停止。撤销不会取消任务；此后的画板编辑将建立新历史。'));
      return;
    }
    const entry = makeEntry(before, after);
    if (!entry) return;
    const journal = reconcile(readJournal(after.id), entry.beforeHash);
    const hadRedo = journal.cursor < journal.entries.length;
    journal.entries = journal.entries.slice(0, journal.cursor);
    const previous = journal.entries.at(-1);
    if (!hadRedo && previous && entry.mergeKey && previous.mergeKey === entry.mergeKey && entry.at - previous.at <= 2000) {
      // Same entity+field set, so each earlier before value remains valid.
      previous.afterHash = entry.afterHash;
      previous.deltas[0].after = entry.deltas[0].after;
      previous.at = entry.at;
      if (previous.beforeHash === previous.afterHash) journal.entries.pop();
    } else journal.entries.push(entry);
    const beforeTrim = journal.entries.length;
    while (journal.entries.length > HISTORY_LIMIT || (journal.entries.length && Buffer.byteLength(JSON.stringify(journal)) > HISTORY_MAX_BYTES - 512)) journal.entries.shift();
    if (beforeTrim && !journal.entries.length) journal.warning = '这次改动超过历史容量限制，无法逐步撤销；可检查整板快照。';
    journal.cursor = journal.entries.length;
    writeJournal(after.id, journal);
  } catch {
    runtimeWarnings.set(after.id, '画板已保存，但这次历史记录未能保存，撤销链可能不可用。');
    console.error('[history] History write failed; board changes were saved.');
  }
}
export function boardHistoryState(board: Board): BoardHistoryState {
  const journal = reconcile(readJournal(board.id), historyHash(board));
  return {
    entries: journal.entries.map((entry, index) => ({ id: entry.id, at: entry.at, label: entry.label, applied: index < journal.cursor, changes: entry.deltas.length })),
    cursor: journal.cursor,
    canUndo: journal.cursor > 0, canRedo: journal.cursor < journal.entries.length,
    undoLabel: journal.entries[journal.cursor - 1]?.label, redoLabel: journal.entries[journal.cursor]?.label,
    limit: HISTORY_LIMIT, maxBytes: HISTORY_MAX_BYTES,
    warning: runtimeWarnings.get(board.id) || journal.warning,
  };
}
function replaceFields(target: Values, before: Values, after: Values): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (Object.hasOwn(after, key)) Object.defineProperty(target, key, { value: structuredClone(after[key]), writable: true, enumerable: true, configurable: true });
    else delete target[key];
  }
}
/** Prepare is pure with respect to board/storage; caller persists the board first, then cursor. */
export function prepareHistoryStep(board: Board, direction: 'undo' | 'redo') {
  const journal = reconcile(readJournal(board.id), historyHash(board));
  const entry = direction === 'undo' ? journal.entries[journal.cursor - 1] : journal.entries[journal.cursor];
  if (!entry) throw new ApiError(direction === 'undo' ? '没有可撤销的记录' : '没有可重做的记录', 409);
  const backwards = direction === 'undo';
  const expected = backwards ? entry.afterHash : entry.beforeHash;
  if (historyHash(board) !== expected) throw new ApiError('画板已被其他操作修改，请刷新历史后重试', 409);
  const next = structuredClone(board);
  for (const delta of entry.deltas) {
    const previous = backwards ? delta.after : delta.before;
    const target = backwards ? delta.before : delta.after;
    const collection = next[delta.collection] as unknown as Entity[];
    const index = collection.findIndex((entity) => entity.id === delta.id);
    if (target === null) { if (index >= 0) collection.splice(index, 1); }
    else if (previous === null) collection.push(structuredClone(target) as Entity);
    else {
      if (index < 0) throw new ApiError('历史中的对象已不存在，请刷新画板', 409);
      const ledger = collection[index].task && typeof collection[index].task === 'object'
        ? Object.fromEntries(Object.entries(collection[index].task).filter(([key]) => TASK_LEDGER_KEYS.includes(key))) : null;
      replaceFields(collection[index], previous, target);
      if (ledger && collection[index].task && typeof collection[index].task === 'object') Object.assign(collection[index].task, ledger);
    }
  }
  for (const collection of COLLECTIONS) {
    const order = entry.orders[collection];
    if (!order) continue;
    const indexes = new Map((backwards ? order.before : order.after).map((id, index) => [id, index]));
    (next[collection] as unknown as Entity[]).sort((a, b) => (indexes.get(a.id) ?? Infinity) - (indexes.get(b.id) ?? Infinity));
  }
  replaceFields(next as unknown as Values, backwards ? entry.meta.after : entry.meta.before, backwards ? entry.meta.before : entry.meta.after);
  if (historyHash(next) !== (backwards ? entry.beforeHash : entry.afterHash)) throw new ApiError('历史记录不完整，无法安全应用；当前画板未改变', 409);
  journal.cursor += backwards ? -1 : 1;
  return { next, label: entry.label, commit: () => {
    try { writeJournal(board.id, journal); }
    catch { runtimeWarnings.set(board.id, '内容已恢复，历史游标暂未保存；刷新时会按内容恢复游标。'); }
  } };
}
export function removeBoardHistory(boardId: string): void {
  try { fs.rmSync(journalFile(boardId), { force: true }); } catch { /* board deletion remains authoritative */ }
  runtimeWarnings.delete(boardId);
}
