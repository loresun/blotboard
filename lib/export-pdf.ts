"use client";

/**
 * PDF：**排版与分页在浏览器这一侧做**，产物是一份真正分好页的文档，再交给系统打印
 * （打印对话框里选「另存为 PDF」）。
 *
 * 为什么是这条路：
 *
 *  · **保住链接与文字**。要在浏览器里直接吐一个 .pdf 文件，现实里只有「把每页截成图
 *    再塞进 PDF」这一种做法——那样得到的是一叠图片：链接点不动、文字选不中、搜不了、
 *    体积还大好几倍。而走系统打印，Chrome 自己就是排版引擎，输出的是矢量文字 +
 *    真链接注解 + 原图，一份 20 页的板子几百 KB。用户明确要「保留链接、图片」，
 *    那就只能走这条。
 *  · **分页必须在这里算**。一块要占多高，只有真排过版才知道（字体、换行、图的实际尺寸）。
 *    服务端没有排版引擎，估错就是把一张卡劈成两半。所以服务端只切块
 *    （lib/export-print.ts），这里量完再装页。
 *  · **版面是我们自己的**，不是「浏览器拿屏幕样式凑合印」：纸张、页边距、分栏、
 *    每页页脚与页码、带真实页码的目录，全在这份文件里定死。同一份设置在哪台机器上
 *    印出来页数都一样。
 *
 * 分页算法就一句话：**往一页里塞，塞不下就退回来另起一页**。不预估高度、不按字数猜，
 * 每塞一块问一次浏览器「溢出没有」——因为浏览器才是那个知道答案的人。
 */
import { api } from "./api-client";
import type { PrintBlock, PrintDoc } from "./export-print";
import {
  FONT_PT,
  MARGIN_MM,
  pageSizeMm,
  type PdfSettings,
} from "./pdf-settings";

export type { PrintDoc };

/** 一页：装了哪几块 + 它实际会吃掉几张纸 */
interface PageSpec {
  blocks: PrintBlock[];
  /**
   * 单块比一整页还高（超长的正文卡）时，这一页不锁高度，让内容自己往下流。
   * 这种页会吃掉不止一张纸，`span` 是量出来的估计张数——目录页码要跟着它走。
   */
  flow: boolean;
  span: number;
}

export interface PdfBuildResult {
  html: string;
  /** 总页数（封面 + 目录 + 正文，flow 页按实际张数计） */
  pageCount: number;
  /** 正文块数，给「正在排版 12 / 130」这种进度用 */
  blockCount: number;
}

/* ── 版面样式：这份文件里唯一决定「印出来长什么样」的地方 ── */

