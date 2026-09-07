import { BOARD_CARD_TYPES, CARD_COLORS, EDGE_KINDS, EDGE_STYLES, type Board, type BoardCard, type BoardComment, type BoardDetail, type BoardEdge, type BoardListItem, type BoardsFile, type CardColor, type CardType, type CommentTarget, type EdgeKind, type EdgeStyle } from "./types";
import { CARD_META_BY_TYPE } from "./card-metas";

export interface BrowserWorkspaceData {
  version: 1;
  workspace: string;
  order: string[];
  boards: Board[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function text(value: unknown, max: number, fallback = ""): string {
  const next = String(value ?? "").replace(/\x00/g, "").trim();
  return (next || fallback).slice(0, max);
}

function number(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Math.round(Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback)));
}

export function browserId(prefix: "b" | "c" | "e" | "cm" | "cr"): string {
  const cryptoApi = globalThis.crypto;
  const suffix = cryptoApi?.randomUUID
    ? cryptoApi.randomUUID().replace(/-/g, "").slice(0, 12)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${suffix.toLowerCase()}`;
}

export function createBrowserBoard(name: unknown, options: { id?: string; parentId?: unknown; group?: unknown } = {}): Board {
  const now = Date.now();
  const cleanName = text(name, 60);
  if (!cleanName) throw new Error("画板名称不能为空");
  return {
    id: /^b_[a-z0-9_]+$/.test(options.id || "") ? options.id! : browserId("b"),
    name: cleanName,
    parentId: /^b_[a-z0-9_]+$/.test(String(options.parentId || "")) ? String(options.parentId) : null,
    group: text(options.group, 40),
    createdAt: now,
    updatedAt: now,
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [],
    edges: [],
    comments: [],
    activity: [],
  };
}

export function boardListItem(board: Board): BoardListItem {
  const comments = board.comments || [];
  return {
    id: board.id,
    name: board.name,
    parentId: board.parentId ?? null,
    group: board.group || "",
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    counts: {
      cards: board.cards?.length || 0,
      edges: board.edges?.length || 0,
      tasks: (board.cards || []).filter((card) => card.type === "task").length,
      comments: comments.length,
      openComments: comments.filter((comment) => !comment.resolved).length,
    },
  };
}

export function boardDetailLocal(board: Board): BoardDetail {
  return {
    ...clone(board),
    parentId: board.parentId ?? null,
    group: board.group || "",
    settings: board.settings || { issueContext: { mode: "neighbors", types: [] }, issueSync: "off" },
    cards: clone(board.cards || []),
    edges: clone(board.edges || []),
    comments: clone(board.comments || []),
    activity: clone(board.activity || []),
    counts: boardListItem(board).counts,
  };
}

export function touchBrowserBoard(board: Board): void {
  board.updatedAt = Math.max(Date.now(), (board.updatedAt || 0) + 1);
}

export function createBrowserCard(input: Record<string, any>): BoardCard {
  const rawType = String(input.type || "text");
  const type = (BOARD_CARD_TYPES as readonly string[]).includes(rawType) ? (rawType as CardType) : (rawType as CardType);
  const meta = CARD_META_BY_TYPE[type as CardType] || CARD_META_BY_TYPE.text;
  const now = Date.now();
  const card = {
    ...clone(input),
    id: /^c_[a-z0-9_]+$/.test(String(input.id || "")) ? String(input.id) : browserId("c"),
    type,
    createdAt: number(input.createdAt, 0, now + 60_000, now),
    updatedAt: now,
    createdBy: input.createdBy === "agent" ? "agent" : "user",
    x: number(input.x, -100_000, 100_000, 80),
    y: number(input.y, -100_000, 100_000, 80),
    w: number(input.w, 140, 1600, meta.defaultW),
    h: number(input.h, 80, 2400, meta.defaultH),
    z: number(input.z, 0, 100_000, 1),
    color: (CARD_COLORS as readonly unknown[]).includes(input.color) ? input.color : meta.color,
    title: text(input.title, 300),
    content: text(input.content, 20_000),
    agentPrompt: text(input.agentPrompt, 4_000),
    frameId: /^c_[a-z0-9_]+$/.test(String(input.frameId || "")) ? String(input.frameId) : null,
  } as BoardCard;
  if (type === "task") {
    const task = input.task || {};
    card.task = {
      status: (["idea", "issued", "running", "done"] as string[]).includes(task.status) ? task.status : "idea",
      goal: text(task.goal, 20_000, card.content || card.title),
      priority: (["urgent", "high", "medium", "low", "none"] as string[]).includes(task.priority) ? task.priority : "none",
      issueId: null,
      issueNumber: null,
      taskId: null,
      taskStatus: null,
      issueSyncedAt: null,
      issueSyncHash: null,
      issueSyncError: null,
      ...structuredClone(task),
    };
  }
  if (type === "link") {
    const link = input.link || {};
    const url = text(link.url, 2048);
    let host = text(link.host, 200);
    if (url) {
      try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad protocol");
        host = parsed.host;
      } catch {
        throw new Error("link.url 必须是 http(s) 地址");
      }
    }
    card.link = { url, host, title: text(link.title, 300), desc: text(link.desc, 1000) };
  }
  if (type === "quote") card.quote = { source: text(input.quote?.source, 300) };
  if (type === "todo" && !card.todo) card.todo = { items: [] };
  if (type === "frame" && !card.frame) card.frame = { collapsed: false };
  return card;
}

const CARD_COMMON = new Set(["id", "type", "createdAt", "createdBy", "x", "y", "w", "h", "z", "color", "title", "content", "agentPrompt", "frameId"]);

export function patchBrowserCard(existing: BoardCard, patch: Record<string, any>): BoardCard {
  const next = clone(existing) as BoardCard & Record<string, any>;
  if (patch.type !== undefined) next.type = String(patch.type) as CardType;
  if (patch.title !== undefined) next.title = text(patch.title, 300);
  if (patch.content !== undefined) next.content = text(patch.content, 20_000);
  if (patch.agentPrompt !== undefined) next.agentPrompt = text(patch.agentPrompt, 4_000);
  for (const key of ["x", "y", "w", "h", "z"] as const) {
    if (patch[key] !== undefined) next[key] = number(patch[key], key === "w" ? 140 : key === "h" ? 80 : key === "z" ? 0 : -100_000, key === "w" ? 1600 : key === "h" ? 2400 : key === "z" ? 100_000 : 100_000, next[key]);
  }
  if (patch.color !== undefined && (CARD_COLORS as readonly unknown[]).includes(patch.color)) next.color = patch.color as CardColor;
  if (patch.frameId !== undefined) next.frameId = /^c_[a-z0-9_]+$/.test(String(patch.frameId || "")) ? String(patch.frameId) : null;
  for (const [key, value] of Object.entries(patch)) {
    if (CARD_COMMON.has(key)) continue;
    if (["task", "link", "quote", "file", "boardRef", "html", "code", "frame"].includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
      next[key] = { ...(next[key] || {}), ...clone(value) };
    } else {
      next[key] = clone(value);
    }
  }
  if (next.type === "link" && next.link?.url) {
    try {
      const parsed = new URL(next.link.url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad protocol");
      next.link.host = parsed.host;
    } catch {
      throw new Error("link.url 必须是 http(s) 地址");
    }
  }
  next.updatedAt = Date.now();
  return next;
}

export function createBrowserEdge(input: Record<string, any>, cards: BoardCard[]): BoardEdge {
  const from = String(input.from || "");
  const to = String(input.to || "");
  const ids = new Set(cards.map((card) => card.id));
  if (!ids.has(from) || !ids.has(to)) throw new Error("连线端点卡片不存在");
  if (from === to) throw new Error("不能连接卡片自身");
  if (cards.length && input.id && !/^e_[a-z0-9_]+$/.test(String(input.id))) throw new Error("连线 id 无效");
  const kind = (EDGE_KINDS as readonly unknown[]).includes(input.kind) ? (input.kind as EdgeKind) : "rel";
  return {
    id: /^e_[a-z0-9_]+$/.test(String(input.id || "")) ? String(input.id) : browserId("e"),
    from,
    to,
    label: text(input.label, 120),
    kind,
    color: (CARD_COLORS as readonly unknown[]).includes(input.color) ? (input.color as CardColor) : null,
    style: (EDGE_STYLES as readonly unknown[]).includes(input.style) ? (input.style as EdgeStyle) : null,
    width: input.width >= 1 && input.width <= 3 ? Math.round(input.width) : null,
    weight: input.weight >= 1 && input.weight <= 5 ? Math.round(input.weight) : null,
    tags: Array.isArray(input.tags) ? [...new Set(input.tags.map((item: unknown) => text(item, 20)).filter(Boolean))].slice(0, 6) : [],
    createdBy: input.createdBy === "agent" ? "agent" : "user",
    createdAt: Date.now(),
  };
}

export function createBrowserComment(input: Record<string, any>, board: Board): BoardComment {
  const target = (["board", "card", "edge"] as const).includes(input.target) ? (input.target as CommentTarget) : "board";
  const body = text(input.text, 2000);
  if (!body) throw new Error("评论内容不能为空");
  const ids = target === "card" ? new Set(board.cards.map((card) => card.id)) : new Set(board.edges.map((edge) => edge.id));
  const targetId = target === "board" ? null : String(input.targetId || "");
  if (target !== "board" && !ids.has(targetId!)) throw new Error("评论指向的目标不存在");
  const now = Date.now();
  return {
    id: /^cm_[a-z0-9_]+$/.test(String(input.id || "")) ? String(input.id) : browserId("cm"),
    target,
    targetId,
    x: Number.isFinite(Number(input.x)) ? number(input.x, -100_000, 100_000, 0) : null,
    y: Number.isFinite(Number(input.y)) ? number(input.y, -100_000, 100_000, 0) : null,
    text: body,
    createdBy: input.createdBy === "agent" ? "agent" : "user",
    createdAt: now,
    updatedAt: now,
    resolved: input.resolved === true,
    resolvedAt: input.resolved === true ? now : null,
    replies: [],
  };
}

export function mergeBrowserBoards(current: Board[], incoming: Board[], replace = false): Board[] {
  if (replace) return clone(incoming);
  const next = new Map(current.map((board) => [board.id, clone(board)]));
  for (const board of incoming) next.set(board.id, clone(board));
  const incomingIds = new Set(incoming.map((board) => board.id));
  return [...current.filter((board) => !incomingIds.has(board.id)).map(clone), ...incoming.map(clone)];
}

export function workspaceFile(workspace: string, boards: Board[]): BoardsFile {
  return { version: "1.0.0", boards: clone(boards) };
}
