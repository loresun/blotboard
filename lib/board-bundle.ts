/**
 * 画板包（Board Bundle）：把一块或多块画板整份带走 / 带回来的**唯一交换格式**。
 *
 * 与已有的两种导出分工——它们各自解决另一半问题，不互相替代：
 *  · `?format=cards`（卡片信封 lib/card-ingest.ts）是**卡片级**的交换：一批卡片摊成
 *    「规格 + 字段」，对端不用懂画板模型也能读，但它不带画板本身（名字、分组、评论、
 *    视口），也不带本机主键（上传件、子画板）——那是它的设计目标，不是缺陷。
 *  · `?format=json` 是**单块板**的内部结构，改完 PUT 回 whole。
 *  · 这一份是**整块板 / 整批板**：板 + 卡 + 线 + 评论 + 附件字节，换台机器原样立起来。
 *
 * 本文件是**纯计算**（前后端同构，不碰 node:fs）：格式定义、宽进的解析、id 重映射、
 * 与 HTML 载荷的读写。真正落盘的那一半在 lib/board-transfer.ts（服务端）与
 * lib/browser-board-repository.ts（浏览器库）。
 *
 * **宽进严出**：出口永远写新格式；入口认六种形状（新格式 / 浏览器备份 / 单块板 JSON /
 * 板数组 / 只有 boards 字段的对象 / **HTTP 响应包装 `{ok,bundle}`**）——用户手里那份文件
 * 是从哪个口子导出来的，他自己往往并不知道，报一句「格式不对」等于让他去猜。
 *
 * 那层 `{ok,bundle}` 包装尤其要认：`GET /api/boards/export?format=json` 返回的就是它，
 * 而「把响应存成文件」是最顺手的备份方式。以前服务端的导入路由自己剥了一层、浏览器库没剥，
 * 同一份文件一边收一边拒——这种不一致用户没法自查，所以剥在**共享解析入口**里，只留一种口径。
 */
import type { Board, BoardCard, BoardComment, BoardEdge } from "./types";

export const BOARD_BUNDLE_FORMAT = "blotboard.boards";
export const BOARD_BUNDLE_VERSION = 1;
/**
 * 旧的浏览器库备份（`kind: "blotboard-browser-bundle"`）：**照收不误**。
 * 它本来就是 `{ kind, workspace, boards }`，boards 数组一模一样——
 * 所以解析这一侧一个分支都不需要，出口那侧直接停写旧格式即可。
 */
export const LEGACY_BUNDLE_KINDS = ["blotboard-browser-bundle"] as const;

/** 一次能带多少：防的是脚本把整台机器打成一个请求，不是限制正常使用 */
export const BUNDLE_LIMITS = {
  boards: 200,
  /** 打包附件的总字节上限（超了就只留引用，导入时说明缺件） */
  assetBytes: 24 * 1024 * 1024,
} as const;

/**
 * 附件（上传件）：图片 / PDF / 音视频的字节。
 *
 * `data` 是 base64；**缺省表示「这份包里没带字节」**——两种情况都可能：
 * 超了上限没打包，或者这是 HTML 产物（图片字节已经在 `<img data-asset>` 里，
 * 载荷里不必再存第二份，见 extractBundleFromHtml）。
 */
export interface BundleAsset {
  id: string;
  name: string;
  mediaType: string;
  bytes: number;
  data?: string;
}

/** 包里的一块板：就是 Board，去掉服务端单向写的 activity（换台机器它没有意义）。 */
export type BundleBoard = Omit<Board, "activity">;

/**
 * 分卷标记：**这份包只是整套备份的第几份**。
 *
 * 单包的板数是有上限的（BUNDLE_LIMITS.boards），而一个库轻易就能超过它。以前的做法是
 * 攒到上限就停、HTTP 仍然 200 —— 用户拿到的是一份「看着成功」的残缺备份，
 * 而备份残不残缺，只有真的去恢复那天才会知道。现在超限一律分卷：每一卷都是**完整可导入**
 * 的画板包，卷上写清自己是第几卷、一共几卷、整套一共多少块板，少拿一卷当场看得出来。
 */
export interface BundleVolume {
  /** 第几卷（从 1 数） */
  index: number;
  /** 一共几卷 */
  total: number;
  /** 整套一共多少块板（不是这一卷的板数——那个数 boards.length 就是） */
  totalBoards: number;
}

export interface BoardBundle {
  format: typeof BOARD_BUNDLE_FORMAT;
  version: number;
  exportedAt: number;
  /** 谁导的（`blotboard/<版本>`），出问题时能回溯 */
  generator: string;
  /** 导出这份包的服务地址；只作提示，导入侧不依赖它 */
  origin?: string;
  /** 分卷时才有：缺省 = 这一份就是整套 */
  volume?: BundleVolume;
  boards: BundleBoard[];
  assets?: BundleAsset[];
  /** 导出时就知道的缺憾（附件太大没打包…），原样带给导入侧显示 */
  notes?: string[];
}

