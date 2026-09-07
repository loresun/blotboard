/**
 * 卡片信封（Card Envelope）：外部系统往画板送卡片的统一入口。
 *
 * 一个信封 = 若干卡片 + 若干连线 + 一点元信息。两条路共用同一套解析：
 *  · `validateEnvelope` 干跑——只解析与报告，不落库。贴一段别人的 JSON 就能看清楚
 *    「解出几张卡、每张卡的字段是什么、哪里不合规」；
 *  · `ingestEnvelope` 落板——同一份解析结果写进画板，一次事务，要么全进要么全不进。
 *
 * 与 lib/board-schema.ts 的分工：那边是「怎么都要收下」（单卡 PATCH 走那条路），
 * 这边是「批量导入要守规矩」——必填缺失、规格停用、未知规格都会被明确拒绝并说清原因。
 */
import { ApiError, badRequest, conflict } from "./http";
import * as store from "./storage";
import { UPLOADS_DIR } from "./config";
import {
  CARD_ID_RE,
  MAX_EDGE_LABEL,
  cleanText,
  newId,
  normalizeCardInput,
  normalizeEdgeColor,
  normalizeEdgeKind,
  normalizeEdgeStyle,
  normalizeEdgeTags,
  normalizeEdgeWeight,
  normalizeEdgeWidth,
} from "./board-schema";
import { boardDetail } from "./board-service";
import { captureCheckpoint } from "./checkpoints";
import { pushActivity } from "./board-activity";
import { scheduleIssueSync } from "./issue-sync";
import { CARD_METAS, cardMetaOf, typeLabelOf } from "./card-metas";
import { isPackEnabled } from "./card-pack-store";
import { findSpec, isEnabled } from "./card-spec-store";
import {
  ENVELOPE_FORMAT,
  ENVELOPE_VERSION,
  LEGACY_ENVELOPE_FORMATS,
  formatFieldValue,
  normalizeSpecValues,
  specCardTitle,
  type CardSpec,
} from "./card-spec-schema";
import type { Board, BoardActor, BoardCard, BoardDetail, BoardEdge, DataValue } from "./types";

/**
 * 信封里允许的原生卡片类型——从卡片包注册表派生（meta.envelope）。
 *
 * 口径是**自包含**：一封信封换一台机器照样能完整重建这张卡。
 * 排除的只有「字段是本机主键」的四种——image / media / pdf 的 `file.uploadId` 是本机上传件的主键，
 * board 的 `boardRef.boardId` 是本机画板的主键，换台机器指向的东西根本不存在。
 * 反过来，book / ref 存的是**元信息快照**（正文在书库 / 知识库），对端没配那两个服务
 * 也只是链接点不开，数据本身一点不少，所以照收（收卡宽）。
 */
export const ENVELOPE_NATIVE_TYPES: readonly string[] = CARD_METAS.filter((meta) => meta.envelope).map((meta) => meta.type);

/**
 * 被信封拒收的类型，得告诉调用方**那该走哪条路**——只说「不能用信封导入」
 * 等于把人扔在原地（真实反馈：agent 撞了这条就卡住了）。
 */
function envelopeRejectHint(type: string): string {
  const tail = `信封收的原生类型：${ENVELOPE_NATIVE_TYPES.join(" / ")}`;
  if (type === "image" || type === "media" || type === "pdf") {
    return (
      `${type} 卡不能走信封（file.uploadId 是本机上传件的主键，换台机器就指不到东西）：` +
      `先 POST /api/uploads（二进制 body + x-file-name 头）拿 uploadId，` +
      `再 POST /api/boards/{boardId}/cards 单张建卡，body \`{"type":"${type}","file":{"uploadId":"…"}}\`。${tail}`
    );
  }
  if (type === "board") {
    return (
      "board（子画板）卡不能走信封（boardRef.boardId 是本机画板的主键）：" +
      "先 POST /api/boards 建出目标画板拿到 b_ 开头的 id，再 POST /api/boards/{boardId}/cards 单张建卡。" +
      tail
    );
  }
  if (type === "data") {
    return `规格卡不写 type=data，改成 \`{"spec":"<规格 id>","fields":{…}}\`（GET /api/card-specs 看有哪些规格）。${tail}`;
  }
  return `原生卡片 type=${type} 不能用信封导入。${tail}`;
}

