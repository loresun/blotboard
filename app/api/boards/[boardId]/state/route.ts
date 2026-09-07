import { assertCanWrite } from "@/lib/auth";
import { clientRevision, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { revisionHandshake, saveBoardState } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/** 批量几何保存：viewport + 全部卡片的 x/y/w/h/z。 */
export const PUT = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const body = await readJson(request);
  const id = assertBoardId(boardId);
  // 几何保存最频繁，也最容易踩到「中途别人改过」——握手放在写之前算
  const { stale } = revisionHandshake(id, clientRevision(request));
  return ok({ ...saveBoardState(id, body), stale });
});
