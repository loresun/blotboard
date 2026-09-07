import { actorOf, assertCanWrite } from "@/lib/auth";
import { badRequest, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { insertTemplate } from "@/lib/template-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ templateId: string }> };

/** 把模板插进现有画板。body: { boardId, offsetX?, offsetY? }，boardId 也可放 query。 */
export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { templateId } = await ctx.params;
  const body = await readJson(request);
  const boardId = String(body.boardId || new URL(request.url).searchParams.get("boardId") || "");
  if (!boardId) throw badRequest("缺 boardId");
  return ok({ ...insertTemplate(templateId, assertBoardId(boardId), body, actorOf(request)) });
});
