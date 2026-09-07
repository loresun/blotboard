/**
 * HTML 排版导出的共享工具（从 lib/export-html.ts 拆出）。
 *
 * 单独成模块的理由与 normalize-base 相同：卡片包的 export.ts（cards/&lt;type&gt;/export.ts）
 * 与 export-html 主体都要用这些小函数，拆出来依赖才是无环的——
 * export-html → card-registry → cards/&lt;type&gt;/export → 这里。
 */
import { renderMarkdown, looksLikeMarkdown } from "./markdown";
import type { CardSpec } from "./card-spec-schema";
import type { BoardCard, BoardComment } from "./types";

/** 排版导出里一张卡的渲染上下文。 */
export interface ExportHtmlCtx {
  specs: Map<string, CardSpec>;
  /** 预取好的内联资源：`upload:<id>` / `book:<id>` → data URI */
  assets: Map<string, string>;
  origin: string;
  aidocsBase: string;
  commentsByCard: Map<string, BoardComment[]>;
  /** 这次导出的全部卡片：需要「看别的卡」的包用它（分组框要数出框里有几张） */
  cards: BoardCard[];
  /** 正文渲染时回填：这些卡里的图太宽，摆进网格得占满一行 */
  wide: Set<string>;
}

export function escapeHtml(text: string): string {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** 纯文本按段落摊开：保留换行（随手写的东西里，空行本身就是格式） */
export function plain(text: string): string {
  return `<p class="pre">${escapeHtml(text)}</p>`;
}

/** 正文：写了 Markdown 就排版，没写就保留换行。判断口径与画板上一致 */
export function body(text: string): string {
  const source = String(text || "").trim();
  if (!source) return "";
  return looksLikeMarkdown(source) ? `<div class="md">${renderMarkdown(source)}</div>` : plain(source);
}

export function chip(text: string, className = ""): string {
  return text ? `<span class="chip${className ? ` ${className}` : ""}">${escapeHtml(text)}</span>` : "";
}

/** 只让普通链接进产物：外部内容里的 javascript: 之类一律降级成纯文字 */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:)/i;

export function link(url: string | undefined, text?: string): string {
  const href = String(url || "");
  const label = escapeHtml(text || href);
  if (!href) return "";
  if (!SAFE_HREF.test(href)) return label;
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

export function stamp(ms?: number | null): string {
  if (!ms) return "";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

/**
 * 兄弟服务的地址跟着「用户从哪进来的」走（与前端 lib/origins.ts 同一条规则，
 * 只是这里没有 window，host 由调用方从请求里取）。
 * 配置本身就指向别的机器时不动——那是有意为之的跨机部署。
 */
export function followHost(configured: string, origin: string): string {
  if (!origin) return configured;
  try {
    const target = new URL(configured);
    if (!LOOPBACK.has(target.hostname)) return configured;
    const here = new URL(origin).hostname;
    if (!here || LOOPBACK.has(here)) return configured;
    target.hostname = here;
    return target.origin;
  } catch {
    return configured;
  }
}

/**
 * 宽图要占满一行。
 * 一张 1300px 宽的流程图塞进 330px 的格子里，缩完谁也看不清——
 * 这是「服务端算版式」最该管的事：它在服务端就知道图有多宽。
 */
export const WIDE_AT = 620;

export function svgWidth(source: string): number {
  // 只认根 <svg> 标签上的尺寸：整份源码里搜 width= 会先撞上内层的 <rect width="80">，
  // 于是一张 1400 宽的图被当成 80 宽，塞进最窄的格子里
  const root = /<svg\b[^>]*>/i.exec(source);
  if (!root) return 0;
  const width = /\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(root[0]);
  if (width) return Number(width[1]) || 0;
  const viewBox = /\bviewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)/i.exec(root[0]);
  return viewBox ? Number(viewBox[1]) || 0 : 0;
}