export const ENVELOPE_LIMITS = {
  cards: 200,
  edges: 400,
  /** 整个信封的字节上限（路由层 readJson 还有一道 1MB） */
  bytes: 1024 * 1024,
} as const;

export type IngestMode = "strict" | "lenient";
export type DuplicatePolicy = "update" | "skip" | "create";

/** 自动布局：没给坐标的卡按这个网格摆 */
const GRID_COLS = 3;
const GRID_GAP_X = 40;
const GRID_GAP_Y = 32;
const INSERT_GAP = 200;

export interface ParsedField {
  key: string;
  label: string;
  /** 人话形式，直接显示 */
  text: string;
  value: DataValue;
}

export interface ParsedCard {
  index: number;
  /** 信封里的本地 id（edges 用它引用），没给就是 null */
  localId: string | null;
  kind: "spec" | "native";
  specId: string;
  specName: string;
  title: string;
  /** 解析后的字段（规格卡才有），给校验预览显示 */
  fields: ParsedField[];
  /** 这张卡为什么不能落板；非空 = 被拒 */
  problems: string[];
  /** 能落板但需要提一句的（字段被丢弃 / 截断 / 未知字段） */
  warnings: string[];
  /** 已经能直接喂 normalizeCardInput 的入参；被拒时为 null */
  payload: Record<string, unknown> | null;
  /** 外部主键，用来判重 */
  externalKey: string | null;
}

export interface ParsedEdge {
  from: string;
  to: string;
  label: string;
  kind: string;
  /** 关系强弱 1-5；null = 信封里没标 */
  weight: number | null;
  /** 关系标签（≤6 个） */
  tags: string[];
  problems: string[];
}

export interface ParsedEnvelope {
  format: string;
  version: number;
  generator: string;
  mode: IngestMode;
  onDuplicate: DuplicatePolicy;
  cards: ParsedCard[];
  edges: ParsedEdge[];
  /** 整封级别的问题（格式头不对、超上限…） */
  problems: string[];
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

/** 一张规格卡的字段摊成「标签 + 人话值」，校验预览与 markdown 导出都用它。 */
export function describeFields(spec: CardSpec | null, fields: Record<string, DataValue>): ParsedField[] {
  if (spec) {
    return spec.fields
      .filter((field) => fields[field.key] !== undefined)
      .map((field) => ({
        key: field.key,
        label: field.label,
        text: formatFieldValue(field, fields[field.key]),
        value: fields[field.key],
      }));
  }
  // 规格不在本机：只能按 key 显示，但至少要能看见内容
  return Object.entries(fields).map(([key, value]) => ({ key, label: key, text: formatFieldValue(null, value), value }));
}

/**
 * 报错定位前缀：`#下标 id=信封内 id（规格 / 类型）`。
 * 一封信封几十张卡，只报「缺必填字段」而不说是哪张，调用方根本对不上号。
 */
function cardWhere(card: ParsedCard): string {
  return `#${card.index}${card.localId ? ` id=${card.localId}` : ""}（${card.specName}）`;
}

/**
 * 干跑一次卡片包的归一化，把「包自己抛的 400」变成**这张卡的 problem**。
 *
 * 为什么要多跑一次：html 的嵌入白名单、book 的 bookId 合法性、excalidraw 的体积上限
 * 都在各包的 normalize 里抛 ApiError。不先在这里接住的话，落板时它会从
 * store.mutateBoard 的事务里穿出去——整封信变成一条没头没脑的 400，
 * 既不知道是第几张卡，lenient 模式下也没法「跳过坏卡、其余照落」。
 * 顺带 `/api/card-specs/validate` 干跑也能提前看见这些问题。
 *
 * 不传 uploadsDir：信封收的类型里没有依赖上传件的（image / pdf 本来就被排除在外），
 * 不传就不会在干跑阶段留下 `.claimed` 之类的副作用。
 */
function dryNormalize(card: ParsedCard): void {
  if (!card.payload) return;
  try {
    normalizeCardInput(card.payload);
  } catch (err) {
    card.problems.push(err instanceof ApiError ? err.message : `字段归一化失败：${String(err)}`);
    // problems 非空 ⇒ payload 必须为 null（ingestEnvelope 按 payload 挑能落的卡）
    card.payload = null;
  }
}

function parseCard(raw: any, index: number): ParsedCard {
  const card: ParsedCard = {
    index,
    localId: null,
    kind: "spec",
    specId: "",
    specName: "",
    title: "",
    fields: [],
    problems: [],
    warnings: [],
    payload: null,
    externalKey: null,
  };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    card.problems.push("不是一个对象");
    return card;
  }

