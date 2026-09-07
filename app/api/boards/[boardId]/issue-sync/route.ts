import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardRevision, getBoard } from "@/lib/board-service";
import { syncIssuesNow } from "@/lib/issue-sync";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/**
 * 这块板上转过 Issue 的卡片，各自同步到什么程度了。
 * 只读账本，不发请求 —— 前端拿它画「有改动没推过去」的提示。
 */
export const GET = route(async (_request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params;
  const board = getBoard(assertBoardId(boardId));
  const cards = (board.cards || [])
    .filter((card) => card.type === "task" && card.task?.issueId)
    .map((card) => ({
      cardId: card.id,
      title: card.title,
      issueId: card.task!.issueId,
      issueNumber: card.task!.issueNumber,
      syncedAt: card.task!.issueSyncedAt,
      error: card.task!.issueSyncError,
    }));
  return ok({ mode: board.settings?.issueSync || "auto", total: cards.length, cards });
});

/**
 * 整块板扫一遍，把内容变过的 Issue 推给 Goal Agent。
 * `{ force?: true }` 忽略指纹全部重推；`{ cardIds: [...] }` 只推这几张。
 */
export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const id = assertBoardId(boardId);
  const body = await readJson(request);
  const cardIds = Array.isArray(body.cardIds) ? body.cardIds.map((item: unknown) => String(item || "")) : undefined;
  const report = await syncIssuesNow(id, { force: body.force === true, cardIds });
  return ok({ ...report, updatedAt: boardRevision(id) });
});