/** 攒一份包（纯壳，不碰附件）：服务端与浏览器库共用同一个出口，格式头只有一处写法。 */
export function makeBoardBundle(
  boards: BundleBoard[],
  options: {
    generator?: string;
    origin?: string;
    now?: number;
    assets?: BundleAsset[];
    notes?: string[];
    volume?: BundleVolume;
  } = {},
): BoardBundle {
  return {
    format: BOARD_BUNDLE_FORMAT,
    version: BOARD_BUNDLE_VERSION,
    exportedAt: options.now ?? Date.now(),
    generator: options.generator || "blotboard",
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.volume ? { volume: options.volume } : {}),
    boards,
    ...(options.assets?.length ? { assets: options.assets } : {}),
    ...(options.notes?.length ? { notes: options.notes } : {}),
  };
}

/* ── 解析：宽进 ─────────────────────────────────── */

export class BundleFormatError extends Error {}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 一块板至少要长这样才收：有名字、卡片与连线是数组。 */
function looksLikeBoard(value: unknown): value is BundleBoard {
  if (!isObject(value)) return false;
  return typeof value.name === "string" && Array.isArray(value.cards) && Array.isArray(value.edges);
}

function boardShape(raw: Record<string, any>): BundleBoard {
  return {
    id: /^b_[a-z0-9_]+$/.test(String(raw.id || "")) ? String(raw.id) : "",
    name: String(raw.name || "").slice(0, 60) || "未命名画板",
    parentId: /^b_[a-z0-9_]+$/.test(String(raw.parentId || "")) ? String(raw.parentId) : null,
    group: typeof raw.group === "string" ? raw.group.slice(0, 40) : "",
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now(),
    viewport: isObject(raw.viewport) ? (raw.viewport as BundleBoard["viewport"]) : { x: 0, y: 0, zoom: 1 },
    ...(isObject(raw.settings) ? { settings: raw.settings as BundleBoard["settings"] } : {}),
    cards: (raw.cards as BoardCard[]).filter(isObject),
    edges: (raw.edges as BoardEdge[]).filter(isObject),
    comments: Array.isArray(raw.comments) ? (raw.comments as BoardComment[]).filter(isObject) : [],
  };
}

function assetShape(raw: unknown): BundleAsset | null {
  if (!isObject(raw)) return null;
  const id = String(raw.id || "");
  if (!id) return null;
  return {
    id,
    name: String(raw.name || id).slice(0, 200),
    mediaType: String(raw.mediaType || "").slice(0, 100),
    bytes: Number.isFinite(Number(raw.bytes)) ? Number(raw.bytes) : 0,
    ...(typeof raw.data === "string" && raw.data ? { data: raw.data } : {}),
  };
}

/**
 * 剥掉 HTTP 响应那层壳：`GET /api/boards/export?format=json` 给的是 `{ ok, bundle }`，
 * 而「把响应整个存成文件」是最顺手的备份方式，所以这一层必须两边都认。
 *
 * 只在**外层没有 boards** 时才往里钻：真包自己带 boards，不该被里面某个同名字段带偏。
 * `{ ok:false, error }` 单独点名——那是一次失败的导出，用户存下来的是错误信息不是备份，
 * 不说清楚的话他只会看到一句「找不到画板」，然后去怀疑自己的文件。
 */
function unwrapResponseEnvelope(raw: Record<string, any>): Record<string, any> {
  if (Array.isArray(raw.boards)) return raw;
  if (raw.ok === false && typeof raw.error === "string") {
    throw new BundleFormatError(
      `这份文件存的是一次**失败的导出**（服务端当时回的是：${raw.error.slice(0, 160)}），里面没有画板数据。` +
        "重新导出一份再导入",
    );
  }
  const inner = raw.bundle;
  return isObject(inner) && (Array.isArray(inner.boards) || Array.isArray(inner.cards)) ? inner : raw;
}

function volumeShape(raw: unknown, boardCount: number): BundleVolume | null {
  if (!isObject(raw)) return null;
  const index = Number(raw.index);
  const total = Number(raw.total);
  if (!Number.isFinite(index) || !Number.isFinite(total) || index < 1 || total < 1) return null;
  const totalBoards = Number.isFinite(Number(raw.totalBoards)) ? Number(raw.totalBoards) : boardCount;
  return { index: Math.round(index), total: Math.round(total), totalBoards: Math.round(totalBoards) };
}

/**
 * 认出一份「画板导出」，不管它是从哪个口子出来的。
 *
 * 认的六种形状见文件抬头。认不出时报的是**你手里这份文件像什么**，
 * 而不是干巴巴一句「格式不对」——绝大多数情况是选错了文件（选成了信封 / 截图 / 别家的 JSON）。
 */
