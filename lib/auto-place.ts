/** 入板自动摆位：没给坐标的卡摆成网格，起点让开画板上已有的内容。 */
import type { Board } from "./types";

/** 自动布局：没给坐标的卡按这个网格摆 */
export const PLACE_GRID_COLS = 3;
const GRID_GAP_X = 40;
const GRID_GAP_Y = 32;
const INSERT_GAP = 200;

/**
 * 把**没给坐标**的卡就地摆开（原地写 payload.x / payload.y）。
 *
 * 为什么要有这一层：`normalizeCardInput` 对缺省坐标一律给 (80, 80)，
 * 于是「agent 连发 N 张无坐标卡」的结果是全部叠在同一点，肉眼只看得到最后一张。
 * 单卡建卡、批量建卡、信封导入共用这一份规则，落点口径才一致。
 *
 * 只碰 `x` / `y` **双缺省**的卡：只给一个坐标的按原语义走（交给 clamp 兜另一个）。
 */
export function placeMissingCards(board: Board, payloads: Record<string, any>[]): void {
  const pending = payloads.filter((card) => card.x === undefined || card.y === undefined);
  if (!pending.length) return;
  const existing = board.cards || [];
  const startX = existing.length ? Math.max(...existing.map((card) => card.x + card.w)) + INSERT_GAP : 80;
  const startY = existing.length ? Math.min(...existing.map((card) => card.y)) : 80;
  const colWidth = Math.max(...pending.map((card) => Number(card.w) || 320)) + GRID_GAP_X;
  const rowHeight = Math.max(...pending.map((card) => Number(card.h) || 240)) + GRID_GAP_Y;
  pending.forEach((card, index) => {
    card.x = startX + (index % PLACE_GRID_COLS) * colWidth;
    card.y = startY + Math.floor(index / PLACE_GRID_COLS) * rowHeight;
  });
}