function pageCss(settings: PdfSettings, size: { w: number; h: number }): string {
  const margin = MARGIN_MM[settings.margin].value;
  const pt = FONT_PT[settings.fontScale].value;
  // 纸张高度上留 0.4mm 余量：整数毫米算下来偶尔会差半个像素，差一点就会多吐一张空白纸
  const sheetH = (size.h - 0.4).toFixed(2);
  return `
@page{size:${size.w}mm ${size.h}mm;margin:0}
html,body{margin:0;padding:0;background:#fff}
body{font-size:${pt}pt}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}

.sheet{
  box-sizing:border-box;position:relative;overflow:hidden;
  width:${size.w}mm;height:${sheetH}mm;padding:${margin}mm;
  display:flex;flex-direction:column;background:#fff;
  break-after:page;page-break-after:always;
}
.sheet:last-child{break-after:auto;page-break-after:auto}
/* 超长的一块：不锁高度，让它自己往下流（宁可多吃一张纸，也不能把内容裁掉） */
.sheet.flow{height:auto;min-height:${sheetH}mm;overflow:visible}
.page-body{flex:1 1 auto;min-height:0;overflow:hidden}
.sheet.flow .page-body{overflow:visible}
/* 字号：内容样式（与 HTML 导出共用那份）里的字号全是 px，改 body 的 pt 推不动它们，
   所以整段内容按倍率缩放。zoom 参与布局，所以量出来的高度就是印出来的高度 */
.page-flow{zoom:${(pt / FONT_PT.normal.value).toFixed(4)};${settings.columns === 2 ? "column-count:2;column-gap:7mm;" : ""}}
.blk{break-inside:avoid;page-break-inside:avoid;margin:0 0 4mm}
.blk:last-child{margin-bottom:0}
.blk.wide{column-span:all}
.sheet.flow .blk{break-inside:auto;page-break-inside:auto}
.sheet.flow .blk .card{break-inside:auto;page-break-inside:auto}

.page-foot{
  flex:none;display:flex;justify-content:space-between;align-items:baseline;gap:10px;
  margin-top:4mm;padding-top:2.5mm;border-top:1px solid #e5e1d8;
  font-size:.72em;color:#918c81;
}
.page-foot .pf-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.page-foot .pf-no{flex:none;font-variant-numeric:tabular-nums}

/* 屏幕版式里的东西在这里一概不作数：这份文档没有侧栏、没有网格、没有进度条 */
.doc{display:block}
.sec{padding-top:0}
.sec-head{margin-bottom:3mm;break-after:avoid;page-break-after:avoid}
.grid{display:block}
.card{margin:0;break-inside:avoid;page-break-inside:avoid}
.sec-intro .card{background:#fbfaf7}

/* ── 封面 ── */
.pdf-cover{flex:1;display:flex;flex-direction:column;justify-content:center}
.pdf-cover-kicker{margin:0 0 12px;font-size:.8em;letter-spacing:.14em;color:#918c81;text-transform:uppercase}
.pdf-cover h1{margin:0;font-size:2.6em;line-height:1.28;letter-spacing:-.01em}
.pdf-cover-group{margin:10px 0 0;font-size:1.05em;color:#6f6b62}
.pdf-cover-rule{margin:22px 0;height:2px;background:#25242119}
.pdf-cover-stats{margin:0;font-size:.95em;color:#6f6b62;line-height:2}
.pdf-cover-stats b{color:#242320;font-variant-numeric:tabular-nums}
.pdf-cover-note{margin:14px 0 0;padding:7px 11px;border-left:3px solid #e2c98d;background:#fdf8ee;font-size:.82em;color:#6f6b62}
.pdf-cover-meta{margin:18px 0 0;font-size:.74em;color:#918c81;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

/* ── 目录：右边那一列是真页码，不是装饰 ── */
.pdf-toc-title{margin:0 0 4mm;padding-bottom:2.5mm;border-bottom:2px solid #e5e1d8;font-size:1.5em}
ul.pdf-toc{list-style:none;margin:0;padding:0;font-size:.9em}
ul.pdf-toc li{display:flex;align-items:baseline;gap:6px;padding:1.6mm 0;border-bottom:1px dotted #e5e1d8}
ul.pdf-toc li.lv1{padding-left:7mm;border-bottom-color:#f0ede6}
ul.pdf-toc .tn{flex:none;min-width:2.2em;color:#918c81;font-variant-numeric:tabular-nums;font-size:.9em}
ul.pdf-toc .tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#242320}
ul.pdf-toc li.lv0 .tt{font-weight:700}
ul.pdf-toc .tp{flex:none;color:#6f6b62;font-variant-numeric:tabular-nums}
ul.pdf-toc a{color:inherit;text-decoration:none}
${settings.images ? "" : "/* 省墨：图不印，图注与卡片结构照旧 */\n.card-body img,.figure img,.book-cover{display:none}\n"}
${
  settings.linkUrls
    ? `/* 印在纸上的链接点不动，把网址跟在后面才抄得到 */
.card-body a[href^="http"]::after{content:" ⟨" attr(href) "⟩";font-size:.82em;color:#918c81;word-break:break-all}
`
    : ""
}`;
}

/* ── 量与装：把块塞进页 ─────────────────────────── */

/** 隐藏的测量画布。同源 iframe，样式与最终产物**逐字节相同**，量出来才作数。 */
async function openFrame(html: string): Promise<{ frame: HTMLIFrameElement; doc: Document }> {
  const frame = document.createElement("iframe");
  // 不能用 display:none：不参与布局就量不出高度。挪到屏幕外，尺寸给足
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:2000px;border:0;visibility:hidden";
  frame.srcdoc = html;
  document.body.appendChild(frame);
  await new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
  });
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    throw new Error("排版用的隐藏画布没起来");
  }
  // 字体没就位就量，行高会在字体换上之后变——量出来的页数就是错的
  try {
    await (doc as Document & { fonts?: FontFaceSet }).fonts?.ready;
  } catch {
    /* 老浏览器没有 fonts，跳过 */
  }
  return { frame, doc };
}

