import { ok, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardCheckpoints } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/**
 * 这块板有哪些自动快照（最新在前）。读操作免鉴权，与其余读接口一致。
 *
 * `enabled: false` = 部署把功能关掉了（`BLOTBOARD_CHECKPOINT_KEEP=0`），
 * 这时清单恒空——前端据此显示「这台没开快照」而不是「你还没有快照」。
 */
export const GET = route(async (_request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params;
  return ok({ ...boardCheckpoints(assertBoardId(boardId)) });
});
