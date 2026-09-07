import { ok, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { taskStatuses } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

export const GET = route(async (_request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params;
  return ok({ statuses: await taskStatuses(assertBoardId(boardId)) });
});
