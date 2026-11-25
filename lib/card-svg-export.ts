"use client";

/**
 * 把一张卡的矢量图导出成 .svg 文件。
 *
 * 为什么单独一个文件：画板上的 SVG 卡是 `<img src="data:image/svg+xml,…">` 渲染的，
 * 页面上能看，但拿不到源文件——想放大读、想丢进设计工具改、想交给别人复用都做不到。
 * 这里把「取源码 → 拼文件名 → 触发下载」收成一处，右键菜单与阅读模式共用。
 *
 * 支持三类卡：
 *  · svg      —— 直接就是源码，原样导出（服务端已做过一次消毒，见 normalizeSvgField）
 *  · mermaid  —— 前端用同一个 mermaid 实例渲成 SVG 再导出（与卡面同主题，不会出现第二套配色）
 *  · chart    —— 先按 cards/chart/source 的规则把数据翻成 mermaid，再走上面那条
 */
import type { BoardCard } from "./types";
import { chartToMermaid } from "@/cards/chart/source";

export type SvgExportable =
  | { kind: "svg"; source: string }
  | { kind: "mermaid"; source: string };

/** 这张卡能不能导出 SVG；不能则给出原因，菜单据此置灰。 */
export function svgExportSource(card: BoardCard): { ok: true; value: SvgExportable } | { ok: false; reason: "unsupported" | "empty" } {
  if (card.type === "svg") {
    const source = (card.svg?.source || "").trim();
    return source ? { ok: true, value: { kind: "svg", source } } : { ok: false, reason: "empty" };
  }
  if (card.type === "mermaid") {
    const source = (card.mermaid?.source || "").trim();
    return source ? { ok: true, value: { kind: "mermaid", source } } : { ok: false, reason: "empty" };
  }
  if (card.type === "chart") {
    // 数据不完整时 chartToMermaid 返回空串（见 cards/chart/source.ts），与「还没填」同档处理
    const source = chartToMermaid(card.chart).trim();
    return source ? { ok: true, value: { kind: "mermaid", source } } : { ok: false, reason: "empty" };
  }
  return { ok: false, reason: "unsupported" };
}

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;

/** 与卡面同参数初始化：导出出来的图跟屏幕上看到的是同一套主题与字体。 */
function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        fontFamily: "inherit",
      });
      return mermaid;
    });
  }
  return mermaidReady;
}

async function renderMermaidSvg(source: string): Promise<string> {
  const mermaid = await loadMermaid();
  // id 必须每次不同：mermaid 会在页面里按 id 建临时节点，重名会把上一次的图顶掉
  const { svg } = await mermaid.render(`card-svg-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, source);
  return svg;
}

function safeFilename(card: BoardCard, ext: string): string {
  const raw = (card.title || "").trim() || `${card.type}-${card.id.slice(0, 8)}`;
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim() || "card";
  // 按码点截：标题里有 emoji 时不要从代理对中间劈开
  return `${[...cleaned].slice(0, 60).join("")}.${ext}`;
}

function triggerDownload(filename: string, text: string): void {
  const blob = new Blob([text], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 导出并下载。
 * 抛错由调用方转成 toast——这里不吞异常，否则「按了没反应」最难查。
 */
export async function downloadCardSvg(card: BoardCard): Promise<void> {
  const picked = svgExportSource(card);
  if (!picked.ok) {
    throw new Error(picked.reason === "empty" ? "这张卡还没有内容，先填图再导出" : "这张卡不是矢量图，没有可导出的 SVG");
  }
  const svg = picked.value.kind === "svg" ? picked.value.source : await renderMermaidSvg(picked.value.source);
  triggerDownload(safeFilename(card, "svg"), svg);
}
