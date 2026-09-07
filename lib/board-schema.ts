/**
 * 画板数据校验 / 归一化（公共部分 + 按类型分派）。
 *
 * 沿用上一代画板服务的校验口径：上限、clamp 区间、错误文案逐字对齐，是**逐条移植**
 * 而不是重写——存量数据是照那套规则写出来的，换一套等价物就会有行为漂移。
 * 之所以不换成 zod：这些规则是「强制 clamp + 兜底」而不是「校验后拒绝」，
 * zod 的表达重心在后者，硬套只会让每个字段都挂一个 transform。
 *
 * **卡片包化之后**（OPEN-SOURCE-PLAN §3.2 / §3.3）：
 *  · 各类型的专属字段归一化拆进 cards/&lt;type&gt;/schema.ts，这里只保留公共字段
 *    （id / 几何 / 颜色 / 标题 / 正文 / agentPrompt）与按 type 的分派；
 *  · 旧的 normalize*Field 从各包 re-export，导入路径不变；
 *  · **透传铁律（兼容五铁律之一）**：数据里出现代码里没有的 type 时，专属字段
 *    **原样透传、只存不洗**——「读板 → 保存 → 再读」逐字节保住，关掉 / 缺失一个包
 *    绝不毁数据。老行为（不认识的 type 一律当 text、未知字段清洗掉）就是最容易踩的坑。
 */
import {
  BOARD_CARD_TYPES,
  CARD_COLORS,
  CONTEXT_MODES,
  MAX_BOARD_GROUP,
  EDGE_KINDS,
  type BoardCard,
  type BoardComment,
  type BoardSettings,
  COMMENT_TARGETS,
  type CommentReply,
  type CommentTarget,
  type ContextMode,
  EDGE_STYLES,
  type EdgeKind,
  type EdgeStyle,
  type IssueContextPolicy,
  ISSUE_SYNC_MODES,
  type IssueSyncMode,
  type CardColor,
  type CardReading,
  type CardType,
  type Viewport,
} from "./types";
import { ApiError, badRequest, notFound } from "./http";
import { serverPack } from "./card-registry";
import { CARD_META_BY_TYPE } from "./card-metas";
import {
  assertEnumValue,
  MAX_AGENT_PROMPT,
  MAX_CONTENT,
  MAX_TITLE,
  CARD_ID_RE,
  COMMENT_ID_RE,
  COMMENT_REPLY_ID_RE,
  EDGE_ID_RE,
  BOARD_ID_RE,
  MAX_NAME,
  MAX_EDGE_TAG,
  MAX_EDGE_TAGS,
  clampNumber,
  cleanText,
  newId,
} from "./normalize-base";

