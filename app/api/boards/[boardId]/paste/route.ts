import { actorOf, assertCanWrite } from "@/lib/auth";
import { MAX_CANVAS_BODY_BYTES, clientRevision, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardRevision, pasteCards, revisionHandshake } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/**
 * 把一批卡片（连同它们之间的连线）整批放进这块画板：⌘V 粘贴、右键「复制卡片」都走这里。
 *
 * body: { cards: [...完整卡片对象], edges?: [{from,to,...}], at?: {x,y} }
 *   · cards 里的 id 只用来对连线的两端，落板时一律换成新 id
 *   · at 是画布坐标，整批按左上角对齐过去；不给就在原位上错开一点
 *
 * 一次请求、一次事务、一次落盘——粘 10 张不该是 10 次往返（同批量删除那条）。
 * 画布上的卡可能带着一大坨 SVG / Excalidraw 场景，所以走放宽后的画布上限。
 */
export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const id = assertBoardId(boardId);
  const body = await readJson(request, MAX_CANVAS_BODY_BYTES);
  const { stale } = revisionHandshake(id, clientRevision(request));
  const result = pasteCards(id, body, actorOf(request));
  return ok({ cards: result.cards, edges: result.edges, updatedAt: boardRevision(id), stale }, 201);
});
