/**
 * 服务端排版导出：把一块画板渲染成**一份自包含的单文件 HTML**。
 *
 * 为什么把版式从浏览器手里收回来：原来的「阅读导出」是在页面里搭一份 DOM 再让用户
 * 走系统打印，版式受浏览器、缩放、字体、打印机驱动四方影响，同一块板在两台机器上
 * 印出来不一样——用户看到的「格式乱」就是这个。更要命的是规格卡：阅读视图对 data
 * 卡走的是「显示 content」那条默认分支，而规格卡的内容全在 data.fields 里，content
 * 是空的，于是 94 张案例卡印出来只剩标题。
 *
 * 这里的做法是反过来：服务端一次性算好全部版式，产物是一份**死的 HTML**——
 * 没有外链、没有 CDN、没有字体请求、没有运行时排版，离线双击就能开，
 * 打印样式也写死在文件里（A4、卡片不跨页）。它长什么样只取决于这份文件本身。
 *
 * **卡片包化之后**：每种卡片的版式在 cards/<type>/export.ts（经 lib/card-registry.ts
 * 分派），公共工具在 lib/export-helpers.ts；这里只剩分节、资源内联、目录与整篇文档。
 * 未知类型（数据里有、代码里没有）降级成「正文 + 原始字段」，导出照样能出。
 *
 * 分节不靠画布坐标（那是给屏幕看的），靠**连线的连通分量**：画板上常见的组织方式
 * 就是「一张区头卡 → 若干张内容卡」，一个分量天然就是一节。顺序仍沿用阅读顺序
 * （从上到下、同排从左到右），因为那是作者摆版面时心里的先后。
 */
import { COLORS, EDGE_KIND_META } from "./constants";
import { embedBundleScript, type BoardBundle } from "./board-bundle";
import { typeLabelOf } from "./card-metas";
import { serverPack } from "./card-registry";
import { allSpecs } from "./card-spec-store";
import { readingOrder } from "./layout";
import { MERMAID_FLOW_CSS } from "./mermaid-flow";
import { cardSearchText } from "./search-text";
import { readControlledImage } from "./uploads";
import { libraryProvider } from "./integrations/library-provider";
import { AIDOCS_URL } from "./config";
import {
  type ExportHtmlCtx,
  body,
  escapeHtml,
  followHost,
  stamp,
} from "./export-helpers";
import type {
  Board,
  BoardCard,
  CardType,
  BoardComment,
  BoardEdge,
} from "./types";

export { escapeHtml } from "./export-helpers";

export interface HtmlExportOptions {
  /** 把画板上的批注一起印出来，做「带评论的评审版」。默认关：交出去的是作品，不是工作台 */
  comments?: boolean;
  /** 产物里写的导出时刻（可注入，测试要一个稳定值） */
  now?: number;
  /**
   * 用户是从哪个地址访问画板的（`http://100.x.y.z:8567` 这种，含协议与端口）。
   * 产物里指回画板 / 知识库 / 书库的链接都跟着它走——不然从 Tailscale 导出的文件里
   * 全是 127.0.0.1，换台机器点开就是死链。
   */
  origin?: string;
  /**
   * 只导筛选命中的那批（口径与画布上的搜索 / 类型筛选一致）。
   * 画布上正开着筛选时，用户想导的往往就是眼前这批，不是整块板。
   *
   * `ids` 是另一条更直接的口径：**只导这几张卡**（画布上选中的那批）。
   * 给了 ids 就只看 ids——「我选中的这三张」不该再被关键词二次过滤掉。
   */
  filter?: { q?: string; types?: CardType[]; ids?: string[] };
  /**
   * 顺带写进产物的画板载荷（`lib/board-bundle.ts`）：给了，这份 HTML 就**既能读也能导回来**。
   *
   * 收的是**回调**而不是现成的包：载荷必须与读者看到的那一份严丝合缝——
   * 开着筛选就只带命中的那批，没勾「带评论」就一条批注都不带（不然「我没印批注」
   * 的那份文件里还藏着全部批注）。这些只有排版器算完才知道，所以由它回叫调用方。
   * 打包本身要读上传件与 storage，那些不该长在排版器里。
   */
  payload?: ((boards: Board[]) => BoardBundle | null) | null;
}

/** 与前端 cardMatches 同一条判据；共用的是 cardSearchText 那份 haystack */
function matches(card: BoardCard, q: string, types: CardType[]): boolean {
  if (types.length && !types.includes(card.type)) return false;
  const keyword = q.trim().toLowerCase();
  if (!keyword) return true;
  return cardSearchText(card).includes(keyword);
}

/* ── 1. 分节：按连线的连通分量切 ───────────────── */

export interface ExportSection {
  /** 节标题卡（分量里阅读顺序最靠前的那张）；松散卡片的那一节没有 */
  head: BoardCard | null;
  /** 节里其余的卡片（不含 head） */
  cards: BoardCard[];
}

/**
 * 分节。
 *
 * · 连线连成一片（≥2 张）的算一节，节标题取分量里阅读顺序最靠前的那张卡；
 * · 没有连线的孤卡不各成一节（否则一块 44 张无连线的板会得到 44 个空壳标题），
 *   而是攒成一节「单独的卡片」，按它们在阅读顺序里的位置插进去；
 * · 整块板一条线都没有时，只有一节，退化成一份平铺的文档——这正是想要的。
 */
