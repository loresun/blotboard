import { actorOf, assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { tidyBoardLayout } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/**
 * 一键整理（服务端跑）：agent 用它就不必自己算坐标，
 * 跟用户点顶栏「整理」是同一套算法，结果也一致。
 */
export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const body = await readJson(request);
  return ok(await tidyBoardLayout(assertBoardId(boardId), body.mode, actorOf(request)));
});