  const localId = cleanText(raw.id, 80);
  if (localId) card.localId = localId;

  const geometry: Record<string, unknown> = {};
  for (const key of ["x", "y", "w", "h", "z"] as const) {
    if (raw[key] !== undefined && Number.isFinite(Number(raw[key]))) geometry[key] = Number(raw[key]);
  }
  const common: Record<string, unknown> = {
    ...geometry,
    createdBy: "agent",
    ...(raw.color ? { color: raw.color } : {}),
    ...(raw.agentPrompt ? { agentPrompt: cleanText(raw.agentPrompt, 4000) } : {}),
  };

  /* 原生卡片：没有 spec 字段、只有 type */
  const specId = cleanText(raw.spec ?? raw.specId, 40);
  if (!specId) {
    const type = cleanText(raw.type, 20);
    if (!type) {
      card.problems.push("既没有 spec（规格 id）也没有 type（原生卡片类型）");
      return card;
    }
    if (!(ENVELOPE_NATIVE_TYPES as readonly string[]).includes(type)) {
      card.problems.push(envelopeRejectHint(type));
      return card;
    }
    // 停用的卡片包：与规格开关同一套语义——strict 整批拒、lenient 跳过这张
    if (!isPackEnabled(type)) {
      card.problems.push(`卡片包「${typeLabelOf(type)}」（${type}）已停用，在卡片中心打开它才能收这类卡片`);
      return card;
    }
    card.kind = "native";
    card.specId = type;
    card.specName = type;
    card.title = cleanText(raw.title, 300);
    // 专属字段按注册表的 fieldKey 透传（原来是手写 8 个三元一组）
    const fieldKey = cardMetaOf(type)?.fieldKey;
    card.payload = {
      ...common,
      type,
      title: card.title,
      content: cleanText(raw.content, 20_000),
      ...(fieldKey && raw[fieldKey] ? { [fieldKey]: raw[fieldKey] } : {}),
    };
    dryNormalize(card);
    return card;
  }

  card.specId = specId;
  // 规格卡整个走 data 包：data 包被停用时，规格卡一张也收不了
  if (!isPackEnabled("data")) {
    card.specName = specId;
    card.problems.push(`卡片包「规格」（data）已停用，在卡片中心打开它才能收规格卡`);
    return card;
  }
  const spec = findSpec(specId);
  if (!spec) {
    card.specName = specId;
    card.problems.push(`本机没有规格「${specId}」——先 POST /api/card-specs 装上它，或把这张卡改成原生卡片`);
    return card;
  }
  card.specName = spec.name;
  if (!isEnabled(spec)) {
    card.problems.push(`规格「${spec.name}」已停用，在规格中心打开它才能收这类卡片`);
    return card;
  }

  const rawFields = asObject(raw.fields);
  const report = normalizeSpecValues(spec, rawFields);
  card.fields = describeFields(spec, report.fields);

  /* 字段级问题按三类分开说（真实踩坑：enum 值非法却报「缺必填」，照着改也改不对）：
   *  ① 缺必填 —— 压根没给，去补一个值；
   *  ② 值不合规 —— 给了但不合法，照着「期望」改那个值（必填的会拦下整张卡，非必填的只警告）；
   *  ③ 未知字段 —— 规格里没有，已丢弃，去查字段表。
   * 每条都带上 key（agent 按 key 改）与 label（人按 label 认）。 */
  const requiredKeys = new Set(spec.fields.filter((field) => field.required).map((field) => field.key));
  const fieldLabel = (key: string) => spec.fields.find((field) => field.key === key)?.label || key;
  if (report.missing.length) {
    card.problems.push(`缺必填字段：${report.missing.map((key) => `${fieldLabel(key)}（key=${key}）`).join("、")}`);
  }
  // 只有「必填 + 值整个没留下」才拦卡：部分留下的（比如条目表里丢了一格）当警告，
  // 否则一格小毛病就把整封信退回去，比放它进来更碍事
  const blockingInvalid = report.invalid.filter(
    (issue) => requiredKeys.has(issue.key) && report.fields[issue.key] === undefined,
  );
  if (blockingInvalid.length) {
    card.problems.push(
      `字段值不合规：${blockingInvalid.map((issue) => `${issue.label}（key=${issue.key}）${issue.problem}`).join("；")}`,
    );
  }
  const blocking = new Set(blockingInvalid);
  for (const issue of report.issues) {
    if (blocking.has(issue)) continue; // 已经进 problems 了，别再重复一遍
    const prefix = issue.kind === "invalid" ? "字段值不合规" : "字段已调整";
    card.warnings.push(`${prefix}：${issue.label}（key=${issue.key}）${issue.problem}`);
  }
  if (report.unknown.length) {
    card.warnings.push(
      `未知字段（规格里没有，已丢弃）：${report.unknown.join("、")}——字段表见 GET /api/card-specs/${spec.id}`,
    );
  }

