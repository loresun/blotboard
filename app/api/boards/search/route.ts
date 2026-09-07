import { ok, route } from "@/lib/http";
import { searchBoards } from "@/lib/board-service";

export const dynamic = "force-dynamic";

/** 跨画板全文搜索（只读，免鉴权，与 GET /api/boards 一致） */
export const GET = route(async (request: Request) => {
  const query = new URL(request.url).searchParams.get("q");
  return ok({ ...searchBoards(query) });
});
