"use client";

/**
 * PDF 排版设置：纸张 / 页边距 / 字号 / 分栏 / 要不要封面目录页码……
 *
 * 存在浏览器本地（localStorage），不进画板数据：这是「我这台机器打印时的习惯」，
 * 不是这块板的属性——同一块板发给别人，人家该用自己的纸张与字号。
 *
 * 口径与画布上的其它偏好一致（见 lib/store.ts 的 hydrateUiPrefs）：读不到就用默认值，
 * 存坏了也只是回到默认，不会把导出卡住。
 */

export type PaperSize = "A4" | "A3" | "Letter" | "Legal";
export type PdfOrientation = "portrait" | "landscape";
export type PdfMargin = "narrow" | "normal" | "wide";
export type PdfFontScale = "small" | "normal" | "large";
/** 导哪些卡：整块板 / 画布上筛选命中的 / 当前选中的 */
export type PdfScope = "all" | "filtered" | "selected";

export interface PdfSettings {
  paper: PaperSize;
  orientation: PdfOrientation;
  margin: PdfMargin;
  fontScale: PdfFontScale;
  /** 一页排几栏。卡片式内容分两栏很省纸，宽图 / 宽表会自动横跨整页 */
  columns: 1 | 2;
  /** 每张卡另起一页：做逐张过目的评审稿时用 */
  cardPerPage: boolean;
  cover: boolean;
  toc: boolean;
  /** 页脚印板名与页码（我们自己印，所以打印对话框里的页眉页脚可以关掉） */
  pageNumbers: boolean;
  /** 带上画板批注（与 HTML 导出的「评审版」同一个开关） */
  comments: boolean;
  /** 印不印图片。关掉只省墨，图注与卡片结构都还在 */
  images: boolean;
  /** 链接后面附上网址：印在纸上的链接点不动，网址得写出来才抄得到 */
  linkUrls: boolean;
  scope: PdfScope;
}

export const PDF_DEFAULTS: PdfSettings = {
  paper: "A4",
  orientation: "portrait",
  margin: "normal",
  fontScale: "normal",
  columns: 1,
  cardPerPage: false,
  cover: true,
  toc: true,
  pageNumbers: true,
  comments: false,
  images: true,
  linkUrls: false,
  scope: "all",
};

/** 纸张尺寸（mm，纵向）。横向在算版面时把宽高对调 */
export const PAPER_MM: Record<PaperSize, { w: number; h: number; label: string }> = {
  A4: { w: 210, h: 297, label: "A4" },
  A3: { w: 297, h: 420, label: "A3" },
  Letter: { w: 215.9, h: 279.4, label: "Letter" },
  Legal: { w: 215.9, h: 355.6, label: "Legal" },
};

export const MARGIN_MM: Record<PdfMargin, { value: number; label: string }> = {
  narrow: { value: 12, label: "窄" },
  normal: { value: 18, label: "标准" },
  wide: { value: 26, label: "宽" },
};

/** 正文基准字号（pt）。整份文档的字号都是从它按比例推的 */
export const FONT_PT: Record<PdfFontScale, { value: number; label: string }> = {
  small: { value: 9.2, label: "小" },
  normal: { value: 10.5, label: "标准" },
  large: { value: 12, label: "大" },
};

/** 一页的物理尺寸（mm），已经把横向的宽高对调算进去 */
export function pageSizeMm(settings: PdfSettings): { w: number; h: number } {
  const paper = PAPER_MM[settings.paper] || PAPER_MM.A4;
  return settings.orientation === "landscape" ? { w: paper.h, h: paper.w } : { w: paper.w, h: paper.h };
}

const LS_KEY = "blotboard_pdf";

/** 只认识表里的值：存坏了 / 版本换了都退回默认，不让一份坏配置把导出卡死 */
function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function loadPdfSettings(): PdfSettings {
  if (typeof window === "undefined") return { ...PDF_DEFAULTS };
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(window.localStorage.getItem(LS_KEY) || "{}") || {};
  } catch {
    /* 存坏了就用默认 */
  }
  return {
    paper: pick(raw.paper, ["A4", "A3", "Letter", "Legal"] as const, PDF_DEFAULTS.paper),
    orientation: pick(raw.orientation, ["portrait", "landscape"] as const, PDF_DEFAULTS.orientation),
    margin: pick(raw.margin, ["narrow", "normal", "wide"] as const, PDF_DEFAULTS.margin),
    fontScale: pick(raw.fontScale, ["small", "normal", "large"] as const, PDF_DEFAULTS.fontScale),
    columns: raw.columns === 2 ? 2 : 1,
    cardPerPage: raw.cardPerPage === true,
    cover: raw.cover !== false,
    toc: raw.toc !== false,
    pageNumbers: raw.pageNumbers !== false,
    comments: raw.comments === true,
    images: raw.images !== false,
    linkUrls: raw.linkUrls === true,
    scope: pick(raw.scope, ["all", "filtered", "selected"] as const, PDF_DEFAULTS.scope),
  };
}

export function savePdfSettings(settings: PdfSettings): void {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式下写不进去：这一次的设置照样生效，只是记不住 */
  }
}
