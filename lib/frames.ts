/**
 * 分组框的几何诊断：**框里看着有、但归属上没有的卡片**。
 *
 * 归属的真源永远只有一处——子卡身上的 `frameId`（见 lib/board-service.ts 的
 * 「分组框的归属关系」一节）。画布上把一张卡拖到框上面并不改归属，批量导入 /
 * 整板改写更是只按字段落库；于是很容易出现「视觉上圈住了、`frameId` 还是 null」
 * 的板子——框上写着 0 张，阅读模式里也是个空框。
 *
 * 这个模块只回答「**如果**你想按几何收一次，会收到哪些」，
 * 一个字都不写盘。真要改归属得由用户点那颗「收纳框内卡片」（见 cards/frame/ui.tsx）——
 * 系统绝不因为两个矩形重叠就悄悄改一张卡的归属。
 */

/** 判定用的最小卡片形状：几何 + 类型 + 现有归属 */
export interface FrameCandidateCard {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  frameId?: string | null;
}

/**
 * 「在框里」的判定：**卡片中心点落在框的矩形内**。
 *
 * 不用「完全包含」是因为拖进框的卡常常有一角探在外面，用户眼里它就是框里的；
 * 也不用「有重叠就算」——那样擦着边框过的卡会被算进来，比漏掉更让人意外。
 * 中心点是这两者之间唯一好解释的一条线，跟用户拖卡时的手感也一致。
 */
export function centerInside(card: { x: number; y: number; w: number; h: number }, frame: { x: number; y: number; w: number; h: number }): boolean {
  const cx = card.x + card.w / 2;
  const cy = card.y + card.h / 2;
  return cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h;
}

/**
 * 这个框「圈住了但没收进来」的卡片 id。
 *
 * 只认**还没归属任何框**的自由卡（`frameId` 为空）。已经归属别的框的卡不在候选里——
 * 那是用户明确表达过的归属，凭「它现在压在另一个框上面」就改掉，正是这个模块存在的意义
 * 所反对的事情。框本身也不算（不做嵌套分组，见 assertFrameRef）。
 */
export function frameCandidateIds(cards: readonly FrameCandidateCard[] | null | undefined, frameId: string): string[] {
  const frame = (cards || []).find((card) => card.id === frameId && card.type === "frame");
  if (!frame) return [];
  return (cards || [])
    .filter((card) => card.id !== frame.id && card.type !== "frame" && !card.frameId && centerInside(card, frame))
    .map((card) => card.id);
}

/** 这个框现在真正的成员数（按 frameId 数，不按几何） */
export function frameMemberIds(cards: readonly FrameCandidateCard[] | null | undefined, frameId: string): string[] {
  return (cards || []).filter((card) => card.frameId === frameId).map((card) => card.id);
}
