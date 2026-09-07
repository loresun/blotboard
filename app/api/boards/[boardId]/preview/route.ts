import { ok, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { boardPreview } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/**
 * 画板缩略：只给几何 + 颜色，不带任何正文。
 * 子画板卡要在别的板上画出目标板的样子，拉全量 JSON 太重（一块板可能几十上百张卡）。
 */
export const GET = route(async (_request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params;
  return ok(boardPreview(assertBoardId(boardId)));
});