  const source = asObject(raw.source);
  const externalId = cleanText(source.externalId, 200);
  card.externalKey = externalId ? `${spec.id}::${externalId}` : null;
  card.title = cleanText(raw.title, 300) || specCardTitle(spec, report.fields);

  if (card.problems.length) return card;
  card.payload = {
    ...common,
    type: "data",
    title: card.title,
    content: "",
    w: geometry.w ?? spec.card.w,
    h: geometry.h ?? spec.card.h,
    color: raw.color || spec.card.color,
    data: {
      specId: spec.id,
      specVersion: spec.version,
      fields: report.fields,
      source: {
        app: cleanText(source.app, 40) || spec.source?.app || "",
        url: cleanText(source.url, 2048),
        externalId,
        fetchedAt: Number.isFinite(Number(source.fetchedAt)) ? Number(source.fetchedAt) : Date.now(),
      },
    },
  };
  dryNormalize(card);
  return card;
}

/** 解析一个信封（不碰画板）。所有校验都在这里，落板与干跑共用。 */
export function parseEnvelope(raw: any): ParsedEnvelope {
  const input = asObject(raw);
  const problems: string[] = [];

  const format = cleanText(input.format, 60) || ENVELOPE_FORMAT;
  // 旧格式名照收（goal-board 时代的信封），输出侧（exportEnvelope）永远写新名
  if (format !== ENVELOPE_FORMAT && !(LEGACY_ENVELOPE_FORMATS as readonly string[]).includes(format)) {
    problems.push(`format 应为「${ENVELOPE_FORMAT}」，收到「${format}」`);
  }
  const version = Number(input.version || ENVELOPE_VERSION);
  if (version !== ENVELOPE_VERSION) problems.push(`version 应为 ${ENVELOPE_VERSION}，收到 ${input.version}`);

  const rawCards = Array.isArray(input.cards) ? input.cards : [];
  if (!rawCards.length) problems.push("cards 必须是非空数组");
  if (rawCards.length > ENVELOPE_LIMITS.cards) {
    problems.push(`一次最多 ${ENVELOPE_LIMITS.cards} 张卡，收到 ${rawCards.length} 张（分批送）`);
  }

  const cards = rawCards.slice(0, ENVELOPE_LIMITS.cards).map((card: unknown, index: number) => parseCard(card, index));
  const localIds = new Set<string>();
  for (const card of cards) {
    if (!card.localId) continue;
    if (localIds.has(card.localId)) card.problems.push(`信封内 id 重复：${card.localId}`);
    localIds.add(card.localId);
  }

  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  if (rawEdges.length > ENVELOPE_LIMITS.edges) problems.push(`一次最多 ${ENVELOPE_LIMITS.edges} 条连线`);
  const edges: ParsedEdge[] = rawEdges.slice(0, ENVELOPE_LIMITS.edges).map((raw: any) => {
    const edge: ParsedEdge = {
      from: cleanText(raw?.from, 80),
      to: cleanText(raw?.to, 80),
      label: cleanText(raw?.label, MAX_EDGE_LABEL),
      kind: normalizeEdgeKind(raw?.kind),
      // 收卡宽：weight / tags 写错不打回整封，归一化后取不到就是「没标」
      weight: normalizeEdgeWeight(raw?.weight),
      tags: normalizeEdgeTags(raw?.tags),
      problems: [],
    };
    if (!edge.from || !edge.to) edge.problems.push("from / to 不能为空");
    else if (edge.from === edge.to) edge.problems.push("两端不能是同一张卡");
    return edge;
  });

  const mode: IngestMode = input.mode === "lenient" ? "lenient" : "strict";
  const onDuplicate: DuplicatePolicy =
    input.onDuplicate === "skip" || input.onDuplicate === "create" ? input.onDuplicate : "update";

  return {
    format,
    version,
    generator: cleanText(input.generator, 100),
    mode,
    onDuplicate,
    cards,
    edges,
    problems,
  };
}

