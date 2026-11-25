/**
 * Pure flattening and scroll-windowing helpers for the board tree in Sidebar.
 * Keeping this pure lets Node unit tests verify 1,000+ board windowing directly.
 */

export const SIDEBAR_GROUP_ROW_HEIGHT = 32;
export const SIDEBAR_GROUP_ROW_HEIGHT_TOUCH = 44;
export const SIDEBAR_BOARD_ROW_HEIGHT = 48;
export const SIDEBAR_DEFAULT_VIEWPORT_HEIGHT = 720;
export const SIDEBAR_OVERSCAN = 6;

export interface VirtualBoardItem {
  id: string;
  name: string;
  parentId?: string | null;
  group?: string;
  counts?: { cards: number; edges: number; tasks?: number; openComments?: number };
}

export type VirtualSidebarRow<T extends VirtualBoardItem = VirtualBoardItem> =
  | {
      kind: "group";
      key: string;
      group: string;
      total: number;
      folded: boolean;
      currentGroup: boolean;
      height: number;
      offsetTop: number;
    }
  | {
      kind: "board";
      key: string;
      group: string;
      item: T;
      depth: number;
      hasChildren: boolean;
      folded: boolean;
      height: number;
      offsetTop: number;
    };

export interface FlattenedSidebarTree<T extends VirtualBoardItem = VirtualBoardItem> {
  rows: VirtualSidebarRow<T>[];
  totalHeight: number;
  indexByBoardId: Map<string, number>;
}

export interface VirtualWindow<T extends VirtualBoardItem = VirtualBoardItem> {
  startIndex: number;
  endIndex: number;
  topPadding: number;
  bottomPadding: number;
  totalHeight: number;
  visibleRows: VirtualSidebarRow<T>[];
}

export function countBoardDescendants<T extends VirtualBoardItem>(
  byParent: Map<string, T[]>,
  id: string,
  seen: Set<string> = new Set(),
): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  let total = 0;
  for (const child of byParent.get(id) || []) {
    if (seen.has(child.id)) continue;
    total += 1 + countBoardDescendants(byParent, child.id, seen);
  }
  return total;
}

export function flattenBoardTree<T extends VirtualBoardItem>(options: {
  names: string[];
  groups: Map<string, T[]>;
  byParent: Map<string, T[]>;
  foldedGroups: Record<string, boolean>;
  keyword: string;
  activeGroup: string;
  activeFound: boolean;
  groupRowHeight?: number;
  boardRowHeight?: number;
}): FlattenedSidebarTree<T> {
  const {
    names,
    groups,
    byParent,
    foldedGroups,
    keyword,
    activeGroup,
    activeFound,
    groupRowHeight = SIDEBAR_GROUP_ROW_HEIGHT,
    boardRowHeight = SIDEBAR_BOARD_ROW_HEIGHT,
  } = options;

  const rows: VirtualSidebarRow<T>[] = [];
  const indexByBoardId = new Map<string, number>();
  let offsetTop = 0;

  const appendBranch = (item: T, group: string, depth: number, visited: Set<string>) => {
    if (visited.has(item.id)) return;
    visited.add(item.id);
    const children = byParent.get(item.id) || [];
    const boardFolded = keyword ? false : foldedGroups[item.id] === true;
    indexByBoardId.set(item.id, rows.length);
    rows.push({
      kind: "board",
      key: item.id,
      group,
      item,
      depth,
      hasChildren: children.length > 0,
      folded: boardFolded,
      height: boardRowHeight,
      offsetTop,
    });
    offsetTop += boardRowHeight;
    if (!boardFolded) {
      for (const child of children) {
        appendBranch(child, group, depth + 1, visited);
      }
    }
  };

  for (const group of names) {
    const roots = groups.get(group) || [];
    const groupKey = `g:${group}`;
    const groupFolded = keyword ? false : foldedGroups[groupKey] === true;
    const total = roots.reduce((sum, item) => sum + 1 + countBoardDescendants(byParent, item.id), 0);
    const currentGroup = activeFound && group === activeGroup;
    const showHeader = Boolean(group || names.length > 1 || groupFolded);

    if (showHeader) {
      rows.push({
        kind: "group",
        key: groupKey,
        group,
        total,
        folded: groupFolded,
        currentGroup,
        height: groupRowHeight,
        offsetTop,
      });
      offsetTop += groupRowHeight;
    }

    if (!groupFolded) {
      const visited = new Set<string>();
      for (const root of roots) {
        appendBranch(root, group, 0, visited);
      }
    }
  }

  return { rows, totalHeight: offsetTop, indexByBoardId };
}

function findFirstVisibleIndex<T extends VirtualBoardItem>(
  rows: VirtualSidebarRow<T>[],
  scrollTop: number,
): number {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = rows.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid];
    if (row.offsetTop + row.height > scrollTop) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function findEndVisibleIndex<T extends VirtualBoardItem>(
  rows: VirtualSidebarRow<T>[],
  viewportBottom: number,
  startFrom: number,
): number {
  let lo = startFrom;
  let hi = rows.length - 1;
  let ans = rows.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].offsetTop >= viewportBottom) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

export function computeVirtualWindow<T extends VirtualBoardItem>(
  rows: VirtualSidebarRow<T>[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number = SIDEBAR_OVERSCAN,
): VirtualWindow<T> {
  if (!rows.length) {
    return {
      startIndex: 0,
      endIndex: 0,
      topPadding: 0,
      bottomPadding: 0,
      totalHeight: 0,
      visibleRows: [],
    };
  }

  const last = rows[rows.length - 1];
  const totalHeight = last.offsetTop + last.height;
  const safeViewport = viewportHeight > 0 ? viewportHeight : SIDEBAR_DEFAULT_VIEWPORT_HEIGHT;
  const maxScroll = Math.max(0, totalHeight - safeViewport);
  const clampedScroll = Math.max(0, Math.min(Number.isFinite(scrollTop) ? scrollTop : 0, maxScroll));

  const firstVisible = Math.min(rows.length - 1, findFirstVisibleIndex(rows, clampedScroll));
  const endVisible = findEndVisibleIndex(rows, clampedScroll + safeViewport, firstVisible);

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(rows.length, Math.max(firstVisible + 1, endVisible) + overscan);
  const topPadding = rows[startIndex].offsetTop;
  const lastRendered = rows[endIndex - 1];
  const bottomPadding = Math.max(0, totalHeight - (lastRendered.offsetTop + lastRendered.height));

  return {
    startIndex,
    endIndex,
    topPadding,
    bottomPadding,
    totalHeight,
    visibleRows: rows.slice(startIndex, endIndex),
  };
}
