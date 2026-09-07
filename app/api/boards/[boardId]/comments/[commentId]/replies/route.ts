import { assertCanWrite } from "@/lib/auth";
import { clientRevision, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardRevision, replyToComment, revisionHandshake } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string; commentId: string }> };

/**
 * 回复一条评论：`{ text, createdBy? }`。
 * 回复挂在原评论下面而不是另起一条——一处讨论就该待在一处，
 * 这也是 agent 交活的地方（「按这条评论改完了，见 xxx」）。
 */
export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, commentId } = await ctx.params;
  const id = assertBoardId(boardId);
  const body = await readJson(request);
  const { stale } = revisionHandshake(id, clientRevision(request));
  return ok({ comment: replyToComment(id, commentId, body), updatedAt: boardRevision(id), stale }, 201);
});