export interface ValidateReport {
  format: string;
  version: number;
  generator: string;
  mode: IngestMode;
  onDuplicate: DuplicatePolicy;
  counts: { cards: number; ready: number; rejected: number; edges: number };
  /** 用到了哪些规格：id → 张数（本机没有的规格也会出现在这里） */
  specs: { id: string; name: string; count: number; installed: boolean; enabled: boolean }[];
  cards: ParsedCard[];
  edges: ParsedEdge[];
  problems: string[];
}

/** 干跑：只解析与报告。规格中心「粘贴导入」和 agent 自检都打这条路。 */
export function validateEnvelope(raw: any): ValidateReport {
  const parsed = parseEnvelope(raw);
  const used = new Map<string, { count: number; installed: boolean; enabled: boolean; name: string }>();
  for (const card of parsed.cards) {
    if (card.kind !== "spec") continue;
    const spec = findSpec(card.specId);
    const entry = used.get(card.specId) || {
      count: 0,
      installed: Boolean(spec),
      enabled: spec ? isEnabled(spec) : false,
      name: spec?.name || card.specId,
    };
    entry.count += 1;
    used.set(card.specId, entry);
  }
  const ready = parsed.cards.filter((card) => card.payload && !card.problems.length).length;
  return {
    format: parsed.format,
    version: parsed.version,
    generator: parsed.generator,
    mode: parsed.mode,
    onDuplicate: parsed.onDuplicate,
    counts: {
      cards: parsed.cards.length,
      ready,
      rejected: parsed.cards.length - ready,
      edges: parsed.edges.length,
    },
    specs: [...used.entries()].map(([id, entry]) => ({ id, ...entry })),
    cards: parsed.cards,
    edges: parsed.edges,
    problems: parsed.problems,
  };
}

/* ── 落板 ─────────────────────────────────────────────── */

export interface IngestResult {
  boardId: string;
  board: BoardDetail;
  mode: IngestMode;
  created: { index: number; cardId: string; spec: string; title: string }[];
  updated: { index: number; cardId: string; spec: string; title: string }[];
  skipped: { index: number; reason: string }[];
  rejected: { index: number; reasons: string[] }[];
  edgeIds: string[];
  warnings: string[];
}

/** 已有卡片的外部主键 → 卡片 id，用来判重（同规格 + 同 externalId = 同一张卡）。 */
function externalIndex(board: Board): Map<string, BoardCard> {
  const index = new Map<string, BoardCard>();
  for (const card of board.cards || []) {
    const key = card.data?.source?.externalId;
    if (card.type === "data" && card.data?.specId && key) index.set(`${card.data.specId}::${key}`, card);
  }
  return index;
}

/** 没给坐标的卡摆成网格；起点让开画板上已有的内容。 */
function autoLayout(board: Board, cards: { payload: Record<string, unknown> }[]): void {
  const existing = board.cards || [];
  const startX = existing.length ? Math.max(...existing.map((card) => card.x + card.w)) + INSERT_GAP : 80;
  const startY = existing.length ? Math.min(...existing.map((card) => card.y)) : 80;
  const pending = cards.filter((card) => card.payload.x === undefined || card.payload.y === undefined);
  if (!pending.length) return;
  const colWidth = Math.max(...pending.map((card) => Number(card.payload.w) || 320)) + GRID_GAP_X;
  const rowHeight = Math.max(...pending.map((card) => Number(card.payload.h) || 240)) + GRID_GAP_Y;
  pending.forEach((card, index) => {
    card.payload.x = startX + (index % GRID_COLS) * colWidth;
    card.payload.y = startY + Math.floor(index / GRID_COLS) * rowHeight;
  });
}

/**
 * 把一个信封落进画板。
 *
 * strict（默认）：任何一张卡不合规就整批不落——外部系统推来的一批数据通常是一个整体，
 * 落一半会留下需要人工对账的残局。lenient：跳过坏卡，其余照落，报告里逐条说明。
 */
