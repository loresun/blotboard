/**
 * 模板应用：建新板（apply）/ 插进现有板（insert）。
 *
 * 两条路都不走 PUT /whole：
 * whole 会把**现有卡片**也重新 normalize 一遍（createdAt 重置），
 * 插入模板本该是纯追加操作，没理由让用户原有卡片的元信息跟着变。
 * 这里直接在一次 store.mutate 事务里追加——要么全进去，要么一张都不进。
 */
import { badRequest } from "./http";
import * as store from "./storage";
import { UPLOADS_DIR } from "./config";
import {
  MAX_EDGE_LABEL,
  cleanText,
  clampNumber,
  newId,
  normalizeBoardName,
  normalizeCardInput,
  normalizeEdgeColor,
  normalizeEdgeKind,
  normalizeEdgeStyle,
  normalizeEdgeWidth,
} from "./board-schema";
import { boardDetail, createBoard, deleteBoard } from "./board-service";
import { captureCheckpoint } from "./checkpoints";
import { pushActivity } from "./board-activity";
import { getTemplate, instantiate } from "./template-store";
import type { Board, BoardActor, BoardCard, BoardDetail, BoardEdge } from "./types";
import type { Template } from "./template-schema";

/** 插入时默认往右下挪一点，别正好压在现有卡片上 */
export const DEFAULT_INSERT_OFFSET = 200;

/**
 * 建新板时模板左上角落在哪。
 *
 * 模板 json 里的坐标是围着原点写的（对称结构好读好改），但新板的默认视口是 {0,0,zoom}，
 * 直接落下去会有一大半在屏幕左上角外面。所以 apply 时整体平移到原点附近——
 * 这样「打开就看得见」不依赖任何 fitView。
 */
const APPLY_MARGIN = 60;

export interface ApplyResult {
  boardId: string;
  board: BoardDetail;
  template: { id: string; name: string };
  cardIds: string[];
  edgeIds: string[];
  fillableIds: string[];
}

export interface InsertResult extends ApplyResult {
  offset: { x: number; y: number };
}

function buildCards(instantiated: { cards: Record<string, unknown>[] }): BoardCard[] {
  return instantiated.cards.map((raw) => normalizeCardInput(raw, { uploadsDir: UPLOADS_DIR }));
}

function buildEdges(
  instantiated: { edges: Record<string, any>[] },
  ids: Set<string>,
  existing: BoardEdge[],
): BoardEdge[] {
  const edges: BoardEdge[] = [];
  const now = Date.now();
  for (const raw of instantiated.edges) {
    const from = String(raw.from || "");
    const to = String(raw.to || "");
    // 模板已经校验过一遍，这里是落板前的最后一道：坏边丢掉而不是整批失败
    if (!ids.has(from) || !ids.has(to) || from === to) continue;
    if (edges.some((edge) => edge.from === from && edge.to === to)) continue;
    if (existing.some((edge) => edge.from === from && edge.to === to)) continue;
    edges.push({
      id: newId("e"),
      from,
      to,
      label: cleanText(raw.label, MAX_EDGE_LABEL),
      kind: normalizeEdgeKind(raw.kind),
      color: normalizeEdgeColor(raw.color),
      style: normalizeEdgeStyle(raw.style),
      width: normalizeEdgeWidth(raw.width),
      createdBy: "user",
      createdAt: now,
    });
  }
  return edges;
}

function appendToBoard(board: Board, template: Template, offsetX: number, offsetY: number) {
  const instantiated = instantiate(template, { offsetX, offsetY });
  const cards = buildCards(instantiated);
  const taken = new Set((board.cards || []).map((card) => card.id));
  for (const card of cards) {
    // 随机段几乎不可能撞，但撞了要报出来而不是让后写的那张顶掉前一张
    if (taken.has(card.id)) throw badRequest(`卡片 id 冲突：${card.id}，重试一次即可`);
    taken.add(card.id);
  }
  const edges = buildEdges(instantiated, taken, board.edges || []);
  board.cards = [...(board.cards || []), ...cards];
  board.edges = [...(board.edges || []), ...edges];
  board.updatedAt = Date.now();
  return { cards, edges, fillableIds: instantiated.fillableIds };
}

