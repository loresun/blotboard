import { assertCanWrite } from "@/lib/auth";
import { clientRevision, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardRevision, deleteEdge, patchEdge, revisionHandshake } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string; edgeId: string }> };

/** PATCH 改标签是新增能力（旧前端靠「删了重建」，会换 id）；DELETE 与 goal-agent 一致。 */
export const PATCH = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, edgeId } = await ctx.params;
  const id = assertBoardId(boardId);
  const body = await readJson(request);
  const { stale } = revisionHandshake(id, clientRevision(request));
  return ok({ edge: patchEdge(id, edgeId, body), updatedAt: boardRevision(id), stale });
});

export const DELETE = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, edgeId } = await ctx.params;
  const id = assertBoardId(boardId);
  const { stale } = revisionHandshake(id, clientRevision(request));
  return ok({ removed: deleteEdge(id, edgeId), updatedAt: boardRevision(id), stale });
});