export function sectionize(cards: BoardCard[], edges: BoardEdge[]): ExportSection[] {
  const order = readingOrder(cards);
  const rank = new Map(order.map((card, index) => [card.id, index]));
  const byId = new Map(cards.map((card) => [card.id, card]));

  /* 并查集：连线不分方向，A→B 与 B→A 都算同一片 */
  const parent = new Map<string, string>(cards.map((card) => [card.id, card.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const a = find(edge.from);
    const b = find(edge.to);
    // 合并时让阅读顺序靠前的那张当根，节标题就自然是它
    if (a !== b) parent.set((rank.get(a) ?? 0) <= (rank.get(b) ?? 0) ? b : a, (rank.get(a) ?? 0) <= (rank.get(b) ?? 0) ? a : b);
  }

  const groups = new Map<string, BoardCard[]>();
  for (const card of order) {
    const root = find(card.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(card);
  }

  const sections: ExportSection[] = [];
  let loose: BoardCard[] = [];
  const flushLoose = () => {
    if (!loose.length) return;
    sections.push({ head: null, cards: loose });
    loose = [];
  };
  // groups 是按 order 插入的，迭代顺序就是阅读顺序
  for (const members of groups.values()) {
    if (members.length < 2) {
      loose.push(members[0]);
      continue;
    }
    flushLoose();
    sections.push({ head: members[0], cards: members.slice(1) });
  }
  flushLoose();
  return sections;
}

/* ── 2. 资源内联：产物必须离线可开 ───────────────── */

/** 单张内联图的上限：超了就退回一行说明，免得一份导出变成上百 MB */
const INLINE_IMAGE_MAX = 4 * 1024 * 1024;

type AssetMap = Map<string, string>;

/**
 * 把这块板要用到的图片全读成 data URI。
 * 上传件走本地文件（服务端读得到），书库封面回源书库——拿不到就算了，
 * 缺一张封面不该让整份导出失败。
 */
async function collectAssets(cards: BoardCard[]): Promise<AssetMap> {
  const assets: AssetMap = new Map();

  for (const card of cards) {
    if (card.type !== "image" || !card.file?.uploadId) continue;
    try {
      const image = readControlledImage(card.file.uploadId);
      if (image.bytes.length > INLINE_IMAGE_MAX) continue;
      assets.set(`upload:${card.file.uploadId}`, `data:${image.mediaType};base64,${image.bytes.toString("base64")}`);
    } catch {
      /* 图没了就留占位，不影响其余卡片 */
    }
  }

  const bookIds = [...new Set(cards.filter((card) => card.book?.bookId).map((card) => card.book!.bookId))];
  await Promise.all(
    bookIds.map(async (bookId) => {
      try {
        const cover = await libraryProvider.fetchCover(bookId);
        const bytes = Buffer.from(cover.body);
        if (bytes.length > INLINE_IMAGE_MAX) return;
        assets.set(`book:${bookId}`, `data:${cover.type};base64,${bytes.toString("base64")}`);
      } catch {
        /* 书库没开着也要能导出 */
      }
    }),
  );

  return assets;
}

/* ── 3. 一张卡的正文：分派给卡片包 ───────────────── */

const COMMON_CARD_KEYS = new Set([
  "id", "type", "createdAt", "updatedAt", "createdBy", "x", "y", "w", "h", "z",
  "color", "title", "content", "agentPrompt", "frameId",
]);

/**
 * 分派：有包、包里声明了 html 版式的走包（cards/<type>/export.ts）；
 * 没声明的（text）走通用正文；**未知类型**降级——正文照排 + 原始字段折叠成代码块，
 * 加一行灰字说明（与卡面的 Tier 0 兜底同一语义）。
 */
function renderCardBody(card: BoardCard, ctx: ExportHtmlCtx): string {
  const pack = serverPack(card.type);
  if (pack) {
    if (pack.export?.html) return pack.export.html(card, ctx);
    return body(card.content) || `<p class="empty">这张卡还没有正文</p>`;
  }
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(card as unknown as Record<string, unknown>)) {
    if (!COMMON_CARD_KEYS.has(key)) extras[key] = value;
  }
  return (
    `<p class="note">类型 <code>${escapeHtml(card.type)}</code> 在本机没有对应卡片包，按通用版式导出。</p>` +
    (body(card.content) || "") +
    (Object.keys(extras).length
      ? `<pre class="code">${escapeHtml(JSON.stringify(extras, null, 2))}</pre>`
      : "")
  );
}

export function renderComments(comments: BoardComment[]): string {
  if (!comments.length) return "";
  return (
    `<div class="comments"><span class="comments-label">评论 ${comments.length}</span><ul>` +
    comments
      .map(
        (comment) =>
          `<li class="${comment.resolved ? "resolved" : ""}"><span class="dim">${comment.resolved ? "已解决" : "待处理"} · ${comment.createdBy === "agent" ? "agent" : "我"} · ${stamp(comment.createdAt)}</span>` +
          `<p>${escapeHtml(comment.text)}</p>` +
          (comment.replies || []).map((reply) => `<p class="reply">↳ ${reply.createdBy === "agent" ? "agent" : "我"}：${escapeHtml(reply.text)}</p>`).join("") +
          `</li>`,
      )
      .join("") +
    `</ul></div>`
  );
}

export function cardTitle(card: BoardCard): string {
  const title = (card.title || "").trim();
  if (title) return title;
  const text = (card.content || card.task?.goal || "").trim().split("\n")[0];
  return text ? text.slice(0, 40) : `${typeLabelOf(card.type)}卡片`;
}

/* ── 6. 整篇文档 ─────────────────────────────── */

/** 一张卡在文档里的样子（含卡头序号、类型标、评论） */
export function renderCard(card: BoardCard, index: number, ctx: ExportHtmlCtx): string {
  // 先渲正文：图有多宽只有渲完才知道，wide 是它回填的
  const inner = renderCardBody(card, ctx);
  return (
    `<article class="card${ctx.wide.has(card.id) ? " wide" : ""}" id="${escapeHtml(card.id)}" style="--accent:${COLORS[card.color] || COLORS.slate}">` +
    `<header class="card-head"><span class="card-idx">${index}</span>` +
    `<h3>${escapeHtml(cardTitle(card))}</h3>` +
    `<span class="card-type">${escapeHtml(typeLabelOf(card.type))}</span></header>` +
    `<div class="card-body">${inner}</div>` +
    renderComments(ctx.commentsByCard.get(card.id) || []) +
    `</article>`
  );
}

/**
 * 「关系一览」附录：把标注过的连线单列一节。
 *
 * 只在**有连线真的标注过东西**（标签 / 关系强弱 / 标签组）时才出现——
 * 分节已经把连成一片的卡摆在一起了，纯 rel 无标注的线再列一遍纯属噪音；
 * 而 weight / tags 是文档里别处根本看不到的信息，不列就等于导出时丢了。
 */
export function renderRelations(cards: BoardCard[], edges: BoardEdge[]): string {
  const marked = edges.filter((edge) => edge.label || edge.weight || (edge.tags || []).length);
  if (!marked.length) return "";
  const byId = new Map(cards.map((card) => [card.id, card]));
  const rows = marked
    .map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return "";
      const kind = EDGE_KIND_META[edge.kind]?.label || "关联";
      const bits = [
        `<span class="rel-kind">${escapeHtml(kind)}</span>`,
        edge.label ? `<span class="rel-label">${escapeHtml(edge.label)}</span>` : "",
        // 强弱画成 5 格实心/空心，不写数字——一列扫下来哪条最要紧一眼可见
        edge.weight ? `<span class="rel-weight" title="关系强弱 ${edge.weight}/5">${"●".repeat(edge.weight)}${"○".repeat(5 - edge.weight)}</span>` : "",
        ...(edge.tags || []).map((tag) => `<span class="rel-tag">${escapeHtml(tag)}</span>`),
      ].filter(Boolean);
      return (
        `<li><a href="#${escapeHtml(from.id)}">${escapeHtml(cardTitle(from))}</a>` +
        `<span class="rel-arrow">→</span>` +
        `<a href="#${escapeHtml(to.id)}">${escapeHtml(cardTitle(to))}</a>` +
        `<span class="rel-marks">${bits.join("")}</span></li>`
      );
    })
    .filter(Boolean);
  if (!rows.length) return "";
  return (
    `<section class="sec" id="sec-relations"><div class="sec-head"><h2>关系一览</h2>` +
    `<span class="sec-count">${rows.length} 条</span></div>` +
    `<ul class="rel-list">${rows.join("")}</ul></section>`
  );
}

