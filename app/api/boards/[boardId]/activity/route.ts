import { ok, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardActivityLog } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/**
 * 这块板上最近的批量改动（最新在前，上限 50 条）。
 * 整板 GET 里也带同一份（`board.activity`）——这个口是给「只想看日志」的调用方省流量的。
 */
export const GET = route(async (_request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params;
  const activity = boardActivityLog(assertBoardId(boardId));
  return ok({ activity, total: activity.length });
});
