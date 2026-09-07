"use client";

/**
 * 导出。
 *
 * **排版导出（HTML）**由服务端从头到尾算好版式，前端只负责把文件取回来——
 * 这正是它替掉旧「阅读导出」的理由：以前那条路是在页面里搭一份 DOM 再走系统打印，
 * 版式受浏览器 / 缩放 / 字体 / 打印机驱动影响，同一块板换台机器印出来就变样。
 * JSON / Markdown 同样走服务端；只有 PNG 留在前端——它截的就是这块画布本身。
 */
import { getNodesBounds, getViewportForBounds, type Node } from "@xyflow/react";
import { api } from "./api-client";
import { bundleFilename } from "./board-bundle";
import { browserBoards } from "./browser-board-repository";
import { browserStorageActive } from "./storage-mode";
import type { CardType } from "./types";

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(name: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_");
  // 按码点截，不按 UTF-16 码元：板名里 emoji 不少（「📅 周报模板」这种），
  // 正好从一对代理项中间劈开的话，文件名末尾会多出个乱码方块
  const base = [...cleaned].slice(0, 40).join("").trim() || "board";
  return `${base}-${stamp}`;
}

export async function exportJson(boardId: string, boardName: string): Promise<void> {
  const board = await api.exportBoardJson(boardId);
  download(`${safeName(boardName)}.json`, new Blob([JSON.stringify(board, null, 2)], { type: "application/json" }));
}

/* ── 画板包：一块或多块板的整份搬运（lib/board-bundle.ts） ── */

/** 挑板：这三个给一个就行，口径与 `GET /api/boards/export` 一致 */
export interface BoardSelection {
  ids?: string[];
  group?: string;
  all?: boolean;
}

function selectionParams(selection: BoardSelection): URLSearchParams {
  const params = new URLSearchParams();
  if (selection.ids?.length) params.set("ids", selection.ids.join(","));
  else if (selection.group !== undefined) params.set("group", selection.group);
  else if (selection.all) params.set("all", "1");
  return params;
}

/** 一份包最多装多少块板：与服务端 BUNDLE_LIMITS.boards 同一个数（分卷的判据） */
const BUNDLE_BOARD_LIMIT = 200;

export interface BundleExportResult {
  /** 这次下了几个文件（超过单包上限就分卷，一卷一个文件） */
  files: number;
  /** 一共导了多少块板 */
  boards: number;
}

/**
 * 下载一份**画板包**（.blotboard.json）：板 + 卡 + 线 + 评论 + 附件字节。
 *
 * 服务端库走 `download=1` 让浏览器直接存文件——整库备份能有几十 MB，
 * 没必要先 fetch 成字符串在内存里过一手。浏览器库没有服务端，就地攒一份。
 *
 * **超过单包上限就分卷下载**：先问一次 `plan=1`（只回计划不打包），要几卷就下几个文件。
 * 以前这里只发一个请求，服务端攒够 200 块就停，用户得到一份看着成功的残缺备份——
 * 一个 723 块板的库备份下来只有 200 块，而且哪儿都没说。
 */
export async function exportBundle(selection: BoardSelection): Promise<BundleExportResult> {
  if (browserStorageActive()) {
    const bundle = await browserBoards.exportBundle(selection);
    const volumes = Math.max(1, Math.ceil(bundle.boards.length / BUNDLE_BOARD_LIMIT));
    for (let index = 1; index <= volumes; index += 1) {
      const boards = bundle.boards.slice((index - 1) * BUNDLE_BOARD_LIMIT, index * BUNDLE_BOARD_LIMIT);
      // 附件表跟着这一卷的板走：整套的 assets 全塞进每一卷等于把字节复制 N 份
      const wanted = new Set(boards.flatMap((board) => board.cards.map((card) => card.file?.uploadId).filter(Boolean)));
      const part =
        volumes === 1
          ? bundle
          : {
              ...bundle,
              volume: { index, total: volumes, totalBoards: bundle.boards.length },
              boards,
              assets: (bundle.assets || []).filter((asset) => wanted.has(asset.id)),
            };
      const suffix = volumes > 1 ? `-vol${index}of${volumes}` : "";
      download(
        `${bundleFilename(boards)}${suffix}.blotboard.json`,
        new Blob([JSON.stringify(part, null, 2)], { type: "application/json" }),
      );
    }
    return { files: volumes, boards: bundle.boards.length };
  }

  const params = selectionParams(selection);
  params.set("format", "json");
  const plan = await fetchVolumePlan(params);
  const volumes = Math.max(1, plan.volumes);
  for (let index = 1; index <= volumes; index += 1) {
    const one = new URLSearchParams(params);
    one.set("download", "1");
    if (volumes > 1) one.set("volume", String(index));
    const anchor = document.createElement("a");
    anchor.href = `/api/boards/export?${one.toString()}`;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // 连着点 N 个下载链接，浏览器会把后面的当成弹窗拦掉；隔一拍再点下一卷
    if (index < volumes) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return { files: volumes, boards: plan.total };
}

/** 先问一次「这次要几卷」。问不出来（老服务端 / 网络抖动）就当一卷，行为退回原来的样子。 */
async function fetchVolumePlan(params: URLSearchParams): Promise<{ volumes: number; total: number }> {
  const probe = new URLSearchParams(params);
  probe.set("plan", "1");
  try {
    const response = await fetch(`/api/boards/export?${probe.toString()}`, { headers: { "x-board-web": "1" } });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || `导出失败 ${response.status}`);
    return { volumes: Number(data.plan?.volumes) || 1, total: Number(data.plan?.total) || 0 };
  } catch {
    return { volumes: 1, total: 0 };
  }
}

