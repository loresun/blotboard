import { actorOf, assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { ingestEnvelope } from "@/lib/card-ingest";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/** 收一个卡片信封落到这块画板。body 形状见 GET /api/card-specs/schema。 */
export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const body = await readJson(request);
  const result = ingestEnvelope(assertBoardId(boardId), body, actorOf(request));
  return ok({ ...result }, 201);
});