export function ingestEnvelope(boardId: string, raw: any, actor: BoardActor = "agent"): IngestResult {
  const parsed = parseEnvelope(raw);
  if (parsed.problems.length) throw badRequest(`信封不合规：${parsed.problems.join("；")}`);

  const rejected = parsed.cards.filter((card) => card.problems.length);
  if (parsed.mode === "strict" && rejected.length) {
    const detail = rejected
      .slice(0, 5)
      .map((card) => `${cardWhere(card)}：${card.problems.join("；")}`)
      .join("\n");
    throw conflict(
      `${rejected.length} 张卡不合规，strict 模式下整批未落板：\n${detail}${
        rejected.length > 5 ? `\n…还有 ${rejected.length - 5} 张` : ""
      }\n（想跳过坏卡改成 "mode": "lenient"）`,
    );
  }

  const board = store.requireBoard(boardId);
  const usable = parsed.cards.filter((card): card is ParsedCard & { payload: Record<string, unknown> } => Boolean(card.payload));
  const duplicates = externalIndex(board);

  const toCreate: (ParsedCard & { payload: Record<string, unknown> })[] = [];
  const toUpdate: { card: ParsedCard & { payload: Record<string, unknown> }; targetId: string }[] = [];
  const skipped: { index: number; reason: string }[] = [];

  for (const card of usable) {
    const hit = card.externalKey ? duplicates.get(card.externalKey) : undefined;
    if (!hit || parsed.onDuplicate === "create") {
      toCreate.push(card);
      continue;
    }
    if (parsed.onDuplicate === "skip") {
      skipped.push({ index: card.index, reason: `画板上已有同一条（${card.externalKey}）→ ${hit.id}` });
      continue;
    }
    toUpdate.push({ card, targetId: hit.id });
  }

  autoLayout(board, toCreate);

  // 信封是「一次收一批」的入口，跟 whole / paste 同一档：动手前先照相
  const checkpoint = captureCheckpoint(board, "ingest");

  const result = store.mutateBoard(board.id, (target) => {
    const now = Date.now();
    const created: IngestResult["created"] = [];
    const updated: IngestResult["updated"] = [];
    const localMap = new Map<string, string>();
    const taken = new Set((target.cards || []).map((card) => card.id));

    for (const entry of toCreate) {
      const card = normalizeCardInput(entry.payload, { uploadsDir: UPLOADS_DIR });
      if (taken.has(card.id)) throw conflict(`卡片 id 冲突：${card.id}，重试一次即可`);
      taken.add(card.id);
      target.cards = [...(target.cards || []), card];
      if (entry.localId) localMap.set(entry.localId, card.id);
      created.push({ index: entry.index, cardId: card.id, spec: entry.specId, title: card.title });
    }

    for (const entry of toUpdate) {
      const existing = (target.cards || []).find((card) => card.id === entry.targetId);
      if (!existing) continue;
      // 判重命中 = 外部系统推来的是这条记录**此刻的完整样子**，所以字段整份替换而不是合并
      // （单卡 PATCH 那条路才是合并）。做法：把 existing 的 fields 先清空再交给 patch 逻辑，
      // 几何位置保持不动——用户可能已经把这张卡拖到画板上某个位置了。
      const { x, y, w, h, z, ...rest } = entry.card.payload;
      const blanked: BoardCard = { ...existing, data: existing.data ? { ...existing.data, fields: {} } : undefined };
      const next = normalizeCardInput(rest, { existing: blanked, uploadsDir: UPLOADS_DIR });
      next.updatedAt = now;
      target.cards = (target.cards || []).map((card) => (card.id === next.id ? next : card));
      if (entry.card.localId) localMap.set(entry.card.localId, next.id);
      updated.push({ index: entry.card.index, cardId: next.id, spec: entry.card.specId, title: next.title });
    }

    const warnings: string[] = [];
    const edgeIds: string[] = [];
    const boardIds = new Set((target.cards || []).map((card) => card.id));
    for (const edge of parsed.edges) {
      if (edge.problems.length) {
        warnings.push(`连线 ${edge.from}→${edge.to} 已跳过：${edge.problems.join("；")}`);
        continue;
      }
      const from = localMap.get(edge.from) || (CARD_ID_RE.test(edge.from) && boardIds.has(edge.from) ? edge.from : "");
      const to = localMap.get(edge.to) || (CARD_ID_RE.test(edge.to) && boardIds.has(edge.to) ? edge.to : "");
      if (!from || !to) {
        warnings.push(`连线 ${edge.from}→${edge.to} 已跳过：两端必须是本信封里的卡片 id，或画板上已有的 c_ 卡片 id`);
        continue;
      }
      if ((target.edges || []).some((item) => item.from === from && item.to === to)) continue;
      const created: BoardEdge = {
        id: newId("e"),
        from,
        to,
        label: edge.label,
        kind: normalizeEdgeKind(edge.kind),
        color: normalizeEdgeColor(null),
        style: normalizeEdgeStyle(null),
        width: normalizeEdgeWidth(null),
        weight: edge.weight,
        tags: edge.tags,
        createdBy: "agent",
        createdAt: now,
      };
      target.edges = [...(target.edges || []), created];
      edgeIds.push(created.id);
    }

    pushActivity(target, {
      actor,
      action: "ingest",
      summary:
        `信封落板：新建 ${created.length} 张` +
        (updated.length ? `、更新 ${updated.length} 张` : "") +
        (edgeIds.length ? `、连线 ${edgeIds.length} 条` : ""),
      counts: { created: created.length, updated: updated.length, edges: edgeIds.length },
      checkpoint,
    });
    target.updatedAt = now;
    return { board: boardDetail(target), created, updated, edgeIds, warnings };
  });

  // 收进来的卡片会成为转过 Issue 那些卡的上下文，跟手动建卡一样要回推一次
  scheduleIssueSync(board.id);

  const warnings = [
    ...result.warnings,
    ...parsed.cards.flatMap((card) => card.warnings.map((text) => `${cardWhere(card)}：${text}`)),
  ];

  return {
    boardId: board.id,
    board: result.board,
    mode: parsed.mode,
    created: result.created,
    updated: result.updated,
    skipped,
    rejected: rejected.map((card) => ({ index: card.index, reasons: card.problems })),
    edgeIds: result.edgeIds,
    warnings,
  };
}

