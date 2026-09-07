import { actorOf, assertCanWrite } from "@/lib/auth";
import { MAX_CANVAS_BODY_BYTES, clientRevision, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardRevision, cardPreview, createCard, deleteCards, patchCards, revisionHandshake } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const id = assertBoardId(boardId);
  // Excalidraw 场景是一大坨 JSON，走放宽后的画布上限
  const body = await readJson(request, MAX_CANVAS_BODY_BYTES);
  const { stale } = revisionHandshake(id, clientRevision(request));
  return ok({ card: cardPreview(createCard(id, body)), updatedAt: boardRevision(id), stale }, 201);
});

/**
 * 批量改卡：`{ ids: [...], patch: {...} }`。
 * 一次事务、一次落盘——前端不用再 for 循环发 N 个请求。
 */
export const PATCH = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const body = await readJson(request, MAX_CANVAS_BODY_BYTES);
  const id = assertBoardId(boardId);
  const { stale } = revisionHandshake(id, clientRevision(request));
  const result = patchCards(id, body.ids, body.patch || {}, actorOf(request));
  return ok({ cards: result.cards, updated: result.cards.length, updatedAt: result.updatedAt, stale });
});

/** 批量删卡：`?ids=c_a,c_b` 或请求体 `{ ids: [...] }`。 */
export const DELETE = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const fromQuery = new URL(request.url).searchParams.get("ids");
  const body = fromQuery ? {} : await readJson(request);
  const id = assertBoardId(boardId);
  const { stale } = revisionHandshake(id, clientRevision(request));
  const result = deleteCards(id, fromQuery || body.ids, actorOf(request));
  return ok({ removed: result.removed, updatedAt: result.updatedAt, stale });
});