/**
 * 等图片解码的总预算。
 *
 * 为什么需要它：`img.decode()` 在**不被渲染的文档里可能永远不 resolve**（标签页在后台、
 * 窗口最小化、宿主把这一片藏起来……）。没有闸门的话，导出就停在「正在排版…」上，
 * 既不报错也没有出口——比排得难看糟糕得多。所以：单批等不过 `BATCH_MS` 就放弃这一批，
 * 整轮累计超过 `TOTAL_MS` 就此后一张都不等，拿浏览器当下给的尺寸接着排。
 */
const IMAGE_BATCH_MS = 2500;
const IMAGE_TOTAL_MS = 12_000;

interface ImageBudget {
  until: number;
  gaveUp: boolean;
}

function newImageBudget(): ImageBudget {
  return { until: Date.now() + IMAGE_TOTAL_MS, gaveUp: false };
}

/** 等这一批节点里的图片真的解出来：图没解码时 offsetHeight 是 0，量了也白量 */
async function settleImages(nodes: Element[], budget: ImageBudget): Promise<void> {
  if (budget.gaveUp) return;
  const images: HTMLImageElement[] = [];
  for (const node of nodes) {
    if (node instanceof HTMLImageElement) images.push(node);
    node.querySelectorAll?.("img").forEach((img) => images.push(img as HTMLImageElement));
  }
  const pending = images.filter((img) => !(img.complete && img.naturalHeight));
  if (!pending.length) return;
  if (Date.now() >= budget.until) {
    budget.gaveUp = true;
    return;
  }
  let timer = 0;
  const settled = Promise.all(pending.map((img) => img.decode().catch(() => undefined)));
  const bail = new Promise<void>((resolve) => {
    timer = window.setTimeout(() => {
      // 这一批没在预算内解出来：多半是文档整个没在渲染，再等下去也不会有结果
      budget.gaveUp = true;
      resolve();
    }, Math.min(IMAGE_BATCH_MS, Math.max(0, budget.until - Date.now())));
  });
  await Promise.race([settled, bail]);
  window.clearTimeout(timer);
}

/**
 * 装不下了没有。
 *
 * 量的是内容块的**视觉高度**（getBoundingClientRect，已经把 zoom 算进去），
 * 比的是这一页的可用高度。不用 scrollHeight：内容被 zoom 缩放过，
 * 各家浏览器对「缩放后的 scrollHeight 报哪个坐标系」并不一致，rect 则一定是视口 px。
 * 分栏时也是这一条——分栏容器不锁高度，内容多了它自己就变高。
 */
function overflowed(host: HTMLElement, body: HTMLElement): boolean {
  return host.getBoundingClientRect().height > body.clientHeight + 1;
}

function blockNode(doc: Document, block: PrintBlock): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.className = `blk blk-${block.kind}${block.wide ? " wide" : ""}`;
  // 卡片的锚点在它自己的 <article id> 上；节标题这类没有，锚点挂在外层
  if (block.kind !== "card") wrap.id = block.anchor;
  wrap.innerHTML = block.html;
  return wrap;
}