/* ── 原语与各包归一化的 re-export：旧导入路径全部保持可用 ── */
export {
  assertEnumValue,
  BOARD_ID_RE,
  CARD_ID_RE,
  EDGE_ID_RE,
  COMMENT_ID_RE,
  COMMENT_REPLY_ID_RE,
  UPLOAD_ID_RE,
  MAX_AGENT_PROMPT,
  MAX_TITLE,
  MAX_CONTENT,
  MAX_NAME,
  MAX_EDGE_LABEL,
  MAX_EDGE_TAG,
  MAX_EDGE_TAGS,
  MAX_DIAGRAM_SOURCE,
  newId,
  clampNumber,
  cleanText,
} from "./normalize-base";
export { normalizeTaskField } from "@/cards/task/schema";
export { normalizeLinkField } from "@/cards/link/schema";
export { normalizeQuoteField } from "@/cards/quote/schema";
export { normalizeFileField } from "@/cards/image/schema";
export { normalizeRefField, MAX_REF_ITEMS } from "@/cards/ref/schema";
export { normalizeBookField } from "@/cards/book/schema";
export { normalizeBoardRefField } from "@/cards/board/schema";
export { normalizeMindmapField, MAX_MIND_NODES } from "@/cards/mindmap/schema";
export { normalizeTodoField, MAX_TODO_ITEMS } from "@/cards/todo/schema";
export { normalizeSvgField } from "@/cards/svg/schema";
export { normalizeMermaidField } from "@/cards/mermaid/schema";
export { normalizeHtmlField, MAX_EMBED_FRAME } from "@/cards/html/schema";
export { normalizeCodeField, MAX_CODE_SOURCE } from "@/cards/code/schema";
export { normalizeTableField, tableToMarkdown, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from "@/cards/table/schema";
export { normalizeChartField, MAX_CHART_POINTS } from "@/cards/chart/schema";
export { normalizeExcalidrawField } from "@/cards/excalidraw/schema";
export { normalizeDataField, dataCardTitle } from "@/cards/data/schema";
export { MAX_EXCALIDRAW_SOURCE, MAX_EXCALIDRAW_THUMBNAIL } from "./constants";

/** 一条评论的正文上限：评论是「一句提示」，要写长文该开一张卡 */
export const MAX_COMMENT = 2000;
/** 一条评论下最多挂多少回复；再多说明该把它变成任务卡了 */
export const MAX_COMMENT_REPLIES = 100;
/** 一块板最多存多少条评论：防住脚本刷爆单块板的文件 */
export const MAX_BOARD_COMMENTS = 1000;

/** 空标题卡片的兜底标题——从卡片包注册表派生（真源在 cards/&lt;type&gt;/meta.ts）。 */
export const TYPE_FALLBACK_TITLE: Record<CardType, string> = Object.fromEntries(
  Object.entries(CARD_META_BY_TYPE).map(([type, meta]) => [type, meta.fallbackTitle]),
) as Record<CardType, string>;

/** 连线语义；老数据没有 kind，缺省 rel（向后兼容，不需要迁移）。 */
export function normalizeEdgeKind(value: unknown): EdgeKind {
  const kind = String(value || "");
  return (EDGE_KINDS as readonly string[]).includes(kind) ? (kind as EdgeKind) : "rel";
}

/** 连线外观三件套：都允许 null = 「跟随语义」，所以 undefined 与 null 要分开处理。 */
export function normalizeEdgeColor(value: unknown): CardColor | null {
  const color = String(value ?? "");
  return (CARD_COLORS as readonly string[]).includes(color) ? (color as CardColor) : null;
}

export function normalizeEdgeStyle(value: unknown): EdgeStyle | null {
  const style = String(value ?? "");
  return (EDGE_STYLES as readonly string[]).includes(style) ? (style as EdgeStyle) : null;
}

export function normalizeEdgeWidth(value: unknown): number | null {
  const width = Math.round(Number(value));
  return width >= 1 && width <= 3 ? width : null;
}

/**
 * 关系强弱 1-5。跟 width 一样「null = 没标过」，所以取不到值时返回 null 而不是兜底成 3——
 * 「没标」与「标成中等」是两件事，前者不该被算法当成用户的判断。
 */
export function normalizeEdgeWeight(value: unknown): number | null {
  const weight = Math.round(Number(value));
  return weight >= 1 && weight <= 5 ? weight : null;
}

/**
 * 连线标签：去空、去重、截断、限量。
 *
 * 返回 `string[]`（空数组而不是 undefined）——落库形状统一，前端不用到处判空。
 * 非数组输入（agent 写成 `"a,b"` 这种）**不做拆分兜底**：建卡严的口径是
 * 「同一份数据只有一种真形状」，静默接受第二种写法只会让两种写法都长期活着。
 */
export function normalizeEdgeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const item of value) {
    const tag = cleanText(item, MAX_EDGE_TAG, { fallback: "" });
    if (!tag || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= MAX_EDGE_TAGS) break;
  }
  return tags;
}

/**
 * 归属哪个分组框。**只管形状**（合法的卡片 id 或 null）——
 * 「这个 id 在这块板上真的是一张 frame 卡吗」得看整块板，那是 board-service 的活
 * （assertFrameRef / pruneFrameLinks），这里拿不到板。
 */
export function normalizeFrameId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const id = String(value);
  return CARD_ID_RE.test(id) ? id : null;
}

/**
 * 阅读例外（公共字段）：**没设过就不留字段**，board.json 里也就不会平白多出一层
 * `"reading": {}`。传 `null` / `{}` = 显式清掉例外，回到「完全按摆放位置读」。
 */