/**
 * 一次导出的**共同准备工作**：筛选 → 内联资源 → 分节 → 评论归位。
 *
 * 单独抽出来是因为现在有两个渲染器共用它：单文件 HTML（本文件下面那个）与
 * PDF 排版用的分块产物（lib/export-print.ts）。两者的**内容口径必须一模一样**——
 * 同一块板导出的 HTML 与 PDF 里，卡片编号、分节、筛选命中的那批只能有一份判断。
 * 差别只在版面：一个铺成网格给屏幕看，一个切成块交给浏览器分页。
 */
export interface PreparedExport {
  /** 画板上的全部卡片（含被筛掉的），封面上要说「还有几张没命中」 */
  all: BoardCard[];
  /** 这次要导的卡片 */
  cards: BoardCard[];
  edges: BoardEdge[];
  comments: BoardComment[];
  /** 不挂在任何卡片上的评论（画布 / 连线上的），单列一节 */
  looseComments: BoardComment[];
  sections: ExportSection[];
  /** 一条连线都没有：只有一节「单独的卡片」，那个节标题纯属噪音 */
  bare: boolean;
  filtering: boolean;
  q: string;
  types: CardType[];
  ctx: ExportHtmlCtx;
  now: number;
}

export async function prepareExport(board: Board, options: HtmlExportOptions = {}): Promise<PreparedExport> {
  const all = board.cards || [];
  const q = options.filter?.q || "";
  const types = options.filter?.types || [];
  // 指名道姓的一批（画布上选中的）优先：给了 ids 就不再拿关键词二次过滤
  const ids = options.filter?.ids?.length ? new Set(options.filter.ids) : null;
  const filtering = Boolean(ids || q.trim() || types.length);
  const cards = ids ? all.filter((card) => ids.has(card.id)) : filtering ? all.filter((card) => matches(card, q, types)) : all;
  const kept = new Set(cards.map((card) => card.id));
  // 筛掉的卡连出去的线也要跟着走，否则分节会把一个不在册的 id 当成同伴
  const edges = (board.edges || []).filter((edge) => kept.has(edge.from) && kept.has(edge.to));
  const comments = board.comments || [];
  const now = options.now ?? Date.now();
  const origin = (options.origin || "").replace(/\/+$/, "");

  const specs = new Map(allSpecs().map((spec) => [spec.id, spec]));
  const assets = await collectAssets(cards);

  const commentsByCard = new Map<string, BoardComment[]>();
  if (options.comments) {
    for (const comment of comments) {
      if (comment.target !== "card" || !comment.targetId) continue;
      if (!commentsByCard.has(comment.targetId)) commentsByCard.set(comment.targetId, []);
      commentsByCard.get(comment.targetId)!.push(comment);
    }
  }
  const looseComments = options.comments ? comments.filter((comment) => comment.target !== "card") : [];

  const sections = sectionize(cards, edges);
  const bare = sections.length === 1 && !sections[0].head;
  const ctx: ExportHtmlCtx = { specs, assets, origin, aidocsBase: followHost(AIDOCS_URL, origin), commentsByCard, cards, wide: new Set() };

  return { all, cards, edges, comments, looseComments, sections, bare, filtering, q, types, ctx, now };
}

