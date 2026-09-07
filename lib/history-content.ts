import type { BoardDetail } from './types';

/** Exact semantic comparison for short-lived undo affordances. Camera movement,
 * save timestamps and Issue-sync bookkeeping do not change the user's edit. */
export function boardEditSignature(board: BoardDetail | null): string {
  if (!board) return '';
  const entity = (item: object) => {
    const value = { ...item } as Record<string, unknown>;
    delete value.updatedAt;
    if (value.task && typeof value.task === 'object') {
      value.task = Object.fromEntries(Object.entries(value.task).filter(([key]) => !['issueSyncedAt', 'issueSyncHash', 'issueSyncError', 'taskStatus'].includes(key)));
    }
    return value;
  };
  const stable = (value: unknown): string => {
    if (value === undefined) return 'undefined';
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  };
  return stable({ name: board.name, group: board.group, parentId: board.parentId, settings: board.settings,
    cards: board.cards.map(entity), edges: board.edges.map(entity), comments: (board.comments || []).map(entity) });
}
