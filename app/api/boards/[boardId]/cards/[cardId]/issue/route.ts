import { assertCanWrite } from "@/lib/auth";
import { ApiError, notFound, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardRevision, cardPreview, convertCardToIssue, getBoard } from "@/lib/board-service";
import { syncIssuesNow } from "@/lib/issue-sync";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string; cardId: string }> };

/** 卡片转 Issue（Issue 真源在 Goal Agent，这里只存引用 id）。 */
export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, cardId } = await ctx.params;
  // body.context 可单次覆盖画板的上下文策略（{ mode, types }）
  const body = await readJson(request);
  const result = await convertCardToIssue(assertBoardId(boardId), cardId, { context: body.context });
  if (result.alreadyIssued) return ok({ alreadyIssued: true, card: result.card });
  return ok({ issue: result.issue, card: result.card }, 201);
});

/**
 * 立即把这张卡的最新内容推给 Goal Agent（画板 → Issue 单向）。
 *
 * 自动同步是防抖的，这条口是「不想等」用的：编辑抽屉一提交就走这里，
 * 于是「保存完了没推过去」这段窗口不存在。`{ force: true }` 连指纹也不看，
 * 手点「同步」按钮时用它 —— 点了就该真发一次。
 */
export const PUT = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, cardId } = await ctx.params;
  const id = assertBoardId(boardId);
  const body = await readJson(request);
  const card = (getBoard(id).cards || []).find((entry) => entry.id === cardId);
  if (!card) throw notFound("卡片不存在");
  if (!card.task?.issueId) throw notFound("这张卡还没转 Issue");
  const report = await syncIssuesNow(id, { force: body.force === true, cardIds: [cardId] });
  const outcome = report.cards[0] || null;
  if (outcome?.status === "failed") throw new ApiError(outcome.error || "同步失败", 502);
  // 同步会把 issueSyncedAt 写回卡上，所以要回一份新的卡片与版本号
  const fresh = (getBoard(id).cards || []).find((entry) => entry.id === cardId)!;
  return ok({ synced: outcome?.status === "synced", card: cardPreview(fresh), updatedAt: boardRevision(id) });
});