/**
 * 分组：节标题不能孤零零留在页尾，必须和后面第一块一起走。
 * 「每张卡另起一页」时不并组——那本来就是一页一块。
 */
function groupBlocks(blocks: PrintBlock[], cardPerPage: boolean): PrintBlock[][] {
  const groups: PrintBlock[][] = [];
  for (let at = 0; at < blocks.length; at += 1) {
    const block = blocks[at];
    if (!cardPerPage && block.keepWithNext && blocks[at + 1]) {
      groups.push([block, blocks[at + 1]]);
      at += 1;
      continue;
    }
    groups.push([block]);
  }
  return groups;
}

async function paginate(
  doc: Document,
  blocks: PrintBlock[],
  settings: PdfSettings,
  onProgress?: (done: number, total: number) => void,
): Promise<PageSpec[]> {
  const host = doc.querySelector<HTMLElement>("#probe-body .page-flow");
  const body = doc.querySelector<HTMLElement>("#probe-body .page-body");
  if (!host || !body) throw new Error("排版用的隐藏画布没就绪");

  const pages: PageSpec[] = [];
  let current: PrintBlock[] = [];
  const flush = (flow = false, span = 1) => {
    if (!current.length) return;
    pages.push({ blocks: current, flow, span });
    current = [];
    host.innerHTML = "";
  };

  const groups = groupBlocks(blocks, settings.cardPerPage);
  const budget = newImageBudget();
  let done = 0;
  for (const group of groups) {
    const place = async () => {
      const nodes = group.map((block) => blockNode(doc, block));
      nodes.forEach((node) => host.appendChild(node));
      await settleImages(nodes, budget);
      return nodes;
    };

    let nodes = await place();
    if (overflowed(host, body)) {
      if (current.length) {
        // 这一页装不下了：整组退回来，另起一页再试
        nodes.forEach((node) => node.remove());
        flush();
        nodes = await place();
      }
      if (overflowed(host, body)) {
        // 空页都装不下 = 这一块本身比一整页还高。让它自己流，顺手量一下要几张纸
        const span = Math.max(1, Math.ceil(host.getBoundingClientRect().height / Math.max(body.clientHeight, 1)));
        current.push(...group);
        flush(true, span);
        done += group.length;
        onProgress?.(done, blocks.length);
        continue;
      }
    }
    current.push(...group);
    done += group.length;
    onProgress?.(done, blocks.length);
    if (settings.cardPerPage) flush();
  }
  flush();
  return pages;
}

/* ── 拼最终文档 ─────────────────────────────────── */

