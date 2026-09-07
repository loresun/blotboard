import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardDetail, deleteBoard, getBoard, patchBoard } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/**
 * `?since=<updatedAt>` 是给轮询用的条件拉取：没变就只回一个几十字节的 `{ unchanged: true }`，
 * 不必把整块板（大的有 866 KB）再传一遍。变了才走正常的全量返回。
 */
export const GET = route(async (request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params;
  const board = getBoard(assertBoardId(boardId));
  const since = Number(new URL(request.url).searchParams.get("since") || 0);
  if (since && board.updatedAt && since === board.updatedAt) {
    return ok({ unchanged: true, updatedAt: board.updatedAt });
  }
  return ok({ board: boardDetail(board) });
});

export const PATCH = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  const body = await readJson(request);
  return ok({ board: boardDetail(patchBoard(assertBoardId(boardId), body)) });
});

export const DELETE = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId } = await ctx.params;
  return ok({ removed: deleteBoard(assertBoardId(boardId)) });
});
