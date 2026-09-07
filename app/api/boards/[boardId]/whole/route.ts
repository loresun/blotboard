import { actorOf, assertCanWrite } from "@/lib/auth";
import { MAX_CANVAS_BODY_BYTES, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardDetail, replaceWhole } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/** 全量替换画板（配置 JSON「应用」/ agent 整板改写）。 */
export const PUT = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const body = await readJson(request, MAX_CANVAS_BODY_BYTES);
  return ok({ board: boardDetail(replaceWhole(assertBoardId(boardId), body, actorOf(request))) });
});
