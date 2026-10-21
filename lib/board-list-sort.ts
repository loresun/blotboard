import type { BoardListItem } from "./types";

export const BOARD_LIST_SORTS = ["default", "updated", "created", "name"] as const;
export type BoardListSort = (typeof BOARD_LIST_SORTS)[number];
export interface BoardListSortPreference {
  field: BoardListSort;
  direction: "asc" | "desc";
}

export const DEFAULT_BOARD_LIST_SORT: BoardListSortPreference = { field: "default", direction: "desc" };

/** 浏览器偏好不是可信输入，旧值、损坏 JSON 或未知选项都回退到原来的顺序。 */
export function parseBoardListSort(raw: string | null): BoardListSortPreference {
  try {
    const value = JSON.parse(raw || "null");
    if (value && BOARD_LIST_SORTS.includes(value.field) && (value.direction === "asc" || value.direction === "desc")) {
      return { field: value.field, direction: value.direction };
    }
  } catch { /* 无法读取偏好不影响开板。 */ }
  return { ...DEFAULT_BOARD_LIST_SORT };
}

const names = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
type SortableBoard = Pick<BoardListItem, "name" | "createdAt" | "updatedAt">;

/** 排序同一父板下的兄弟，不拆散父子树；相同值保留原顺序。 */
export function sortBoardSiblings<T extends SortableBoard>(items: readonly T[], preference: BoardListSortPreference): T[] {
  const result = [...items];
  if (preference.field === "default") return result;
  const sign = preference.direction === "asc" ? 1 : -1;
  return result.sort((left, right) => {
    if (preference.field === "name") return sign * names.compare(left.name, right.name);
    const time = (board: T) => preference.field === "created" ? board.createdAt : board.updatedAt || board.createdAt;
    return sign * (time(left) - time(right));
  });
}

type GroupBoard = SortableBoard & Pick<BoardListItem, "id" | "parentId" | "group">;

/**
 * 分组没有独立时间戳，与导航页一致，取成员最近一次建板 / 修改时间。
 * 成员按左栏实际的顶层祖先归组（包含所有后代），从完整列表聚合，搜索不改变排序键。
 */
export function sortBoardGroups(groupNames: readonly string[], boards: readonly GroupBoard[], preference: BoardListSortPreference): string[] {
  const times = new Map<string, { created: number; updated: number }>();
  if (preference.field === "created" || preference.field === "updated") {
    const byId = new Map(boards.map((board) => [board.id, board]));
    const owners = new Map<string, string>();
    for (const board of boards) {
      const trail: GroupBoard[] = [];
      const seen = new Set<string>();
      let cursor = board;
      let group = board.group || "";
      while (!seen.has(cursor.id)) {
        if (owners.has(cursor.id)) {
          group = owners.get(cursor.id)!;
          break;
        }
        seen.add(cursor.id);
        trail.push(cursor);
        group = cursor.group || "";
        const parent = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        if (!parent) break;
        cursor = parent;
      }
      for (const member of trail) owners.set(member.id, group);
      const previous = times.get(group);
      times.set(group, {
        created: Math.max(previous?.created ?? -Infinity, board.createdAt),
        updated: Math.max(previous?.updated ?? -Infinity, board.updatedAt || board.createdAt),
      });
    }
  }
  const sign = preference.direction === "asc" ? 1 : -1;
  return [...groupNames].sort((left, right) => {
    if (left === "" || right === "") return left === right ? 0 : left === "" ? 1 : -1;
    // 默认模式恢复旧版分组顺序，不因上次选择的方向发生变化。
    if (preference.field === "default") return left.localeCompare(right, "zh");
    if (preference.field === "name") return sign * names.compare(left, right);
    const delta = (times.get(left)?.[preference.field] ?? 0) - (times.get(right)?.[preference.field] ?? 0);
    return sign * delta || names.compare(left, right);
  });
}