/** 多块板的排版导出（一份 HTML 装一整个分组 / 一整个库）；产物同样带着可导回的载荷。 */
export function exportBoardsHtml(selection: BoardSelection, options: { inline?: boolean; comments?: boolean } = {}): void {
  const params = selectionParams(selection);
  params.set("format", "html");
  if (options.comments) params.set("comments", "1");
  if (options.inline) params.set("inline", "1");
  const anchor = document.createElement("a");
  anchor.href = `/api/boards/export?${params.toString()}`;
  anchor.rel = "noopener";
  if (options.inline) anchor.target = "_blank";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export interface ServerExportOptions {
  /** 带上画板批注，做「带评论的评审版」 */
  comments?: boolean;
  /** 在新标签页里先看一眼，不触发下载 */
  inline?: boolean;
  /** 只导筛选命中的那批：把画布上的搜索词与类型筛选原样带给服务端 */
  q?: string;
  types?: CardType[];
}

/** 服务端排版导出的地址 */
export function serverExportUrl(boardId: string, options: ServerExportOptions = {}): string {
  const params = new URLSearchParams({ format: "html" });
  if (options.comments) params.set("comments", "1");
  if (options.inline) params.set("inline", "1");
  if (options.q?.trim()) params.set("q", options.q.trim());
  if (options.types?.length) params.set("types", options.types.join(","));
  return `/api/boards/${encodeURIComponent(boardId)}/export?${params.toString()}`;
}

/**
 * 下载服务端排好版的单文件 HTML。
 *
 * 刻意不 fetch 成 blob 再存：一是大板的产物能到几十 MB，没必要在内存里过一手；
 * 二是文件名由服务端的 content-disposition 给——只有那边知道分组名与导出日期
 * （`WorkBuddy_培训_v2-04_出版实战案例库-2026-08-28.html`）。所以这里就是一次普通的下载。
 */
export function exportServerHtml(boardId: string, options: ServerExportOptions = {}): void {
  const anchor = document.createElement("a");
  anchor.href = serverExportUrl(boardId, options);
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function exportMarkdown(boardId: string, boardName: string): Promise<void> {
  const markdown = await api.exportBoardMarkdown(boardId);
  download(`${safeName(boardName)}.md`, new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
}

const PNG_MAX_SIDE = 4000;

/**
 * 导出 PNG：按全部节点的包围盒算一个能装下整块画板的视口，再把 viewport 元素截图。
 * 不是截当前屏——用户要的是整块板，不是他此刻正好看到的那一小块。
 */
export async function exportPng(nodes: Node[], boardName: string): Promise<void> {
  if (!nodes.length) throw new Error("画板还是空的");
  const viewportEl = document.querySelector<HTMLElement>(".react-flow__viewport");
  if (!viewportEl) throw new Error("画布还没就绪");

  const bounds = getNodesBounds(nodes);
  const padding = 48;
  const rawWidth = Math.ceil(bounds.width + padding * 2);
  const rawHeight = Math.ceil(bounds.height + padding * 2);
  const scale = Math.min(2, PNG_MAX_SIDE / Math.max(rawWidth, rawHeight, 1));
  const width = Math.ceil(rawWidth * Math.min(1, scale));
  const height = Math.ceil(rawHeight * Math.min(1, scale));
  const transform = getViewportForBounds(bounds, width, height, 0.05, 2, padding / Math.max(rawWidth, 1));

  // html-to-image 只有导出 PNG 用得到，没必要让每个人的首屏都为它买单
  const { toPng } = await import("html-to-image");
  const dataUrl = await toPng(viewportEl, {
    backgroundColor: "#f6f5f1",
    width,
    height,
    pixelRatio: 2,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
    },
    filter: (node) => {
      // 小地图 / 控件 / 手柄不进图
      const className = (node as HTMLElement)?.classList;
      if (!className) return true;
      return !(
        className.contains("react-flow__minimap") ||
        className.contains("react-flow__controls") ||
        className.contains("react-flow__resize-control") ||
        className.contains("react-flow__handle") ||
        // 评论气泡也不进图：它是工作中的批注，不是这块板要交出去的样子。
        // 何况气泡是按**当前屏幕**的 zoom 反向缩放的，而导出用的是另一套 transform，
        // 留着只会得到一堆大小不对的圆点
        className.contains("comment-pin") ||
        // 网页卡的 iframe：foreignObject 里本来就渲染不出跨源页面，留着只会让整张图的
        // 序列化多冒一次风险。卡片的边框与页脚（那个地址）还在，看得出这儿嵌的是什么
        className.contains("html-embed-frame")
      );
    },
  });

  const blob = await (await fetch(dataUrl)).blob();
  download(`${safeName(boardName)}.png`, blob);
}