export function parseBoardBundle(input: unknown): BoardBundle {
  const outer = isObject(input) ? input : Array.isArray(input) ? { boards: input } : null;
  if (!outer) throw new BundleFormatError("这份内容不是画板导出（既不是对象也不是数组）");
  const raw = unwrapResponseEnvelope(outer);

  // 卡片信封走的是另一条路（POST /api/boards/{id}/ingest），在这里点名说清楚
  if (typeof raw.format === "string" && raw.format.includes("cards")) {
    throw new BundleFormatError(
      "这是一封卡片信封（format=blotboard.cards），不是画板包：它要落到某块已有的板上，" +
        "走 POST /api/boards/{boardId}/ingest",
    );
  }

  const rawBoards: unknown[] = Array.isArray(raw.boards) ? raw.boards : looksLikeBoard(raw) ? [raw] : [];
  if (!rawBoards.length) {
    throw new BundleFormatError(
      "这份内容里找不到画板：画板包应当有 boards 数组，单块板导出应当有 cards / edges 两个数组；" +
        "如果这是一次 API 响应，画板在 bundle 字段里（本服务会自动往里钻一层，钻进去也没有就说明这份文件本身没带板）",
    );
  }
  if (rawBoards.length > BUNDLE_LIMITS.boards) {
    throw new BundleFormatError(
      `一次最多导入 ${BUNDLE_LIMITS.boards} 块画板，这份有 ${rawBoards.length} 块：` +
        "超过上限的库请按分卷导出（每一卷都是完整可导入的包，逐卷导入即可）",
    );
  }
  const boards: BundleBoard[] = [];
  for (const [index, board] of rawBoards.entries()) {
    if (!looksLikeBoard(board)) {
      throw new BundleFormatError(`第 ${index + 1} 块画板的结构无效（缺 name / cards / edges）`);
    }
    boards.push(boardShape(board));
  }

  const assets = Array.isArray(raw.assets)
    ? raw.assets.map(assetShape).filter((asset): asset is BundleAsset => Boolean(asset))
    : [];

  return {
    format: BOARD_BUNDLE_FORMAT,
    version: BOARD_BUNDLE_VERSION,
    exportedAt: Number.isFinite(Number(raw.exportedAt)) ? Number(raw.exportedAt) : Date.now(),
    generator: String(raw.generator || "").slice(0, 100),
    ...(typeof raw.origin === "string" ? { origin: raw.origin.slice(0, 200) } : {}),
    ...((): { volume?: BundleVolume } => {
      const volume = volumeShape(raw.volume, boards.length);
      return volume ? { volume } : {};
    })(),
    boards,
    ...(assets.length ? { assets } : {}),
    ...(Array.isArray(raw.notes) ? { notes: raw.notes.map((note: unknown) => String(note).slice(0, 300)) } : {}),
  };
}

/** 文本入口：JSON 文本或**导出的 HTML**（载荷藏在里面）都能进来。 */
export function parseBoardBundleText(text: string): { bundle: BoardBundle; htmlAssets: Map<string, string> } {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new BundleFormatError("文件是空的");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new BundleFormatError("这份 JSON 解析不了（文件可能被截断了）");
    }
    return { bundle: parseBoardBundle(parsed), htmlAssets: new Map() };
  }
  const embedded = extractBundleFromHtml(trimmed);
  if (!embedded) {
    throw new BundleFormatError(
      "这份 HTML 里没有画板数据：只有本服务「排版导出 · HTML」的产物才带得回来（页面里存着一段画板载荷）",
    );
  }
  return { bundle: parseBoardBundle(embedded.payload), htmlAssets: embedded.assets };
}

/* ── HTML 载荷：让「导出的 HTML」本身就是一份可导入的包 ── */

export const BUNDLE_SCRIPT_ID = "blotboard-bundle";

/**
 * 把包塞进 HTML 产物。
 *
 * 只转义 `<`：JSON 里唯一能提前结束 script 的就是 `</script`（`<!--` 同理），
 * 而 `<` 是合法 JSON 转义，任何解析器都还原得回来。不用 base64——
 * 用户拿编辑器打开产物时，这段还该是看得懂的文本。
 */
export function embedBundleScript(bundle: BoardBundle): string {
  const json = JSON.stringify(bundle).replace(/</g, "\\u003c");
  return `<script type="application/json" id="${BUNDLE_SCRIPT_ID}">${json}</script>`;
}