export function normalizeCardReading(value: unknown): CardReading | undefined {
  if (value === null || value === undefined || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const reading: CardReading = {};
  if (raw.skip === true) reading.skip = true;
  const order = Number(raw.order);
  // 序号只认有限整数；范围跟坐标同量级就够了（它只用来排序，不参与几何）
  if (raw.order !== null && raw.order !== undefined && raw.order !== "" && Number.isFinite(order)) {
    reading.order = Math.round(Math.min(1e6, Math.max(-1e6, order)));
  }
  return reading.skip || reading.order !== undefined ? reading : undefined;
}

export const DEFAULT_ISSUE_CONTEXT: IssueContextPolicy = { mode: "neighbors", types: [] };

export function normalizeIssueContext(input: unknown, prev: IssueContextPolicy = DEFAULT_ISSUE_CONTEXT): IssueContextPolicy {
  const raw = (input ?? {}) as Record<string, unknown>;
  const mode = (CONTEXT_MODES as readonly string[]).includes(String(raw.mode)) ? (raw.mode as ContextMode) : prev.mode;
  const rawTypes = Array.isArray(raw.types) ? raw.types : prev.types;
  const types = [...new Set(rawTypes.filter((type): type is (typeof BOARD_CARD_TYPES)[number] => BOARD_CARD_TYPES.includes(type as never)))];
  return { mode, types };
}

export function normalizeIssueSyncMode(input: unknown, prev: IssueSyncMode = "auto"): IssueSyncMode {
  return (ISSUE_SYNC_MODES as readonly string[]).includes(String(input)) ? (input as IssueSyncMode) : prev;
}

export function normalizeBoardSettings(input: unknown, prev?: BoardSettings): BoardSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    issueContext: normalizeIssueContext(raw.issueContext, prev?.issueContext || DEFAULT_ISSUE_CONTEXT),
    issueSync: normalizeIssueSyncMode(raw.issueSync, prev?.issueSync || "auto"),
  };
}

export function normalizeViewport(input: unknown, prev: Viewport = { x: 0, y: 0, zoom: 1 }): Viewport {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    x: clampNumber(raw.x, -1e7, 1e7, prev.x),
    y: clampNumber(raw.y, -1e7, 1e7, prev.y),
    zoom: clampNumber(raw.zoom, 0.1, 4, prev.zoom, { round: false }),
  };
}

/* ── 卡片：公共字段 + 按类型分派 ─────────────────── */

/** BoardCard 的公共字段名：透传未知类型时，这些照常收敛，其余原样保留。 */
const COMMON_CARD_KEYS = new Set([
  "id", "type", "createdAt", "updatedAt", "createdBy", "x", "y", "w", "h", "z",
  "color", "title", "content", "agentPrompt", "frameId", "reading",
]);

/**
 * 透传铁律的落点：未知 type 的卡片，公共字段照常 clamp / 清洗，
 * **专属字段一律原样透传、只存不洗**。「读板 → 保存 → 再读」必须逐字节保住。
 */
export function passthroughCard(input: Record<string, any>, type: string): BoardCard {
  const card = {
    id: CARD_ID_RE.test(String(input.id || "")) ? String(input.id) : newId("c"),
    type: type as CardType,
    createdAt: clampNumber(input.createdAt, 0, Date.now() + 60_000, Date.now()),
    createdBy: input.createdBy === "agent" ? "agent" : "user",
    x: clampNumber(input.x, -100_000, 100_000, 80),
    y: clampNumber(input.y, -100_000, 100_000, 80),
    w: clampNumber(input.w, 140, 1600, 300),
    h: clampNumber(input.h, 80, 2400, 180),
    z: clampNumber(input.z, 0, 100_000, 1),
    color: (CARD_COLORS.includes(input.color) ? input.color : "slate") as CardColor,
    title: cleanText(input.title, MAX_TITLE, { fallback: "" }),
    content: cleanText(input.content, MAX_CONTENT, { fallback: "" }),
    agentPrompt: cleanText(input.agentPrompt, MAX_AGENT_PROMPT, { fallback: "" }),
    // 分组归属是公共字段：未知类型的卡也能被圈进框里，所以这里照常收敛（不走透传）
    frameId: normalizeFrameId(input.frameId),
  } as BoardCard;
  // 阅读例外同理：公共字段，未知类型的卡也读得到（没设就干脆不留这个键）
  const passthroughReading = normalizeCardReading(input.reading);
  if (passthroughReading) card.reading = passthroughReading;
  // 往返无损：updatedAt 也留住（已知类型走 whole 时由服务端重算，这里没有包，不敢丢）
  if (Number.isFinite(Number(input.updatedAt)) && Number(input.updatedAt) > 0) {
    card.updatedAt = Number(input.updatedAt);
  }
  for (const [key, value] of Object.entries(input)) {
    if (COMMON_CARD_KEYS.has(key)) continue;
    (card as unknown as Record<string, unknown>)[key] = value;
  }
  return card;
}

