import { actorOf, assertCanWrite } from "@/lib/auth";
import { MAX_CANVAS_BODY_BYTES, clientRevision, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardRevision, cardPreview, deleteCard, patchCard, revisionHandshake } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string; cardId: string }> };

export const PATCH = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, cardId } = await ctx.params;
  const id = assertBoardId(boardId);
  // Excalidraw 场景是一大坨 JSON，走放宽后的画布上限
  const body = await readJson(request, MAX_CANVAS_BODY_BYTES);
  // 带上服务端的 updatedAt：前端拿它当自己的版本号，轮询才不会把「我刚改的」误判成「别人改了」；
  // stale 表示「你写之前手上就已经不是最新了」，这种情况前端不能采纳新版本号
  const { stale } = revisionHandshake(id, clientRevision(request));
  return ok({ card: cardPreview(patchCard(id, cardId, body)), updatedAt: boardRevision(id), stale });
});

export const DELETE = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, cardId } = await ctx.params;
  const id = assertBoardId(boardId);
  const { stale } = revisionHandshake(id, clientRevision(request));
  return ok({ removed: deleteCard(id, cardId, actorOf(request)), updatedAt: boardRevision(id), stale });
});
