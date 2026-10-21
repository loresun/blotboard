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

/** 只排序同一父板下的兄弟，不移动分组或拆散父子树；相同值保留原顺序。 */
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
