import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { boardSummary, createBoard, listBoards } from "@/lib/board-service";

export const dynamic = "force-dynamic";

/**
 * 侧栏 / 导航的全量画板清单。
 *
 * 列表体积随板数线性涨（几百块板 ≈ 200 KB），而前端每分钟 poll 一次、每次写板后还会重拉
 * （lib/store.ts 的 pollOnce / BOARD_WRITE_ACTIONS）——不加协商缓存的话这些字节一遍遍过网再
 * 一遍遍 JSON.parse。ETag 取「板数 + 最大 updatedAt」：写路径一律 bump updatedAt
 * （board-service 的写函数与 state/whole 同步口都是 `updatedAt = Date.now()`），
 * 列表里任何字段的变化必然伴随它变化，不会漏报更新。
 *
 * 用 weak ETag（W/ 前缀）：route() 出口会对 200 做 gzip，同一 ETag 对应 identity / gzip
 * 两种字节表示，按规范该用弱比较。`no-cache` 而非 `max-age`：允许浏览器存，但每次用前必须
 * 回源验证——没有 staleness 窗口，304 时省掉的是整份 body 的传输与解析。
 */
export const GET = route(async (request: Request) => {
  const boards = listBoards();
  let latest = 0;
  for (const board of boards) if ((board.updatedAt || 0) > latest) latest = board.updatedAt || 0;
  const etag = `W/"${boards.length}-${latest.toString(36)}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } });
  }
  return new Response(JSON.stringify({ ok: true, boards }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-cache", etag },
  });
});

export const POST = route(async (request: Request) => {
  assertCanWrite(request);
  const body = await readJson(request);
  return ok({ board: boardSummary(createBoard(body.name, { parentId: body.parentId, group: body.group })) }, 201);
});
