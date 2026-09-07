import { ok, route } from "@/lib/http";
import { cardIndex } from "@/lib/board-service";
import { BOARD_CARD_TYPES, type CardType } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * 跨画板卡片索引（卡片导航页 /nav 的数据源）。
 * 必须排在 /api/boards/[boardId] 之前——Next 静态段优先于动态段，天然满足。
 */
export const GET = route(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const types = (params.get("types") || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is CardType => (BOARD_CARD_TYPES as readonly string[]).includes(item));
  const result = cardIndex({
    // 带了 group 参数才收窄；`?group=` 空串是「未分组那一撮」，跟不带是两回事
    group: params.has("group") ? params.get("group") || "" : null,
    boardId: params.get("board"),
    query: params.get("q") || "",
    types,
    sort: params.get("sort") === "created" ? "created" : "updated",
    order: params.get("order") === "asc" ? "asc" : "desc",
    limit: params.has("limit") ? Number(params.get("limit")) : undefined,
    offset: params.has("offset") ? Number(params.get("offset")) : undefined,
  });
  return ok({ ...result });
});
