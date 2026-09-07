import { badRequest, ok, requestOrigin, route } from "@/lib/http";
import { bundleFilename, type BundleVolume } from "@/lib/board-bundle";
import { boardVolumeSlice, buildBoardBundle, planBoardVolumes, selectBoards } from "@/lib/board-transfer";
import { exportBoardMarkdown } from "@/lib/board-service";
import { renderBoardsHtml } from "@/lib/export-html";
import type { Board } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * **一批画板**的导出（单块板仍走 `/api/boards/{id}/export`，两条路产物同源）。
 *
 * 挑板三选一：`ids=b_a,b_b` / `group=项目名`（整个分组）/ `all=1`（整个库）；
 * 默认把子画板与被 board 卡指到的板一起带上（`children=0` 关掉）——不带走的话，
 * 对端点开子画板卡就是死链。
 *
 *  · `format=json`（默认）**画板包**：板 + 卡 + 线 + 评论 + 附件字节（base64，
 *    总量超 24 MB 的部分只留引用）。`assets=0` 只要结构不要附件；
 *    `download=1` 直接当文件下载（大库不必在浏览器内存里再过一手）。
 *    原样 POST 到 `/api/boards/import` 就能在另一台机器上立起来。
 *  · `format=html` 一份自包含的单文件 HTML，**末尾带着同一份画板包**——
 *    所以「发给别人看的那份文件」也就是「别人能导进自己画板的那份文件」。
 *  · `format=md` 每块板一段 Markdown，中间用 `---` 分隔（喂给 agent 当上下文）。
 *
 * **超过单包上限就分卷，不截断**（三种格式同一条口径）：
 *  · `plan=1` 先问「这次要几卷」，返回每一卷的板数与取回地址，不真的打包；
 *  · `volume=N` 取第 N 卷，产物是一份**完整可导入**的画板包，卷号写在 `bundle.volume` 里；
 *  · 不给 `volume` 而这批板又装不下时**回 413 并附上整个分卷计划**——
 *    以前这里是攒够 200 块就停、HTTP 照样 200，用户拿到的是一份看着成功的残缺备份。
 */
export const GET = route(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const ids = (params.get("ids") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const group = params.get("group");
  const selected = selectBoards({
    ids,
    group: group === null ? null : group,
    all: params.get("all") === "1",
    children: params.get("children") !== "0",
  });
  const format = params.get("format") || "json";
  if (format !== "json" && format !== "html" && format !== "md") throw badRequest("format 只能是 json / html / md");

  const plan = planBoardVolumes(selected.length);
  /** 取回第 N 卷的地址：原样保留本次的挑板与格式参数，只换 volume */
  const volumeUrl = (index: number): string => {
    const next = new URLSearchParams(params);
    next.delete("plan");
    next.set("volume", String(index));
    return `/api/boards/export?${next.toString()}`;
  };
  const planPayload = {
    total: plan.total,
    limit: plan.limit,
    volumes: plan.volumes,
    slices: plan.slices.map((slice) => ({ ...slice, url: volumeUrl(slice.index) })),
  };

  if (params.get("plan") === "1") return ok({ plan: planPayload });

  const rawVolume = params.get("volume");
  let boards: Board[] = selected;
  let volume: BundleVolume | undefined;
  if (rawVolume !== null) {
    const index = Number(rawVolume);
    boards = boardVolumeSlice(selected, index);
    volume = { index, total: plan.volumes, totalBoards: plan.total };
  } else if (plan.volumes > 1) {
    // 装不下就当场说清楚：总数、每卷装多少、每一卷去哪儿取。**绝不给半份**。
    return new Response(
      JSON.stringify({
        ok: false,
        error:
          `这次要导 ${plan.total} 块画板，超过单份包的上限（${plan.limit} 块），一份装不下。` +
          `请分 ${plan.volumes} 卷取：给同一个地址加 volume=1…${plan.volumes}，每一卷都是完整可导入的包，` +
          "逐卷导入即可还原整套（先 plan=1 可以只看计划不打包）。",
        plan: planPayload,
      }),
      { status: 413, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
    );
  }

  const filename = `${bundleFilename(boards)}${volume && volume.total > 1 ? `-第${volume.index}卷共${volume.total}卷` : ""}`;

  if (format === "html") {
    const html = await renderBoardsHtml(boards, {
      comments: params.get("comments") === "1",
      origin: requestOrigin(request),
      // 图片字节已经在正文里（`<img data-asset>`），载荷里不再存第二份
      payload:
        params.get("data") === "0"
          ? null
          : (visible) => buildBoardBundle(visible, { assets: false, ...(volume ? { volume } : {}) }),
    });
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `${params.get("inline") === "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(`${filename}.html`)}`,
        "cache-control": "no-store",
      },
    });
  }

  if (format === "md") {
    const markdown = boards.map((board) => exportBoardMarkdown(board.id)).join("\n\n---\n\n");
    return new Response(markdown, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.md`)}`,
        "cache-control": "no-store",
      },
    });
  }

  const bundle = buildBoardBundle(boards, {
    assets: params.get("assets") !== "0",
    origin: requestOrigin(request),
    ...(volume ? { volume } : {}),
  });
  if (params.get("download") === "1") {
    return new Response(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.blotboard.json`)}`,
        "cache-control": "no-store",
      },
    });
  }
  return ok({ bundle } as unknown as Record<string, unknown>);
});