/**
 * 一块板在文档里的那一段：目录条目 + 正文分节 + 关系一览 + 游离评论。
 *
 * 从 renderBoardHtml 里拆出来的唯一理由是**一份产物可以装多块板**（导出一个分组 /
 * 整个库）。锚点因此要带上板的前缀——两块板各有一节 `sec-1`，不隔开的话目录里
 * 点第二块板的第一节会跳回第一块板。卡片锚点仍用卡片 id（本来就跨板唯一）。
 */
function renderBoardBody(prepared: PreparedExport, prefix: string): { toc: string[]; html: string } {
  const { cards, edges, sections, bare, ctx } = prepared;
  /** 卡片不多的板，目录默认摊开；上百张的板默认收起来，不然目录本身就先淹了 */
  const tocOpen = cards.length <= 30;

  /* 卡片编号在一块板里连续：目录、卡头、正文引用的是同一个号 */
  let seq = 0;
  const tocItems: string[] = [];
  const sectionHtml: string[] = [];

  sections.forEach((section, at) => {
    const anchor = `${prefix}sec-${at + 1}`;
    const total = section.cards.length + (section.head ? 1 : 0);
    const title = section.head ? cardTitle(section.head) : "单独的卡片";
    const entries: string[] = [];

    const parts: string[] = [`<section class="sec" id="${anchor}">`];
    if (!bare) {
      parts.push(`<div class="sec-head"><h2>${escapeHtml(title)}</h2><span class="sec-count">${total} 张</span></div>`);
    }
    if (section.head) {
      seq += 1;
      entries.push(`<li><a href="#${escapeHtml(section.head.id)}"><span class="n">${seq}</span>${escapeHtml(cardTitle(section.head))}</a></li>`);
      // 区头卡自己也是一张卡，但摆成整节的导语——它写的通常就是「这一区怎么用」
      parts.push(`<div class="sec-intro">${renderCard(section.head, seq, ctx)}</div>`);
    }
    parts.push(`<div class="grid">`);
    for (const card of section.cards) {
      seq += 1;
      entries.push(`<li><a href="#${escapeHtml(card.id)}"><span class="n">${seq}</span>${escapeHtml(cardTitle(card))}</a></li>`);
      parts.push(renderCard(card, seq, ctx));
    }
    parts.push(`</div></section>`);
    sectionHtml.push(parts.join(""));

    tocItems.push(
      `<li class="toc-sec${bare || tocOpen ? " open" : ""}">` +
        (bare
          ? ""
          : `<div class="toc-sec-head"><a href="#${anchor}">${escapeHtml(title)}</a>` +
            `<button class="toc-toggle" type="button" aria-expanded="${tocOpen ? "true" : "false"}" aria-label="展开本节卡片">${total}</button></div>`) +
        `<ul class="toc-sub${bare ? " flat" : ""}">${entries.join("")}</ul></li>`,
    );
  });

  const loose = prepared.looseComments;
  return {
    toc: tocItems,
    html:
      (sectionHtml.join("") || `<section class="sec"><p class="empty">这块画板还没有卡片。</p></section>`) +
      renderRelations(cards, edges) +
      (loose.length
        ? `<section class="sec" id="${prefix}sec-loose"><div class="sec-head"><h2>画布与连线上的评论</h2><span class="sec-count">${loose.length} 条</span></div><div class="grid"><article class="card">${renderComments(loose)}</article></div></section>`
        : ""),
  };
}

/** 一块板的封面（多块板时是每块板的小抬头，单块板时就是整篇的封面）。 */
function renderCover(board: Board, prepared: PreparedExport, options: { multi: boolean; anchor: string }): string {
  const { all, cards, edges, comments, sections, filtering, q, types, now } = prepared;
  const openComments = comments.filter((comment) => !comment.resolved).length;
  const edgeKinds = new Map<string, number>();
  for (const edge of edges) {
    const label = EDGE_KIND_META[edge.kind]?.label || "关联";
    edgeKinds.set(label, (edgeKinds.get(label) || 0) + 1);
  }
  return `<header class="cover${options.multi ? " board-cover" : ""}" id="${options.anchor}">
    ${options.multi ? "" : `<p class="cover-kicker">泼墨画板 · 服务端排版导出</p>`}
    <h1>${escapeHtml(board.name)}</h1>
    ${board.group ? `<p class="cover-group">${escapeHtml(board.group)}</p>` : ""}
    <p class="cover-stats">
      <b>${cards.length}</b> 张卡片 · <b>${edges.length}</b> 条连线 · <b>${sections.length}</b> 节
      ${comments.length ? ` · <b>${comments.length}</b> 条评论（未解决 ${openComments}）` : ""}
    </p>
    <p class="cover-meta">${escapeHtml(board.id)} · 导出于 ${stamp(now)}</p>
    ${
      filtering
        ? `<p class="cover-note">本次只导出筛选命中的 ${cards.length} 张${q.trim() ? `（关键词「${escapeHtml(q.trim())}」）` : ""}${types.length ? `（类型：${types.map((type) => escapeHtml(typeLabelOf(type))).join(" / ")}）` : ""}；画板上还有 ${all.length - cards.length} 张没命中。</p>`
        : ""
    }
    ${edgeKinds.size ? `<p class="cover-meta">连线：${[...edgeKinds].map(([label, count]) => `${escapeHtml(label)} ${count}`).join(" · ")}</p>` : ""}
  </header>`;
}

export async function renderBoardHtml(board: Board, options: HtmlExportOptions = {}): Promise<string> {
  return renderBoardsHtml([board], options);
}

