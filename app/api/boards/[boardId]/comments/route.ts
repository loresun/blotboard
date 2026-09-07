import { assertCanWrite } from "@/lib/auth";
import { clientRevision, ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardRevision, createComment, listComments, revisionHandshake } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/**
 * 读评论。`?status=open|resolved|all`（默认 open——每次进来要看的是还没处理的那批），
 * 可再按 `?target=card|edge|board` 与 `?targetId=c_xxx` 收窄。
 *
 * 整块板的 GET 也带 comments，前端画气泡用那一份；这个口是给 agent 用的：
 * 「这块板上还有哪些意见没落实」不该逼它先拉一整块 866 KB 的板。
 */
export const GET = route(async (request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params;
  const id = assertBoardId(boardId);
  const params = new URL(request.url).searchParams;
  const comments = listComments(id, {
    status: params.get("status"),
    target: params.get("target"),
    targetId: params.get("targetId"),
  });
  return ok({ comments, total: comments.length, updatedAt: boardRevision(id) });
});

export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const id = assertBoardId(boardId);
  const body = await readJson(request);
  const { stale } = revisionHandshake(id, clientRevision(request));
  return ok({ comment: createComment(id, body), updatedAt: boardRevision(id), stale }, 201);
});
