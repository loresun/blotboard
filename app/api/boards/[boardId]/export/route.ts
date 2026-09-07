import { ApiError, badRequest, ok, requestOrigin, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { exportBoardJson, exportBoardMarkdown, getBoard } from "@/lib/board-service";
import { buildBoardBundle, planBoardVolumes, selectBoards } from "@/lib/board-transfer";
import { exportEnvelope } from "@/lib/card-ingest";
import { renderBoardHtml } from "@/lib/export-html";
import { renderPrintDoc } from "@/lib/export-print";
import { BOARD_CARD_TYPES, type CardType } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string }> };

/** 文件名里能留的字：其余一律并成下划线（Windows / macOS 都收得下） */
function safePart(text: string): string {
  return String(text || "").replace(/[^\w一-龥-]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * 导出整块画板：
 *  · `format=html`  **服务端排好版的单文件 HTML**：离线可开、可直接打印成 A4 PDF。
 *                   版式由服务端算死（见 lib/export-html.ts），不受浏览器影响；
 *                   `&comments=1` 带上批注做评审版，`&inline=1` 在浏览器里直接看不下载，
 *                   `&q=` / `&types=` 只导筛选命中的那批（口径与画布上的筛选一致），
 *                   `&ids=c_a,c_b` 只导指名的这几张（画布上选中的那批，给了就不再看 q/types）
 *  · `format=print` **PDF 排版用的分块产物**（JSON）：同一份内容切成「不该被拆开的最小块」，
 *                   分页 / 纸张 / 页边距 / 页码交给浏览器那侧算（lib/export-pdf.ts）——
 *                   高度只有真排过版才知道，服务端硬算只会把卡片劈成两半。
 *                   参数与 html 完全一致（`&comments=1` / `&q=` / `&types=`）
 *  · `format=json`  本服务的内部结构，改完能 PUT 回 /whole
 *  · `format=md`    给人看 / 贴给 agent
 *  · `format=cards` **卡片信封**（交换格式）——别人不用懂 blotboard 的卡片模型也能读，
 *                   也能原样 POST 到另一台机器的 /ingest 上；`&only=data` 只导规格卡
 *  · `format=bundle` **画板包**：这块板的全部（含评论与附件字节），
 *                   POST 到另一台机器的 /api/boards/import 就立起来了；
 *                   `&children=1` 连子画板与被 board 卡指到的板一起带走。
 *                   要一次导多块板走 `/api/boards/export?ids=…`（同一种产物）
 */
export const GET = route(async (request: Request, ctx: Ctx) => {
  const { boardId } = await ctx.params;
  const id = assertBoardId(boardId);
  const params = new URL(request.url).searchParams;
  const raw = params.get("format");
  // PNG 是画布截图，只有浏览器里才截得出来，这个接口给不了。
  // 以前它会默默按 json 处理——调用方拿到一份 JSON 还以为是图，不如直接说清楚。
  if (raw === "png") {
    throw badRequest("PNG 是画布截图，服务端出不了：页面上用顶栏「导出 PNG」，批量用 scripts/export-png.mjs");
  }
  const format =
    raw === "md"
      ? "md"
      : raw === "cards"
        ? "cards"
        : raw === "html"
          ? "html"
          : raw === "print"
            ? "print"
            : raw === "bundle"
              ? "bundle"
              : "json";
  const board = getBoard(id);
  const stamp = new Date().toISOString().slice(0, 10);
  // 文件名带上分组：一个画板组导出七份，光看板名分不清是哪个项目的
  const filename =
    `${[safePart(board.group || ""), safePart(board.name)].filter(Boolean).join("-").slice(0, 60) || "board"}-${stamp}`;

  if (format === "html" || format === "print") {
    const types = (params.get("types") || "")
      .split(",")
      .map((type) => type.trim())
      .filter((type): type is CardType => (BOARD_CARD_TYPES as readonly string[]).includes(type));
    // ids：只导这几张（画布上选中的那批）。与 q/types 是两条口径，给了就只认它
    const ids = (params.get("ids") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const shared = {
      comments: params.get("comments") === "1",
      origin: requestOrigin(request),
      filter: { q: params.get("q") || "", types, ids },
    };
    if (format === "print") {
      const doc = await renderPrintDoc(board, shared);
      return ok({ doc: { ...doc, filename } } as unknown as Record<string, unknown>);
    }
    // 产物末尾带一份画板包：发出去给人看的那份文件，同时也是别人能导回自己画板的那份
    const html = await renderBoardHtml(board, {
      ...shared,
      payload: params.get("data") === "0" ? null : (visible) => buildBoardBundle(visible, { assets: false }),
    });
    // inline：在新标签页里先看一眼再决定要不要存（同源、同一份产物，只是不触发下载）
    const disposition = params.get("inline") === "1" ? "inline" : "attachment";
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(`${filename}.html`)}`,
        "cache-control": "no-store",
      },
    });
  }

  if (format === "md") {
    return new Response(exportBoardMarkdown(id), {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.md`)}`,
        "cache-control": "no-store",
      },
    });
  }
  if (format === "bundle") {
    const boards = params.get("children") === "1" ? selectBoards({ ids: [id], children: true }) : [board];
    // 一块板带上整棵子树也可能超过单包上限：那时候把人指到会分卷的批量口，
    // 而不是在这里悄悄截断（跟 /api/boards/export 同一条口径）
    const plan = planBoardVolumes(boards.length);
    if (plan.volumes > 1) {
      throw new ApiError(
        `这块板连同子画板一共 ${plan.total} 块，超过单份包的上限（${plan.limit} 块）。` +
          `请走会分卷的批量口：GET /api/boards/export?ids=${id}&format=json&volume=1…${plan.volumes}` +
          "（先加 plan=1 只看计划不打包）",
        413,
      );
    }
    return ok({
      bundle: buildBoardBundle(boards, {
        assets: params.get("assets") !== "0",
        origin: requestOrigin(request),
      }),
    } as unknown as Record<string, unknown>);
  }
  if (format === "cards") {
    return ok({ envelope: exportEnvelope(board, { onlyData: params.get("only") === "data" }) });
  }
  return ok({ board: exportBoardJson(id) });
});