/**
 * 产物末尾那段画板载荷：**只装这份文件里看得见的东西**（筛选后的卡片与连线，
 * 勾了才有的评论）——「导出的 HTML 能导回画板」不该变成「顺手多发一份没打算给的内容」。
 */
function payloadScript(boards: Board[], prepared: PreparedExport[], options: HtmlExportOptions): string {
  if (!options.payload) return "";
  const visible = boards.map((board, index) => ({
    ...board,
    cards: prepared[index].cards,
    edges: prepared[index].edges,
    comments: options.comments ? prepared[index].comments : [],
  }));
  const bundle = options.payload(visible);
  return bundle ? embedBundleScript(bundle) : "";
}

/**
 * 一份自包含的单文件 HTML —— 一块板，或者一整批板（一个分组 / 整个库）。
 *
 * 多块板时只多两样东西：一页总封面（有几块板、各多少张卡）与目录里的板级分组；
 * 每块板自己那一段与单块板导出**逐字节一致**——「导一块」和「导一批」不该是两套版式。
 *
 * `options.payload` 给的话，产物末尾会多一段画板载荷（`<script type="application/json">`）：
 * 这正是「导出的 HTML 还能导回来」的实现——载荷里不带图片字节，图片按 `data-asset`
 * 从正文里那份 data URI 取回（见 lib/board-bundle.ts），所以带不带载荷，文件大小几乎不变。
 */
export async function renderBoardsHtml(boards: Board[], options: HtmlExportOptions = {}): Promise<string> {
  if (!boards.length) throw new Error("没有要导出的画板");
  const multi = boards.length > 1;
  const now = options.now ?? Date.now();
  const prepared = await Promise.all(boards.map((board) => prepareExport(board, { ...options, now })));

  const tocBlocks: string[] = [];
  const bodyBlocks: string[] = [];
  boards.forEach((board, index) => {
    const prefix = multi ? `b${index + 1}-` : "";
    const anchor = `${prefix}board`;
    const part = renderBoardBody(prepared[index], prefix);
    bodyBlocks.push(renderCover(board, prepared[index], { multi, anchor }) + part.html);
    tocBlocks.push(
      multi
        ? `<li class="toc-board"><div class="toc-board-head"><a href="#${anchor}">${escapeHtml(board.name)}</a>` +
          `<span>${prepared[index].cards.length}</span></div><ul class="toc-list">${part.toc.join("")}</ul></li>`
        : part.toc.join(""),
    );
  });

  const totalCards = prepared.reduce((sum, item) => sum + item.cards.length, 0);
  const first = boards[0];
  const heading = multi
    ? `${first.name} 等 ${boards.length} 块画板`
    : [first.group, first.name].filter(Boolean).join(" · ");
  const groups = [...new Set(boards.map((board) => board.group || "").filter(Boolean))];

  const indexCover = multi
    ? `<header class="cover">
    <p class="cover-kicker">泼墨画板 · 服务端排版导出</p>
    <h1>${escapeHtml(boards.length === 1 ? first.name : `${boards.length} 块画板`)}</h1>
    ${groups.length ? `<p class="cover-group">${escapeHtml(groups.join(" · "))}</p>` : ""}
    <p class="cover-stats"><b>${boards.length}</b> 块画板 · <b>${totalCards}</b> 张卡片</p>
    <p class="cover-meta">导出于 ${stamp(now)}</p>
    <ol class="board-index">${boards
      .map(
        (board, index) =>
          `<li><a href="#b${index + 1}-board">${escapeHtml(board.name)}</a><span>${prepared[index].cards.length} 张</span></li>`,
      )
      .join("")}</ol>
  </header>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(heading)}</title>
<meta name="generator" content="blotboard 服务端排版导出" />
<style>${DOC_CSS}${MERMAID_FLOW_CSS}</style>
</head>
<body>
<div class="progress"><i></i></div>
<div class="doc">
<aside class="toc">
  <div class="toc-brand">${escapeHtml(multi ? `${boards.length} 块画板` : first.name)}${
    !multi && first.group ? `<span>${escapeHtml(first.group)}</span>` : ""
  }</div>
  <input class="toc-filter" type="search" placeholder="过滤本页卡片…" aria-label="过滤卡片" />
  <nav><ul class="toc-list">${tocBlocks.join("")}</ul></nav>
</aside>
<main>
  ${indexCover}
  ${bodyBlocks.join("")}
  <footer class="doc-foot">
    ${escapeHtml(multi ? `${boards.length} 块画板` : first.name)} · ${totalCards} 张卡片 · 导出于 ${stamp(now)} · blotboard 服务端排版
  </footer>
</main>
</div>
<script>${DOC_JS}</script>
${payloadScript(boards, prepared, options)}
</body>
</html>`;
}

/* ── 7. 样式：全部内联，产物不发一个外部请求 ─────── */

