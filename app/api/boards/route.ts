import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { boardSummary, createBoard, listBoards } from "@/lib/board-service";

export const dynamic = "force-dynamic";

export const GET = route(async () => ok({ boards: listBoards() }));

export const POST = route(async (request: Request) => {
  assertCanWrite(request);
  const body = await readJson(request);
  return ok({ board: boardSummary(createBoard(body.name, { parentId: body.parentId, group: body.group })) }, 201);
});
