/** 子画板卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import type { BoardRefField } from "@/lib/types";
import { BOARD_ID_RE, MAX_NAME, cleanText } from "@/lib/normalize-base";
import { badRequest } from "@/lib/http";
import type { CardPackSchema } from "@/lib/card-pack-types";

/** 子画板引用：只存目标画板 id + 一份冗余名字；目标是否还在由读取时判断。 */
export function normalizeBoardRefField(input: Partial<BoardRefField> = {}, { required = false } = {}): BoardRefField {
  const boardId = cleanText(input.boardId, 60);
  if (!boardId) {
    if (required) throw badRequest("子画板卡片必须提供 boardRef.boardId");
    return { boardId: "", name: cleanText(input.name, MAX_NAME) };
  }
  if (!BOARD_ID_RE.test(boardId)) throw badRequest("boardRef.boardId 无效");
  return { boardId, name: cleanText(input.name, MAX_NAME) };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.boardRef = normalizeBoardRefField(input.boardRef, { required: true });
  },
  onConvert(card, patch) {
    card.boardRef = normalizeBoardRefField({ ...(card.boardRef || {}), ...(patch.boardRef || {}) }, { required: true });
  },
  onPatch(card, patch) {
    if (patch.boardRef !== undefined) card.boardRef = normalizeBoardRefField({ ...(card.boardRef || {}), ...patch.boardRef });
  },
  markdownLines(card) {
    if (!card.boardRef?.boardId) return [];
    return [`- 子画板：\`${card.boardRef.boardId}\`${card.boardRef.name ? ` （${card.boardRef.name}）` : ""}`];
  },
};