export const DOC_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --ink:#25242180;--text:#242320;--dim:#6f6b62;--faint:#918c81;
  --paper:#faf9f6;--card:#fff;--line:#e5e1d8;--line-soft:#efece4;
  --accent:#cfd4dc;--brand:#5b5bd6;
}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--paper);color:var(--text);
  font:15px/1.72 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
}
a{color:#3f52c4;text-decoration:none}
a:hover{text-decoration:underline}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

/* 阅读进度条 */
.progress{position:fixed;top:0;left:0;right:0;height:3px;z-index:9;background:transparent}
.progress i{display:block;height:100%;width:0;background:var(--brand);transition:width .1s linear}

.doc{display:grid;grid-template-columns:264px minmax(0,1fr);gap:0;max-width:1500px;margin:0 auto}

/* ── 侧边目录：sticky，自己滚 ── */
.toc{
  position:sticky;top:0;align-self:start;height:100vh;overflow:auto;
  padding:22px 14px 40px 20px;border-right:1px solid var(--line);background:#fdfcfa;
}
.toc-brand{font-size:15px;font-weight:700;line-height:1.4;margin-bottom:4px}
.toc-brand span{display:block;font-size:11.5px;font-weight:500;color:var(--faint);margin-top:2px}
.toc-filter{
  width:100%;margin:10px 0 12px;padding:6px 9px;font:inherit;font-size:12.5px;
  border:1px solid var(--line);border-radius:7px;background:#fff;color:inherit;
}
.toc-filter:focus{outline:none;border-color:var(--brand)}
.toc-list,.toc-sub{list-style:none;margin:0;padding:0}

/* 一份产物装了多块板：目录先按板分块，正文里每块板有自己的小抬头 */
.toc-board{margin:0 0 10px}
.toc-board-head{display:flex;align-items:baseline;gap:6px;padding:5px 7px;border-bottom:1px solid var(--line)}
.toc-board-head a{flex:1;font-size:13.2px;font-weight:750;color:var(--text)}
.toc-board-head span{flex:none;font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}
.toc-board .toc-list{margin-top:4px}
.board-index{margin:14px 0 0;padding-left:20px;font-size:13.5px}
.board-index li{margin:3px 0}
.board-index span{color:var(--faint);font-size:12px;margin-left:6px}
.cover.board-cover{padding-top:30px;border-top:1px solid var(--line)}
.cover.board-cover h1{font-size:24px}
.toc-sec{margin-bottom:2px}
.toc-sec-head{display:flex;align-items:flex-start;gap:6px}
.toc-sec-head a{
  flex:1;display:block;padding:5px 7px;border-radius:6px;font-size:12.8px;font-weight:650;
  color:var(--text);line-height:1.45;
}
.toc-sec-head a:hover{background:#f2efe8;text-decoration:none}
.toc-toggle{
  flex:none;margin-top:5px;min-width:26px;height:20px;padding:0 5px;cursor:pointer;
  border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--faint);
  font:inherit;font-size:11px;font-variant-numeric:tabular-nums;
}
.toc-toggle:hover{border-color:#c9c4b8;color:var(--dim)}
.toc-toggle[aria-expanded="true"]{background:#f0eee7;color:var(--dim)}
.toc-sub{display:none;margin:1px 0 6px 8px;padding-left:8px;border-left:1px solid var(--line-soft)}
.toc-sub.flat{margin-left:0;padding-left:0;border-left:none}
.toc-sec.open .toc-sub{display:block}
.toc-sub a{display:flex;gap:6px;padding:3px 6px;border-radius:5px;font-size:12px;color:var(--dim);line-height:1.4}
.toc-sub a:hover{background:#f2efe8;color:var(--text);text-decoration:none}
.toc-sub .n{flex:none;min-width:22px;color:var(--faint);font-variant-numeric:tabular-nums}
.toc-sub a.on,.toc-sec-head a.on{background:#ecebfa;color:#3b3ba8}
.toc-sec.hide,.toc-sub li.hide{display:none}

/* ── 正文 ── */
main{min-width:0;padding:0 34px 60px}
.cover{padding:56px 0 30px;border-bottom:1px solid var(--line)}
.cover-kicker{margin:0 0 10px;font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.cover h1{margin:0;font-size:31px;line-height:1.3;letter-spacing:-.01em}
.cover-group{margin:8px 0 0;font-size:14px;color:var(--dim)}
.cover-stats{margin:16px 0 4px;font-size:13.5px;color:var(--dim)}
.cover-stats b{color:var(--text);font-variant-numeric:tabular-nums}
.cover-meta{margin:2px 0 0;font-size:12px;color:var(--faint);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.cover-note{margin:10px 0 0;padding:7px 11px;border-left:3px solid #e2c98d;background:#fdf8ee;font-size:12.5px;color:var(--dim)}

.sec{padding-top:34px}
.sec-head{display:flex;align-items:baseline;gap:10px;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid var(--line)}
.sec-head h2{margin:0;font-size:19px;line-height:1.4;flex:1}
.sec-count{flex:none;font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums}
.sec-intro{margin-bottom:16px}
.sec-intro .card{border-color:#dcd7cb;background:#fbfaf7}

/* 固定版式网格：不依赖画布坐标，窄了自动收成一列 */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:16px;align-items:start}
.card.wide{grid-column:1/-1}

.card{
  border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:9px;
  background:var(--card);padding:14px 16px 15px;overflow:hidden;
}
.card-head{display:flex;align-items:baseline;gap:8px;margin-bottom:9px}
.card-idx{
  flex:none;min-width:22px;height:18px;padding:0 5px;border-radius:9px;background:#f1eee7;
  color:var(--faint);font-size:11px;line-height:18px;text-align:center;font-variant-numeric:tabular-nums;
}
.card-head h3{margin:0;flex:1;font-size:14.5px;line-height:1.5;font-weight:680}
.card-type{flex:none;font-size:11px;color:var(--faint)}
.card-body{font-size:13.5px;line-height:1.75}
.card-body>*:first-child{margin-top:0}
.card-body>*:last-child{margin-bottom:0}

.pre{white-space:pre-wrap;word-break:break-word;margin:0 0 10px}
.md{word-break:break-word}
.md h1,.md h2,.md h3,.md h4{margin:14px 0 6px;font-size:14px;line-height:1.5}
.md p{margin:0 0 9px}
.md ul,.md ol{margin:0 0 9px;padding-left:20px}
.md li{margin:2px 0}
.md blockquote{margin:0 0 9px;padding:2px 0 2px 11px;border-left:3px solid var(--line);color:var(--dim)}
.md code{padding:1px 4px;border-radius:4px;background:#f3f1ea;font-size:12.5px}
.md pre,pre.code{
  position:relative;margin:0 0 10px;padding:10px 12px;overflow:auto;
  border:1px solid var(--line-soft);border-radius:7px;background:#f7f5ef;
  font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;
}
.md pre code{padding:0;background:none}
.md table{border-collapse:collapse;width:100%;margin:0 0 10px;font-size:12.5px}
.md th,.md td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
.md th{background:#f6f4ee}
.md img{max-width:100%;height:auto}
.md a{word-break:break-all}

.dim{color:var(--dim);margin:0 0 8px}
.empty{color:var(--faint);font-style:italic;margin:0}

/* 关系一览：标注过的连线（标签 / 强弱 / 标签组）单列一节 */
.rel-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.rel-list li{
  display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;padding:7px 10px;
  border:1px solid var(--line);border-radius:7px;background:#fbfaf6;font-size:13px;
  break-inside:avoid;
}
.rel-list a{color:var(--text);text-decoration:none;font-weight:600}
.rel-arrow{color:var(--faint)}
.rel-marks{display:inline-flex;flex-wrap:wrap;gap:5px;align-items:baseline;margin-left:auto}
.rel-kind,.rel-tag{
  padding:1px 7px;border-radius:9px;border:1px solid var(--line);
  background:#f2efe8;color:var(--dim);font-size:11.5px;
}
.rel-tag::before{content:"#";opacity:.55}
.rel-label{color:var(--dim);font-size:12.5px}
.rel-weight{letter-spacing:1px;font-size:10.5px;color:var(--dim)}
.note{margin:0 0 9px;color:var(--dim);font-size:12.5px}
.meta{margin:0 0 8px;display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.chip{
  display:inline-block;padding:1px 7px;border-radius:9px;border:1px solid var(--line);
  background:#f8f6f1;color:var(--dim);font-size:11.5px;line-height:1.6;
}
.chip.badge{border-color:#d6d9e8;background:#eef0fa;color:#4a4f88}

/* 规格卡 */
.dc-kicker{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:9px;padding-bottom:8px;border-bottom:1px dashed var(--line)}
.dc-spec{font-size:11.5px;font-weight:650;color:#4a4f88;background:#eef0fa;border-radius:5px;padding:1px 7px}
.dc-spec.off{color:#8a5a3a;background:#f7efe6}
.dc-sub{font-size:12.5px;color:var(--dim)}
.dc-body{margin-bottom:10px}
table.fields{border-collapse:collapse;width:100%;font-size:12.8px;margin:0 0 8px}
table.fields th{
  width:5.6em;padding:5px 10px 5px 0;text-align:left;vertical-align:top;
  color:var(--faint);font-weight:600;white-space:nowrap;
}
table.fields td{padding:5px 0;vertical-align:top;border-bottom:1px solid var(--line-soft);word-break:break-word}
table.fields tr:last-child td{border-bottom:none}
table.fields .pre{margin:0}
table.sub{border-collapse:collapse;width:100%;font-size:12px;margin:2px 0}
table.sub th,table.sub td{border:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top}
table.sub th{background:#f6f4ee;color:var(--dim);font-weight:600}
.dc-foot{margin-top:8px;padding-top:7px;border-top:1px solid var(--line-soft);font-size:11.5px;color:var(--faint)}

/* 图 / 图片 */
.figure{margin:0 0 10px;padding:10px;border:1px solid var(--line-soft);border-radius:8px;background:#fdfdfb;text-align:center;overflow:auto}
.figure img,.figure svg{max-width:100%;height:auto}

/* 清单 / 资料 / 导图 */
ul.todo,ul.refs{list-style:none;margin:0;padding:0}
ul.todo li{display:flex;gap:7px;align-items:baseline;padding:2px 0}
ul.todo li.done{color:var(--faint);text-decoration:line-through}
ul.todo .box{
  flex:none;width:14px;height:14px;border:1px solid var(--line);border-radius:4px;
  font-size:10px;line-height:13px;text-align:center;color:#3da169;background:#fff;
}
ul.refs li{padding:6px 0;border-bottom:1px solid var(--line-soft)}
ul.refs li:last-child{border-bottom:none}
ul.refs p{margin:3px 0 0;font-size:12.5px}
ul.mm,ul.mm ul{list-style:none;margin:0;padding:0}
ul.mm ul{margin-left:9px;padding-left:11px;border-left:1px solid var(--line)}
.mm-node>span{display:inline-block;padding:2px 0;line-height:1.6}
.mm-node.d0>span{font-weight:700;font-size:14.5px}
.mm-node.d1>span{font-weight:620}
.mm-node.d2>span,.mm-node.d3>span,.mm-node.d4>span{color:var(--dim)}

blockquote{margin:0 0 8px;padding:2px 0 2px 12px;border-left:3px solid var(--accent)}
.quote-src{margin:0;text-align:right;font-size:12.5px;color:var(--faint)}
.link-line{margin:0 0 6px;word-break:break-all}

.book{display:flex;gap:12px;align-items:flex-start}
.book-cover{flex:none;width:88px;border-radius:5px;border:1px solid var(--line)}
.book-main{min-width:0;flex:1}
.book-main h4{margin:0 0 4px;font-size:14px}

/* 评论 */
.comments{margin-top:11px;padding-top:9px;border-top:1px dashed var(--line)}
.comments-label{font-size:11.5px;color:var(--faint)}
.comments ul{list-style:none;margin:5px 0 0;padding:0}
.comments li{padding:6px 0 6px 9px;border-left:2px solid #e7c98d;margin-bottom:5px}
.comments li.resolved{border-left-color:var(--line);color:var(--faint)}
.comments p{margin:2px 0 0;font-size:12.8px}
.comments .reply{margin-left:9px;color:var(--dim)}
.comments .dim{font-size:11px;margin:0}

.doc-foot{margin-top:42px;padding-top:14px;border-top:1px solid var(--line);font-size:11.5px;color:var(--faint)}

.copy-btn{
  position:absolute;top:6px;right:6px;padding:1px 8px;cursor:pointer;
  border:1px solid var(--line);border-radius:5px;background:#fff;color:var(--faint);
  font:inherit;font-size:11px;opacity:0;transition:opacity .12s;
}
pre:hover .copy-btn{opacity:1}

@media (max-width:900px){
  .doc{grid-template-columns:minmax(0,1fr)}
  .toc{position:static;height:auto;border-right:none;border-bottom:1px solid var(--line)}
  .toc-sub{display:block}
  main{padding:0 18px 40px}
  .cover{padding-top:26px}
}

/* ── 打印：A4，一列，卡片不跨页 ──
   打印时刻意收成单列。多列网格 + 分页在各家浏览器里表现不一，
   而这份文件存在的理由就是「换台机器印出来还是一样」。 */
@page{size:A4;margin:15mm 14mm}
@media print{
  body{background:#fff;font-size:10.5pt}
  .progress,.toc,.toc-filter,.copy-btn{display:none !important}
  .doc{display:block;max-width:none}
  main{padding:0}
  .grid{display:block}
  .card{
    margin:0 0 8mm;break-inside:avoid;page-break-inside:avoid;
    border-color:#d8d4ca;border-radius:6px;
  }
  .sec{padding-top:6mm;break-before:auto}
  .sec-head{break-after:avoid;page-break-after:avoid}
  .cover{padding:0 0 8mm;break-after:page;page-break-after:always}
  .cover.board-cover{border-top:none;break-before:page;page-break-before:always}
  .figure,table.fields,table.sub,.comments{break-inside:avoid;page-break-inside:avoid}
  a{color:inherit;text-decoration:none}
  .card,.card-idx,.chip,.dc-spec,.figure,.md pre,pre.code,table.sub th,table.fields{
    -webkit-print-color-adjust:exact;print-color-adjust:exact;
  }
}
`;

/* ── 8. 一点点脚本：目录联动 / 过滤 / 复制 ─────────
   产物是死的 HTML，这段脚本只做导航体验，删掉也不影响内容与打印。 */
const DOC_JS = `
(function(){
  var toc = document.querySelector('.toc');
  var bar = document.querySelector('.progress i');

  document.querySelectorAll('.toc-toggle').forEach(function(button){
    button.addEventListener('click', function(){
      var section = button.closest('.toc-sec');
      var open = section.classList.toggle('open');
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  /* 滚到哪，目录里就亮哪一条 */
  var links = {};
  document.querySelectorAll('.toc a[href^="#"]').forEach(function(anchor){
    links[decodeURIComponent(anchor.getAttribute('href').slice(1))] = anchor;
  });
  var current = null;
  var observer = new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if (!entry.isIntersecting) return;
      var anchor = links[entry.target.id];
      if (!anchor || anchor === current) return;
      if (current) current.classList.remove('on');
      anchor.classList.add('on');
      current = anchor;
      var section = anchor.closest('.toc-sec');
      if (section && !section.classList.contains('open')) {
        var head = section.querySelector('.toc-toggle');
        section.classList.add('open');
        if (head) head.setAttribute('aria-expanded','true');
      }
      if (toc && toc.scrollHeight > toc.clientHeight) {
        var box = anchor.getBoundingClientRect();
        var frame = toc.getBoundingClientRect();
        if (box.top < frame.top + 40 || box.bottom > frame.bottom - 40) {
          anchor.scrollIntoView({ block: 'center' });
        }
      }
    });
  }, { rootMargin: '-15% 0px -70% 0px' });
  document.querySelectorAll('.card, .sec').forEach(function(node){ if (node.id) observer.observe(node); });

  /* 目录过滤：102 张卡的板，翻目录不如打两个字 */
  var filter = document.querySelector('.toc-filter');
  if (filter) filter.addEventListener('input', function(){
    var q = filter.value.trim().toLowerCase();
    document.querySelectorAll('.toc-sec').forEach(function(section){
      var items = section.querySelectorAll('.toc-sub li');
      var hits = 0;
      items.forEach(function(item){
        var hit = !q || item.textContent.toLowerCase().indexOf(q) >= 0;
        item.classList.toggle('hide', !hit);
        if (hit) hits++;
      });
      var head = section.querySelector('.toc-sec-head a');
      var titleHit = !q || (head && head.textContent.toLowerCase().indexOf(q) >= 0);
      section.classList.toggle('hide', !!q && !hits && !titleHit);
      if (q) section.classList.add('open');
    });
  });

  /* 代码块一键复制：画板上的「做法」多半是能直接抄走的提示词 */
  document.querySelectorAll('pre').forEach(function(pre){
    var button = document.createElement('button');
    button.className = 'copy-btn';
    button.type = 'button';
    button.textContent = '复制';
    button.addEventListener('click', function(){
      var text = pre.innerText.replace(/复制$/, '');
      if (navigator.clipboard) navigator.clipboard.writeText(text);
      button.textContent = '已复制';
      setTimeout(function(){ button.textContent = '复制'; }, 1400);
    });
    pre.appendChild(button);
  });

  function progress(){
    if (!bar) return;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0) + '%';
  }
  window.addEventListener('scroll', progress, { passive: true });
  progress();
})();
`;