/** 应用到新画板：建板 + 一次性写入模板的卡片/连线/视口。 */
export function applyTemplate(templateId: string, rawName?: unknown): ApplyResult {
  const template = getTemplate(templateId);
  const name = rawName === undefined || rawName === null || String(rawName).trim() === ""
    ? template.name
    : normalizeBoardName(rawName);
  const created = createBoard(name);

  const origin = originOffset(template);
  let result;
  try {
    result = store.mutateBoard(created.id, (target) => {
      const appended = appendToBoard(target, template, origin.x, origin.y);
      target.viewport = { ...template.viewport };
      return { board: boardDetail(target), ...appended };
    });
  } catch (err) {
    // 建板与写卡是两次事务；后一次失败别把一块空板留在列表里
    try {
      deleteBoard(created.id);
    } catch {
      /* 清理失败就算了，原始错误更重要 */
    }
    throw err;
  }

  return {
    boardId: created.id,
    board: result.board,
    template: { id: template.id, name: template.name },
    cardIds: result.cards.map((card) => card.id),
    edgeIds: result.edges.map((edge) => edge.id),
    fillableIds: result.fillableIds,
  };
}

/**
 * 插进现有画板。不传 offset 时落在现有内容的右边（而不是原点），
 * 否则模板会正好盖在用户已有的卡片上——「插入」看起来就像「弄乱了」。
 */
export function insertTemplate(
  templateId: string,
  boardId: string,
  body: { offsetX?: unknown; offsetY?: unknown } = {},
  actor: BoardActor = "user",
): InsertResult {
  const template = getTemplate(templateId);
  const board = store.requireBoard(boardId);

  const auto = autoOffset(board, template);
  const offsetX = body.offsetX === undefined ? auto.x : clampNumber(body.offsetX, -20_000, 20_000, auto.x);
  const offsetY = body.offsetY === undefined ? auto.y : clampNumber(body.offsetY, -20_000, 20_000, auto.y);

  // 一次铺十几张卡进一块有内容的板，跟粘贴同一档：动手前先照相
  // （applyTemplate 那条不打点——它建的是一块新板，没有「原来的内容」可丢）
  const checkpoint = captureCheckpoint(board, "template");

  const result = store.mutateBoard(board.id, (target) => {
    const appended = appendToBoard(target, template, offsetX, offsetY);
    pushActivity(target, {
      actor,
      action: "template",
      summary: `插入模板「${template.name}」：${appended.cards.length} 张卡片、${appended.edges.length} 条连线`,
      counts: { cards: appended.cards.length, edges: appended.edges.length },
      checkpoint,
    });
    return { board: boardDetail(target), ...appended };
  });

  return {
    boardId: board.id,
    board: result.board,
    template: { id: template.id, name: template.name },
    cardIds: result.cards.map((card) => card.id),
    edgeIds: result.edges.map((edge) => edge.id),
    fillableIds: result.fillableIds,
    offset: { x: offsetX, y: offsetY },
  };
}

/** 模板 json 的坐标围着原点写，这里换算成「左上角落在 (APPLY_MARGIN, APPLY_MARGIN)」的位移。 */
function originOffset(template: Template): { x: number; y: number } {
  return {
    x: APPLY_MARGIN - Math.min(...template.cards.map((card) => card.x)),
    y: APPLY_MARGIN - Math.min(...template.cards.map((card) => card.y)),
  };
}

/** 空板等同于建新板（挪到原点附近），有内容就整体挪到现有卡片右侧留一条走廊。 */
function autoOffset(board: Board, template: Template): { x: number; y: number } {
  const cards = board.cards || [];
  if (!cards.length) return originOffset(template);
  const boardRight = Math.max(...cards.map((card) => card.x + card.w));
  const boardTop = Math.min(...cards.map((card) => card.y));
  const tplLeft = Math.min(...template.cards.map((card) => card.x));
  const tplTop = Math.min(...template.cards.map((card) => card.y));
  return {
    x: Math.round(boardRight + DEFAULT_INSERT_OFFSET - tplLeft),
    y: Math.round(boardTop - tplTop),
  };
}
