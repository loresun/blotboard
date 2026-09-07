import { assertCanWrite } from "@/lib/auth";
import { clientRevision, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardRevision, createEdge, revisionHandshake } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const id = assertBoardId(boardId);
  const body = await readJson(request);
  const { stale } = revisionHandshake(id, clientRevision(request));
  return ok({ edge: createEdge(id, body), updatedAt: boardRevision(id), stale }, 201);
});