const BUNDLE_SCRIPT_RE = new RegExp(`<script[^>]*id="${BUNDLE_SCRIPT_ID}"[^>]*>([\\s\\S]*?)</script>`, "i");
/** 排版导出里的图片：`data-asset` 写的是上传件 id，`src` 就是它的字节 */
const HTML_ASSET_RE = /<img[^>]*\sdata-asset="([^"]+)"[^>]*\ssrc="(data:[^"]+)"/gi;

/**
 * 从导出的 HTML 里取回画板载荷与图片字节。
 *
 * 图片**不存第二份**：产物里已经有一份 data URI（读者要看图），载荷里只留引用，
 * 由这里按 `data-asset` 配回去。图多的板不会因为「顺便还能导回来」就翻倍。
 */
export function extractBundleFromHtml(html: string): { payload: unknown; assets: Map<string, string> } | null {
  const match = BUNDLE_SCRIPT_RE.exec(String(html || ""));
  if (!match) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const assets = new Map<string, string>();
  for (const hit of String(html).matchAll(HTML_ASSET_RE)) {
    if (!assets.has(hit[1])) assets.set(hit[1], hit[2]);
  }
  return { payload, assets };
}

/* ── id 重映射：同一份包能往同一台机器上导第二遍 ── */

export interface RemapOptions {
  /** 旧板 id → 新板 id；不在表里的板保持原 id */
  boardIds: Map<string, string>;
  /** 卡片 / 连线也换新 id（「导入为副本」要，「恢复备份」不要） */
  freshIds: boolean;
  newId: (prefix: "c" | "e") => string;
}

/**
 * 把一块板里的全部引用跟着 id 一起搬：连线两端、评论目标、分组框归属、子画板卡指向。
 *
 * 漏一处的后果都是「导进来看着好好的，用起来是散的」——连线连到不存在的卡上会在
 * 落板时被静默丢弃，分组框里的卡会掉出来，子画板卡会指回**导出那台机器**上的板。
 */
export function remapBoards(boards: BundleBoard[], options: RemapOptions): BundleBoard[] {
  const { boardIds, freshIds, newId } = options;
  return boards.map((board) => {
    const cardIds = new Map<string, string>();
    if (freshIds) for (const card of board.cards) cardIds.set(card.id, newId("c"));
    const mapCard = <T extends string | null | undefined>(id: T): T => (id ? ((cardIds.get(id) || id) as T) : id);

    const cards = board.cards.map((card) => {
      const next: BoardCard = { ...card, id: mapCard(card.id) };
      if (card.frameId) next.frameId = mapCard(card.frameId);
      if (card.boardRef?.boardId && boardIds.has(card.boardRef.boardId)) {
        next.boardRef = { ...card.boardRef, boardId: boardIds.get(card.boardRef.boardId)! };
      }
      return next;
    });
    const edges = board.edges.map((edge) => ({
      ...edge,
      id: freshIds ? newId("e") : edge.id,
      from: mapCard(edge.from),
      to: mapCard(edge.to),
    }));
    const comments = (board.comments || []).map((comment) => ({
      ...comment,
      // 连线 id 换过之后，挂在连线上的评论要跟着换，否则落板时会被当成悬空评论剪掉
      targetId:
        comment.target === "card"
          ? mapCard(comment.targetId)
          : comment.target === "edge" && freshIds
            ? edgeIdAt(board.edges, edges, comment.targetId)
            : comment.targetId,
    }));
    return {
      ...board,
      id: boardIds.get(board.id) || board.id,
      parentId: board.parentId ? boardIds.get(board.parentId) || board.parentId : null,
      cards,
      edges,
      comments,
    };
  });
}

/** 连线换 id 时按位置对齐：两个数组同序同长，第 n 条就是第 n 条 */
function edgeIdAt(before: BoardEdge[], after: BoardEdge[], oldId: string | null): string | null {
  if (!oldId) return null;
  const at = before.findIndex((edge) => edge.id === oldId);
  return at >= 0 && after[at] ? after[at].id : null;
}

/** 包里用得到的上传件 id（image / media / pdf 卡；未知类型带 file 字段的也算）。 */
export function bundleUploadIds(boards: BundleBoard[]): string[] {
  const ids = new Set<string>();
  for (const board of boards) {
    for (const card of board.cards) {
      const id = card.file?.uploadId;
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** 导出的文件名：`<分组>-<板名>-<日期>`，多块板时写成「<第一块>等 N 块」。 */
export function bundleFilename(boards: { name: string; group?: string }[], now = Date.now()): string {
  const stamp = new Date(now).toISOString().slice(0, 10);
  const first = boards[0];
  const head = first ? [first.group || "", first.name].filter(Boolean).join("-") : "画板";
  const label = boards.length > 1 ? `${head}等${boards.length}块` : head;
  const cleaned = label.replace(/[\\/:*?"<>| -]+/g, "_");
  const base = [...cleaned].slice(0, 48).join("").trim() || "blotboard";
  return `${base}-${stamp}`;
}
