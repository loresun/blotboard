import { actorOf, assertCanWrite } from "@/lib/auth";
import { ok, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardDetail, restoreCheckpoint } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string; stamp: string }> };

/**
 * 回滚到某一份快照：**覆盖当前的卡片 / 连线 / 批注**（板名、分组、父板不动）。
 * 响应里的 `checkpoint` 是「回滚之前那一刻」新打的点——回滚本身也留了回头路。
 */
export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, stamp } = await ctx.params;
  const result = restoreCheckpoint(assertBoardId(boardId), stamp, actorOf(request));
  return ok({ board: boardDetail(result.board), restored: result.restored, checkpoint: result.checkpoint });
});