export interface NormalizeCardOptions {
  existing?: BoardCard | null;
  uploadsDir?: string;
  /**
   * 「建卡严」开关：单卡 POST / PATCH 传 true——公共枚举字段（color）与卡片包自己的
   * 枚举字段（task.status / task.priority）收到非法值就 400，不再静默兜底。
   * whole / 粘贴 / 信封是「收卡宽」的路，不传（默认 false），行为一个字不变。
   */
  strict?: boolean;
}

/**
 * 字段名陷阱点名：image / media / pdf 卡的文件字段是 **`file.uploadId`**，不是 `image.uploadId`。
 *
 * 调用方（尤其是 agent）几乎必然先写 `{"type":"image","image":{"uploadId":"…"}}`——
 * 名字对上了，直觉上就该是它。老行为是那个键被默默忽略，然后报「必须提供 file.uploadId」
 * 或者建出一张空卡：两条路都让人以为是上传出了问题，去反复重传文件。
 *
 * 只在**已知类型**上拦（未知类型走透传铁律，它的字段原样存、不许我们瞎猜），
 * 也不做静默别名接收——「建卡严」要求同一份数据只有一种真形状。
 */
function assertNoFileFieldAlias(input: Record<string, any>): void {
  for (const key of ["image", "media", "pdf"] as const) {
    const value = input[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (!("uploadId" in value)) continue;
    throw badRequest(
      `${key} 卡的文件字段是 \`file.uploadId\`（不是 ${key}.uploadId）：` +
        "文件要先 POST /api/uploads（二进制 body + x-file-name 头）拿 uploadId，" +
        `再建卡 \`{"type":"${key}","file":{"uploadId":"…"}}\``,
    );
  }
}

/**
 * 新建：全量归一化（缺省值补齐），专属字段交给对应卡片包的 schema.onCreate。
 * 部分更新（existing 非空）：只动白名单字段，支持 type 互转（agent 常用：想法文本卡 → 任务卡）。
 * 未知 type：走透传（见上）——这里**不**做「未启用 400」的闸门，那是新建接口
 * （board-service.createCard）的规矩；whole / 粘贴 / 信封是「收卡宽」的路。
 */
export function normalizeCardInput(input: Record<string, any> = {}, options: NormalizeCardOptions = {}): BoardCard {
  const { existing = null, uploadsDir, strict = false } = options;
  const ctx = { uploadsDir, strict };
  // color 是**公共字段**，未知类型也照常校验（透传铁律管的是类型专属字段，不是它）
  if (strict) assertEnumValue(input.color, CARD_COLORS, "color", { hint: "不传 / null = 用这类卡的默认色" });

  if (!existing) {
    // 没给 type 仍默认 text（与老行为一致）；给了但代码里没有 → 透传，不再硬掰成 text
    const rawType = input.type === undefined || input.type === null || input.type === "" ? "text" : String(input.type);
    const pack = serverPack(rawType);
    if (!pack) return passthroughCard(input, rawType);
    assertNoFileFieldAlias(input);
    const type = rawType as CardType;
    const card: BoardCard = {
      // whole 全量替换会带原 id 回来；合法即保留，避免前端引用失效
      id: CARD_ID_RE.test(String(input.id || "")) ? String(input.id) : newId("c"),
      type,
      // 撤销删除 / whole 全量替换会把原来的建卡时间带回来：认它，
      // 否则「按创建时间排」的地方（导航页、阅读顺序）会把恢复出来的卡当成新卡排到最前
      createdAt: clampNumber(input.createdAt, 0, Date.now() + 60_000, Date.now()),
      createdBy: input.createdBy === "agent" ? "agent" : "user",
      x: clampNumber(input.x, -100_000, 100_000, 80),
      y: clampNumber(input.y, -100_000, 100_000, 80),
      w: clampNumber(input.w, 140, 1600, pack.meta.defaultW ?? 300),
      h: clampNumber(input.h, 80, 2400, pack.meta.defaultH ?? 180),
      z: clampNumber(input.z, 0, 100_000, 1),
      color: (CARD_COLORS.includes(input.color) ? input.color : "slate") as CardColor,
      title: cleanText(input.title, MAX_TITLE, { fallback: "" }),
      content: cleanText(input.content, MAX_CONTENT, { fallback: "" }),
      agentPrompt: cleanText(input.agentPrompt, MAX_AGENT_PROMPT, { fallback: "" }),
      frameId: normalizeFrameId(input.frameId),
    };
    const reading = normalizeCardReading(input.reading);
    if (reading) card.reading = reading;
    pack.schema.onCreate?.(card, input, ctx);
    return card;
  }

  const card: BoardCard = { ...existing };
  const patch = input;

  // 字段名陷阱先拦：不然「PATCH {type:"image", image:{uploadId}}」会先撞 beforeConvert 的
  // 「必须提供 file.uploadId」，调用方还是不知道自己那个键写错在哪
  if (serverPack(patch.type !== undefined && BOARD_CARD_TYPES.includes(patch.type) ? patch.type : card.type)) {
    assertNoFileFieldAlias(patch);
  }

  // 类型互转：类型专属字段按新类型重建，公共字段（title/content/几何/颜色）保留。
  // 互转白名单仍是全部原生类型——「转成一个本机没有的类型」没有意义。
  if (patch.type !== undefined && patch.type !== card.type && BOARD_CARD_TYPES.includes(patch.type)) {
    const nextType = patch.type as CardType;
    const nextPack = serverPack(nextType)!;
    nextPack.schema.beforeConvert?.(card, patch, ctx);
    card.type = nextType;
    nextPack.schema.onConvert?.(card, patch, ctx);
  }

  if (patch.title !== undefined) card.title = cleanText(patch.title, MAX_TITLE);
  if (patch.content !== undefined) card.content = cleanText(patch.content, MAX_CONTENT);
  if (patch.agentPrompt !== undefined) card.agentPrompt = cleanText(patch.agentPrompt, MAX_AGENT_PROMPT);
  if (patch.x !== undefined) card.x = clampNumber(patch.x, -100_000, 100_000, card.x);
  if (patch.y !== undefined) card.y = clampNumber(patch.y, -100_000, 100_000, card.y);
  if (patch.w !== undefined) card.w = clampNumber(patch.w, 140, 1600, card.w);
  if (patch.h !== undefined) card.h = clampNumber(patch.h, 80, 2400, card.h);
  if (patch.z !== undefined) card.z = clampNumber(patch.z, 0, 100_000, card.z);
  if (patch.color !== undefined && CARD_COLORS.includes(patch.color)) card.color = patch.color;
  // 传 null = 从框里拿出来（与 color 一样是公共字段，不归任何卡片包管）
  if (patch.frameId !== undefined) card.frameId = normalizeFrameId(patch.frameId);
  // 阅读例外：传 null / {} = 清掉例外（字段整个删掉，不留一层空壳）
  if (patch.reading !== undefined) {
    const reading = normalizeCardReading(patch.reading);
    if (reading) card.reading = reading;
    else delete card.reading;
  }

  // 类型专属字段只写给对应类型的卡片：往文本卡上糊一个 task/svg 字段没有意义，
  // 还会留下永远读不到的脏数据（调用方拿不准卡片类型时会把几个字段一起发过来）。
  // 分派给当前类型的包；未知类型没有包 → 补丁里的专属字段原样合入（只存不洗）。
  const pack = serverPack(card.type);
  if (pack) {
    pack.schema.onPatch?.(card, patch, ctx);
  } else {
    for (const [key, value] of Object.entries(patch)) {
      if (COMMON_CARD_KEYS.has(key)) continue;
      (card as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return card;
}

export function normalizeBoardGroup(value: unknown): string {
  return cleanText(value, MAX_BOARD_GROUP);
}

export function normalizeParentId(value: unknown): string | null {
  const id = cleanText(value, 60);
  if (!id) return null;
  if (!BOARD_ID_RE.test(id)) throw badRequest("parentId 无效");
  return id;
}

export function assertBoardId(id: string): string {
  if (!BOARD_ID_RE.test(id || "")) throw new ApiError("画板 id 无效", 400);
  return id;
}

export function normalizeBoardName(value: unknown): string {
  const name = cleanText(value, MAX_NAME, { fallback: "" });
  if (!name) throw badRequest("画板名称不能为空");
  return name;
}

/* ── 评论 ─────────────────────────────────────────── */

/** 坐标可以「没有」（整板留言不钉在画布上），所以不能直接套 clampNumber 的兜底。 */
function normalizeCommentCoord(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(Math.min(100_000, Math.max(-100_000, num)));
}

export function normalizeCommentReply(input: Record<string, any> = {}): CommentReply {
  const text = cleanText(input.text, MAX_COMMENT, { fallback: "" });
  if (!text) throw badRequest("回复内容不能为空");
  return {
    id: COMMENT_REPLY_ID_RE.test(String(input.id || "")) ? String(input.id) : newId("cr"),
    text,
    createdBy: input.createdBy === "agent" ? "agent" : "user",
    createdAt: Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : Date.now(),
  };
}

export interface NormalizeCommentOptions {
  existing?: BoardComment | null;
  /** 建评论时校验目标存在：挂在已删卡片上的评论没人看得到，等于丢件 */
  cardIds?: Set<string>;
  edgeIds?: Set<string>;
}

export function normalizeCommentInput(
  input: Record<string, any> = {},
  options: NormalizeCommentOptions = {},
): BoardComment {
  const { existing = null, cardIds, edgeIds } = options;

  if (!existing) {
    const target = (COMMENT_TARGETS as readonly string[]).includes(input.target)
      ? (input.target as CommentTarget)
      : "board";
    const text = cleanText(input.text, MAX_COMMENT, { fallback: "" });
    if (!text) throw badRequest("评论内容不能为空");

    let targetId: string | null = null;
    if (target === "card") {
      targetId = String(input.targetId || "");
      if (!CARD_ID_RE.test(targetId)) throw badRequest("targetId 必须是卡片 id");
      if (cardIds && !cardIds.has(targetId)) throw notFound("评论指向的卡片不存在");
    } else if (target === "edge") {
      targetId = String(input.targetId || "");
      if (!EDGE_ID_RE.test(targetId)) throw badRequest("targetId 必须是连线 id");
      if (edgeIds && !edgeIds.has(targetId)) throw notFound("评论指向的连线不存在");
    }

    const now = Date.now();
    return {
      id: COMMENT_ID_RE.test(String(input.id || "")) ? String(input.id) : newId("cm"),
      target,
      targetId,
      x: normalizeCommentCoord(input.x),
      y: normalizeCommentCoord(input.y),
      text,
      createdBy: input.createdBy === "agent" ? "agent" : "user",
      createdAt: now,
      updatedAt: now,
      resolved: input.resolved === true,
      resolvedAt: input.resolved === true ? now : null,
      replies: Array.isArray(input.replies)
        ? input.replies.slice(0, MAX_COMMENT_REPLIES).map((reply: Record<string, any>) => normalizeCommentReply(reply))
        : [],
    };
  }

  const comment: BoardComment = { ...existing, replies: [...(existing.replies || [])] };
  const patch = input;
  if (patch.text !== undefined) {
    const text = cleanText(patch.text, MAX_COMMENT, { fallback: "" });
    if (!text) throw badRequest("评论内容不能为空");
    comment.text = text;
  }
  if (patch.resolved !== undefined) {
    const resolved = patch.resolved === true;
    // 反复标同一个状态不该刷新时间戳：解决时间要留住「什么时候拍板的」
    if (resolved !== comment.resolved) {
      comment.resolved = resolved;
      comment.resolvedAt = resolved ? Date.now() : null;
    }
  }
  // 目标不给改：换目标等于换一条评论，让调用方删了重建，免得评论悄悄挪到别的卡上
  if (patch.x !== undefined) comment.x = normalizeCommentCoord(patch.x);
  if (patch.y !== undefined) comment.y = normalizeCommentCoord(patch.y);
  comment.updatedAt = Date.now();
  return comment;
}