function esc(text: string): string {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function stamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function coverSheet(doc: PrintDoc, settings: PdfSettings): string {
  const stats = doc.stats;
  return (
    `<section class="sheet pdf-sheet-cover"><div class="pdf-cover">` +
    `<p class="pdf-cover-kicker">泼墨画板 · PDF 排版导出</p>` +
    `<h1>${esc(doc.title)}</h1>` +
    (doc.group ? `<p class="pdf-cover-group">${esc(doc.group)}</p>` : "") +
    `<div class="pdf-cover-rule"></div>` +
    `<p class="pdf-cover-stats">` +
    `<b>${stats.cards}</b> 张卡片 · <b>${stats.edges}</b> 条连线 · <b>${stats.sections}</b> 节` +
    (stats.comments && settings.comments ? ` · <b>${stats.comments}</b> 条评论（未解决 ${stats.openComments}）` : "") +
    (doc.edgeKinds.length
      ? `<br />连线：${doc.edgeKinds.map((item) => `${esc(item.label)} ${item.count}`).join(" · ")}`
      : "") +
    `</p>` +
    (doc.filtered
      ? `<p class="pdf-cover-note">本次只导出${doc.filtered.q ? `关键词「${esc(doc.filtered.q)}」` : ""}${
          doc.filtered.types.length ? `类型 ${doc.filtered.types.map(esc).join(" / ")} ` : ""
        }命中的 ${stats.cards} 张；画板上还有 ${doc.filtered.hidden} 张没进这份文档。</p>`
      : "") +
    `<p class="pdf-cover-meta">${esc(doc.boardId)} · 导出于 ${stamp(doc.generatedAt)}</p>` +
    `</div></section>`
  );
}

/** 目录条目：每一条都带它真正落在第几页 */
function tocEntries(pages: PageSpec[], offset: number): TocEntry[] {
  const entries: TocEntry[] = [];
  let page = offset + 1;
  for (const spec of pages) {
    for (const block of spec.blocks) {
      if (block.toc) entries.push({ block, page });
    }
    page += spec.span;
  }
  return entries;
}

type TocEntry = { block: PrintBlock; page: number };

/** 一条目录行。量着分页与最终拼装用的是同一份 HTML，量出来的高度才作数 */
function tocRow({ block, page }: TocEntry): string {
  return (
    `<li class="lv${block.level}"><span class="tn">${block.index ?? ""}</span>` +
    `<span class="tt"><a href="#${esc(block.anchor)}">${esc(block.title)}</a></span>` +
    `<span class="tp">${page}</span></li>`
  );
}

function tocSheets(pagesOfEntries: TocEntry[][]): string[] {
  return pagesOfEntries.map(
    (slice, at) =>
      `<section class="sheet pdf-sheet-toc"><div class="page-body"><div class="page-flow">` +
      (at === 0 ? `<h2 class="pdf-toc-title">目录</h2>` : "") +
      `<ul class="pdf-toc">${slice.map(tocRow).join("")}</ul>` +
      `</div></div></section>`,
  );
}

/**
 * 目录也要**量着分页**。
 *
 * 这里踩过一次：目录一开始按「一页 30 条」硬切，而一页到底装得下多少条取决于纸张、
 * 页边距与字号——A4 标准边距只装得下 23 条，多出来的 7 条被 `overflow:hidden`
 * 悄悄裁掉了。页面上看不出任何异常，只是目录里凭空少了几行。
 * 正文从第一天起就是量着装的，目录当时图省事没跟上，这里补齐。
 */
async function paginateToc(doc: Document, entries: TocEntry[]): Promise<TocEntry[][]> {
  const host = doc.querySelector<HTMLElement>("#probe-toc .page-flow");
  const body = doc.querySelector<HTMLElement>("#probe-toc .page-body");
  if (!host || !body) throw new Error("排版用的隐藏画布没就绪");

  host.innerHTML = "";
  // 第一页顶上有「目录」两个字，它也占位置——量的时候就得带着
  let title: HTMLElement | null = doc.createElement("h2");
  title.className = "pdf-toc-title";
  title.textContent = "目录";
  host.appendChild(title);
  const list = doc.createElement("ul");
  list.className = "pdf-toc";
  host.appendChild(list);

  const pages: TocEntry[][] = [];
  let current: TocEntry[] = [];
  for (const entry of entries) {
    const row = doc.createElement("li");
    row.className = `lv${entry.block.level}`;
    row.innerHTML = tocRow(entry).replace(/^<li[^>]*>|<\/li>$/g, "");
    list.appendChild(row);
    if (overflowed(host, body) && current.length) {
      // 这一页满了：这一条退回来，从下一页开始（第二页起没有「目录」标题）
      row.remove();
      pages.push(current);
      current = [];
      if (title) {
        title.remove();
        title = null;
      }
      list.innerHTML = "";
      list.appendChild(row);
    }
    current.push(entry);
  }
  if (current.length) pages.push(current);
  return pages.length ? pages : [[]];
}

function bodySheets(pages: PageSpec[], doc: PrintDoc, settings: PdfSettings, offset: number, total: number): string {
  let page = offset + 1;
  const out: string[] = [];
  for (const spec of pages) {
    const foot = settings.pageNumbers
      ? `<div class="page-foot"><span class="pf-name">${esc([doc.group, doc.title].filter(Boolean).join(" · "))}</span>` +
        `<span class="pf-no">${page} / ${total}</span></div>`
      : "";
    out.push(
      `<section class="sheet${spec.flow ? " flow" : ""}"><div class="page-body"><div class="page-flow">` +
        spec.blocks
          .map(
            (block) =>
              `<div class="blk blk-${block.kind}${block.wide ? " wide" : ""}"${
                block.kind !== "card" ? ` id="${esc(block.anchor)}"` : ""
              }>${block.html}</div>`,
          )
          .join("") +
        `</div></div>${foot}</section>`,
    );
    page += spec.span;
  }
  return out.join("");
}

/**
 * 预览专用的一点点样式：把每一页画成一张纸摆在灰底上。
 *
 * 两条自我约束：① 只改**纸外面**的背景与投影，纸里面一个像素都不动，所以预览里
 * 看到的分页就是印出来的分页；② 整段裹在 `@media screen` 里——预览用的那份文档
 * 可以直接拿去打印，灰底与投影不会跟着上纸。
 */
const PREVIEW_CSS = `
@media screen{
  body{background:#e9e7e1;padding:14px 0}
  .sheet{margin:0 auto 14px;box-shadow:0 2px 10px rgba(38,41,47,.18);outline:1px solid rgba(38,41,47,.06)}
}`;

function shell(
  doc: PrintDoc,
  settings: PdfSettings,
  size: { w: number; h: number },
  inner: string,
  preview = false,
): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${esc([doc.group, doc.title].filter(Boolean).join(" · "))}</title>
<meta name="generator" content="blotboard PDF 排版" />
<style>${doc.css}${pageCss(settings, size)}${preview ? PREVIEW_CSS : ""}</style>
</head>
<body>${inner}</body>
</html>`;
}

/**
 * 把一份分块产物排成分好页的文档。
 *
 * 页码要收敛一下：正文的页码取决于封面 + 目录占了几页，而目录占几页得**量**出来。
 * 所以先按一个假的目录页数算一轮页码、量出真页数，页数变了就拿新的再来一轮。
 * 目录行的高度与页码位数无关，所以这个循环一两轮就停；三轮是防呆上限。
 */
export async function buildPdfDocument(
  doc: PrintDoc,
  settings: PdfSettings,
  onProgress?: (done: number, total: number) => void,
  options: { preview?: boolean } = {},
): Promise<PdfBuildResult> {
  const size = pageSizeMm(settings);
  /*
   * 两把尺子：正文页带页脚、目录页不带，可用高度差一截。
   * 拿正文那张去量目录，目录每页就会少装一行——尺子必须和它要量的东西长得一样。
   */
  const probe = shell(
    doc,
    settings,
    size,
    `<section class="sheet" id="probe-body"><div class="page-body"><div class="page-flow"></div></div>${
      settings.pageNumbers ? `<div class="page-foot"><span class="pf-name">x</span><span class="pf-no">1 / 1</span></div>` : ""
    }</section>` +
      `<section class="sheet pdf-sheet-toc" id="probe-toc"><div class="page-body"><div class="page-flow"></div></div></section>`,
  );
  const { frame, doc: frameDoc } = await openFrame(probe);
  let pages: PageSpec[];
  let tocPagesOfEntries: TocEntry[][] = [];
  let tocPageCount = 0;
  try {
    pages = await paginate(frameDoc, doc.blocks, settings, onProgress);
    if (!pages.length) pages = [{ blocks: [], flow: false, span: 1 }];
    if (settings.toc) {
      const coverAt = settings.cover ? 1 : 0;
      tocPageCount = 1;
      for (let round = 0; round < 3; round += 1) {
        const attempt = await paginateToc(frameDoc, tocEntries(pages, coverAt + tocPageCount));
        tocPagesOfEntries = attempt;
        if (attempt.length === tocPageCount) break;
        tocPageCount = attempt.length;
      }
    }
  } finally {
    frame.remove();
  }

  const bodyPages = pages.reduce((sum, spec) => sum + spec.span, 0);
  const coverPages = settings.cover ? 1 : 0;
  const offset = coverPages + tocPageCount;
  const total = offset + bodyPages;

  const inner =
    (settings.cover ? coverSheet(doc, settings) : "") +
    (settings.toc ? tocSheets(tocPagesOfEntries).join("") : "") +
    bodySheets(pages, doc, settings, offset, total);

  return {
    html: shell(doc, settings, size, inner, options.preview),
    pageCount: total,
    blockCount: doc.blocks.length,
  };
}

/* ── 取数据 + 打印 ─────────────────────────────── */

export interface PdfSource {
  boardId: string;
  /** 画布上开着的筛选（scope=filtered 时带给服务端，口径与画布一致） */
  q?: string;
  types?: string[];
  /** 画布上选中的卡片（scope=selected 时用） */
  selectedIds?: string[];
}

/**
 * 按 scope 决定这次导哪些卡；口径转成服务端认的三个参数。
 *
 * 「选中的」而画布上一张没选时退回整块板——设置是记在本地的，上次选着几张卡导过一次，
 * 下次一键导出时画布上很可能什么都没选，这时候吐一份空文档才是真的意外。
 */
export function printDocQuery(settings: PdfSettings, source: PdfSource) {
  if (settings.scope === "selected" && source.selectedIds?.length) {
    return { comments: settings.comments, ids: source.selectedIds };
  }
  if (settings.scope === "filtered") return { comments: settings.comments, q: source.q, types: source.types };
  return { comments: settings.comments };
}

export async function fetchPrintDoc(settings: PdfSettings, source: PdfSource): Promise<PrintDoc> {
  return api.printDoc(source.boardId, printDocQuery(settings, source));
}

/**
 * 交给系统打印。
 *
 * 走一个屏幕外的同源 iframe：`print()` 打的是那一帧，画板本身的 DOM 一个字都不用动
 * （直接改主文档去打印，退出打印后要把页面复原，中间任何一次报错都会把用户的画布留在
 * 一个奇怪的状态里）。打完不立刻拆——Safari 的打印是异步的，拆早了会打出空白页。
 */
export async function printHtml(html: string): Promise<void> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0";
  frame.srcdoc = html;
  document.body.appendChild(frame);
  await new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
  });
  const win = frame.contentWindow;
  if (!win) {
    frame.remove();
    throw new Error("打印用的画布没起来");
  }
  // 同样给等图设个上限：解不出来就照常打印，别把用户卡在一个没有出口的等待里
  const images = [...(frame.contentDocument?.images || [])].filter((img) => !img.complete);
  if (images.length) {
    await Promise.race([
      Promise.all(images.map((img) => img.decode().catch(() => undefined))),
      new Promise((resolve) => window.setTimeout(resolve, IMAGE_BATCH_MS)),
    ]);
  }
  win.focus();
  win.print();
  window.setTimeout(() => frame.remove(), 60_000);
}

/** 一键：取分块 → 排版 → 打印（对话框里选「另存为 PDF」） */
export async function exportBoardPdf(
  settings: PdfSettings,
  source: PdfSource,
  onProgress?: (done: number, total: number) => void,
): Promise<PdfBuildResult> {
  const doc = await fetchPrintDoc(settings, source);
  if (!doc.blocks.length) throw new Error("这次没有可导出的卡片");
  const built = await buildPdfDocument(doc, settings, onProgress);
  await printHtml(built.html);
  return built;
}
