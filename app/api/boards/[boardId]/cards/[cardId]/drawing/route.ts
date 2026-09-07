import { createHash } from "node:crypto";
import { assertBoardId } from "@/lib/board-schema";
import { getBoard } from "@/lib/board-service";
import { renderExcalidrawSvg } from "@/lib/excalidraw-svg";
import { badRequest, notFound, route } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string; cardId: string }> };

/**
 * 手绘卡的卡面图：服务端把 `.excalidraw` 场景渲成 SVG（跟排版导出同一支笔，
 * 见 lib/excalidraw-svg.ts）。
 *
 * 为什么不在浏览器里画：卡面原来是现场 import 官方 Excalidraw（约 345 KB）
 * 再 exportToBlob 出 PNG。一块 76 张手绘卡的板因此每次打开都要多下 345 KB、
 * 主线程再堵三百多毫秒——而这些卡九成没进过编辑器、连缩略图都没有，
 * 等于每个人每次开板都替 agent 重画一遍。服务端出图：库不进浏览器、
 * 渲染不占主线程，图还进浏览器缓存，第二次开板零成本。
 *
 * 走 route() 是为了蹭同一个出口的 gzip（SVG 是文本，压完只剩一成多）。
 */
export const GET = route(async (request: Request, ctx: Ctx) => {
  const { boardId, cardId } = await ctx.params;
  const board = getBoard(assertBoardId(boardId));
  const card = board.cards.find((item) => item.id === cardId);
  if (!card) throw notFound("卡片不存在");
  if (card.type !== "excalidraw") throw badRequest("这张卡不是 Excalidraw 卡");
  const source = card.excalidraw?.source || "";
  if (!source) throw notFound("这张卡上没有 Excalidraw 场景");

  // ETag 按源码算：画改没改一比就知道，跟这块板别的卡怎么动无关
  const etag = `"exc-${createHash("sha1").update(source).digest("base64url").slice(0, 20)}"`;
  // URL 上带了版本号（正常路径，前端按 source 哈希拼）就能长缓存；
  // 没带的退回协商缓存，别让它把一张旧图永久钉在浏览器里
  const versioned = new URL(request.url).searchParams.has("v");
  const cacheControl = versioned ? "private, max-age=31536000, immutable" : "private, max-age=0, must-revalidate";
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": cacheControl } });
  }

  const secure = {
    // 图片上下文本来就不执行脚本，再钉一层：不猜类型、不给别的站点引
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  };

  const render = renderExcalidrawSvg(source, card.title || "");
  if (render.svg) {
    return new Response(render.svg, {
      status: 200,
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": cacheControl, etag, ...secure },
    });
  }

  // 这支笔画不出来的场景（典型是里面只有图片元素）：退回编辑器存过的那张 PNG。
  // 跟排版导出同一个优先级——那边也是「先现渲，渲不出来才用缩略图」。
  const stored = decodeDataUrl(card.excalidraw?.thumbnail || "");
  if (stored) {
    return new Response(new Uint8Array(stored.bytes), {
      status: 200,
      headers: {
        "content-type": stored.mediaType,
        "cache-control": cacheControl,
        etag,
        "content-length": String(stored.bytes.length),
        ...secure,
      },
    });
  }
  // 两条都不成才报错：<img> 读不到 body，前端只看得到「失败了」，然后退回占位
  throw badRequest(render.reason || "这张画渲染不出来");
});

/** data:image/png;base64,… → 字节。不是图片 dataURL 就返回 null。 */
function decodeDataUrl(value: string): { mediaType: string; bytes: Buffer } | null {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([\s\S]+)$/i.exec(value.trim());
  if (!match) return null;
  try {
    return { mediaType: match[1].toLowerCase(), bytes: Buffer.from(match[2], "base64") };
  } catch {
    return null;
  }
}
