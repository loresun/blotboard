import { assertCanWrite } from "@/lib/auth";
import { clientRevision, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardRevision, deleteComment, patchComment, revisionHandshake } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string; commentId: string }> };

/** 改正文 / 标记解决（`{resolved:true}`）/ 挪动画布评论的钉点。目标不给改——换目标就删了重建。 */
export const PATCH = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, commentId } = await ctx.params;
  const id = assertBoardId(boardId);
  const body = await readJson(request);
  const { stale } = revisionHandshake(id, clientRevision(request));
  return ok({ comment: patchComment(id, commentId, body), updatedAt: boardRevision(id), stale });
});

export const DELETE = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, commentId } = await ctx.params;
  const id = assertBoardId(boardId);
  const { stale } = revisionHandshake(id, clientRevision(request));
  return ok({ removed: deleteComment(id, commentId), updatedAt: boardRevision(id), stale });
});