/* ── 导出成信封 ───────────────────────────────────────── */

/**
 * 把一块画板导成信封格式（`?format=cards`）。
 *
 * 与 `?format=json` 的区别：那份是**本服务的内部结构**（几何、颜色、id 一应俱全，用来 PUT 回 whole）；
 * 这份是**交换格式**——规格卡摊成 `spec + fields`，别人不需要懂 blotboard 的卡片模型也能读，
 * 也能原样 POST 到另一台机器的 /ingest 上。
 */
export function exportEnvelope(board: Board, { onlyData = false }: { onlyData?: boolean } = {}): Record<string, unknown> {
  const cards = (board.cards || []).filter((card) => (onlyData ? card.type === "data" : true));
  const idMap = new Map(cards.map((card, index) => [card.id, `n${index + 1}`]));
  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    generator: `blotboard/${board.id}`,
    exportedAt: Date.now(),
    board: { id: board.id, name: board.name },
    cards: cards.map((card) => {
      const local = idMap.get(card.id)!;
      const base: Record<string, unknown> = {
        id: local,
        boardCardId: card.id,
        title: card.title,
        color: card.color,
        x: card.x,
        y: card.y,
        w: card.w,
        h: card.h,
      };
      if (card.agentPrompt) base.agentPrompt = card.agentPrompt;
      if (card.type === "data" && card.data) {
        return {
          ...base,
          spec: card.data.specId,
          specVersion: card.data.specVersion,
          fields: card.data.fields,
          ...(card.data.source ? { source: card.data.source } : {}),
        };
      }
      // 专属字段按注册表的 fieldKey 全量带上（原来手写漏了 excalidraw——注册表驱动后自然补齐）
      const fields: Record<string, unknown> = {};
      for (const meta of CARD_METAS) {
        const key = meta.fieldKey;
        if (!key || fields[key] !== undefined) continue;
        const value = (card as unknown as Record<string, unknown>)[key];
        if (value) fields[key] = value;
      }
      return {
        ...base,
        type: card.type,
        content: card.content,
        ...fields,
      };
    }),
    edges: (board.edges || [])
      .filter((edge) => idMap.has(edge.from) && idMap.has(edge.to))
      .map((edge) => ({
        from: idMap.get(edge.from),
        to: idMap.get(edge.to),
        label: edge.label,
        kind: edge.kind,
        // 语义两件套自包含（换台机器凭这封信重建的关系不该掉强弱与标签）；没标过就不占位
        ...(edge.weight ? { weight: edge.weight } : {}),
        ...((edge.tags || []).length ? { tags: edge.tags } : {}),
      })),
  };
}
