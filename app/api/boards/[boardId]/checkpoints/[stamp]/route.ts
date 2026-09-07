import { assertCanWrite } from "@/lib/auth";
import { notFound, ok, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { deleteCheckpoint } from "@/lib/checkpoints";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string; stamp: string }> };

/** 删一份快照（写操作鉴权同其余写口）。 */
export const DELETE = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, stamp } = await ctx.params;
  const id = assertBoardId(boardId);
  if (!deleteCheckpoint(id, stamp)) throw notFound("快照不存在");
  return ok({ removed: stamp });
});
