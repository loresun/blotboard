/**
 * 画板业务操作（路由 handler 只做「鉴权 + 取参 + 调这里」）。
 *
 * 全部行为对齐 goal-agent `src/web/board.js`：同样的状态码、同样的错误文案、
 * 同样的幂等语义，保证冒烟脚本换个 base URL 就能直接跑。
 */
import { UPLOADS_DIR } from "./config";
import { captureCheckpoint, checkpointKeep, checkpointsEnabled, ensureOrphanSweep, listCheckpoints, readCheckpoint, type CheckpointInfo } from "./checkpoints";
import { boardActivity, pushActivity } from "./board-activity";
import { TIDY_MODES, runLayout, type LayoutSpecLike, type TidyMode } from "./layout";
import { taskBackend } from "./integrations/task-backend";
import { agentPromptOf, buildIssuePayload, scheduleIssueSync, syncIssuesNow } from "./issue-sync";
import { ApiError, badRequest, conflict, notFound } from "./http";
import { cardSearchParts, cardSearchText, cardSnippet } from "./search-text";
import * as store from "./storage";
import {
  assertEnumValue,
  CARD_ID_RE,
  COMMENT_ID_RE,
  EDGE_ID_RE,
  DEFAULT_ISSUE_CONTEXT,
  MAX_BOARD_COMMENTS,
  MAX_COMMENT_REPLIES,
  MAX_EDGE_LABEL,
  MAX_EDGE_TAG,
  MAX_EDGE_TAGS,
  TYPE_FALLBACK_TITLE,
  cleanText,
  clampNumber,
  newId,
  normalizeBoardGroup,
  normalizeBoardName,
  normalizeBoardSettings,
  normalizeParentId,
  normalizeCardInput,
  passthroughCard,
  normalizeCommentInput,
  normalizeCommentReply,
  normalizeEdgeColor,
  normalizeEdgeKind,
  normalizeEdgeStyle,
  normalizeEdgeTags,
  normalizeEdgeWeight,
  normalizeEdgeWidth,
  normalizeTaskField,
  normalizeViewport,
} from "./board-schema";
import { BOARD_CARD_TYPES, CARD_COLORS, EDGE_KINDS, EDGE_STYLES } from "./types";
import { serverPack } from "./card-registry";
import { typeLabelOf } from "./card-metas";
import { isPackEnabled } from "./card-pack-store";
import { allSpecs } from "./card-spec-store";
import type {
  Board,
  BoardActivity,
  BoardActor,
  BoardCard,
  BoardComment,
  BoardDetail,
  BoardEdge,
  BoardNavCard,
  BoardNavResult,
  CardType,
  CommentTarget,
  BoardListItem,
  BoardSearchHit,
  BoardSearchResult,
  BoardSettings,
  LiveTaskStatus,
  NavOrder,
  NavSort,
  TaskIndexItem,
  Viewport,
} from "./types";

const uploadsDir = UPLOADS_DIR;

/** 下发前端的卡片：补上受控访问 URL，不带本机绝对路径。 */
export function cardPreview(card: BoardCard): BoardCard {
  if ((card.type === "image" || card.type === "media" || card.type === "pdf") && card.file?.uploadId) {
    const id = card.file.uploadId;
    return {
      ...card,
      file: {
        ...card.file,
        url: `/api/boards/uploads/${encodeURIComponent(id)}`,
        previewUrl: card.file.kind === "image" ? `/api/uploads/${encodeURIComponent(id)}/preview` : null,
      },
    };
  }
  return card;
}

/**
 * 整板下发时给卡片瘦身：Excalidraw 的缩略图是几百 KB 的 base64 PNG，
 * 而卡面已经改成从 `/cards/:id/drawing` 取图（服务端渲、浏览器缓存），
 * 再随整板发一遍就是纯白传。实测那块 76 张手绘卡的板：510 KB → 87 KB（gzip 后）。
 *
 * 只在这条路上剥。导出 JSON 那条不剥——那份要能原样 PUT 回 /whole，
 * 剥了就等于把用户存过的缩略图从备份里抹掉。
 */
function slimCard(card: BoardCard): BoardCard {
  if (card.type !== "excalidraw" || !card.excalidraw?.thumbnail) return card;
  const { thumbnail: _dropped, ...rest } = card.excalidraw;
  return { ...card, excalidraw: rest };
}

export function boardSummary(board: Board) {
  // activity 也要摘出去：摘要是「不含正文的那份」，日志（最多 50 条）不该跟着列表到处跑
  const { cards, edges, comments, activity, ...rest } = board;
  return {
    ...rest,
    parentId: board.parentId ?? null,
    group: board.group || "",
    counts: {
      cards: cards?.length || 0,
      edges: edges?.length || 0,
      comments: comments?.length || 0,
      openComments: (comments || []).filter((comment) => !comment.resolved).length,
    },
  };
}

export function boardDetail(board: Board): BoardDetail {
  return {
    ...boardSummary(board),
    viewport: board.viewport,
    settings: normalizeBoardSettings(board.settings),
    cards: (board.cards || []).map((card) => slimCard(cardPreview(card))),
    // 老数据没有 edge.kind，读的时候补默认值，不需要迁移落盘
    edges: (board.edges || []).map((edge) => ({ ...edge, kind: normalizeEdgeKind(edge.kind) })),
    // 同理：评论是后加的，老板子里没有这张表
    comments: board.comments || [],
    // 工作日志同理（服务端单向写，见 lib/board-activity.ts）
    activity: boardActivity(board),
  } as BoardDetail;
}

export function listBoards(): BoardListItem[] {
  // 进程内第一次列板时顺手收走「板早删了」的快照目录（一次性、失败只记日志，见 checkpoints.ts）
  ensureOrphanSweep();
  return store.list();
}

const SEARCH_MAX_QUERY = 120;
const SEARCH_MAX_BOARDS = 30;
const SEARCH_MAX_CARDS_PER_BOARD = 8;

/**
 * 跨画板全文搜索：板名/分组 + 每张卡的可读文本（与前端 cardMatches 同一份 haystack）。
 * 全量线性扫，本地单机数据量下毫秒级；换 SQLite 时再下沉成索引查询。
 */
export function searchBoards(rawQuery: unknown): BoardSearchResult {
  const query = cleanText(rawQuery, SEARCH_MAX_QUERY);
  const keyword = query.toLowerCase();
  if (!keyword) return { query: "", boards: [], totalBoards: 0, totalCards: 0 };
  const hits: BoardSearchHit[] = [];
  let totalCards = 0;
  for (const board of store.load().boards) {
    // 板 id 只在关键词像 id（够长）时参与匹配，避免「b」这种单字母全命中
    const idHit = keyword.length >= 4 && board.id.toLowerCase().includes(keyword);
    const nameHit = idHit || `${board.name} ${board.group || ""}`.toLowerCase().includes(keyword);
    const cardHits = (board.cards || []).filter((card) => cardSearchText(card).includes(keyword));
    if (!nameHit && !cardHits.length) continue;
    totalCards += cardHits.length;
    hits.push({
      id: board.id,
      name: board.name,
      group: board.group || "",
      parentId: board.parentId ?? null,
      updatedAt: board.updatedAt,
      nameHit,
      cardTotal: cardHits.length,
      cards: cardHits.slice(0, SEARCH_MAX_CARDS_PER_BOARD).map((card) => ({
        id: card.id,
        type: card.type,
        title: card.title || TYPE_FALLBACK_TITLE[card.type] || "卡片",
        snippet: cardSnippet(card, keyword),
      })),
    });
  }
  hits.sort(
    (a, b) =>
      Number(b.nameHit) - Number(a.nameHit) || b.cardTotal - a.cardTotal || b.updatedAt - a.updatedAt,
  );
  return { query, boards: hits.slice(0, SEARCH_MAX_BOARDS), totalBoards: hits.length, totalCards };
}

export function createBoard(rawName: unknown, options: { parentId?: unknown; group?: unknown } = {}): Board {
  const name = normalizeBoardName(rawName);
  const parentId = normalizeParentId(options.parentId);
  const group = normalizeBoardGroup(options.group);
  return store.insertBoard((data) => {
    const now = Date.now();
    // 子画板默认继承父板的分组：从一个项目里开出来的板，本来就属于那个项目
    const inheritedGroup = group || (parentId ? data.boards.find((item) => item.id === parentId)?.group || "" : "");
    const created: Board = {
      id: newId("b"),
      name,
      parentId,
      group: inheritedGroup,
      createdAt: now,
      updatedAt: now,
      viewport: { x: 0, y: 0, zoom: 1 },
      cards: [],
      edges: [],
      comments: [],
    };
    return created;
  });
}

export function getBoard(id: string): Board {
  return store.requireBoard(id);
}

/**
 * 这块板当前的版本号（就是 updatedAt）。
 * 写接口把它一起回给前端：前端拿服务端的版本号当自己的版本号，
 * 轮询才不会把「我刚写的」当成「别人改了」而白拉一次整板。
 */
export function boardRevision(id: string): number {
  return store.requireBoard(id).updatedAt;
}

/**
 * 写操作的版本握手。
 *
 * 前端只有在「写之前手上就是服务端最新版」时，才可以把写完的新版本号认作自己的版本号。
 * 否则会漏掉别人（agent / 另一个窗口）在这中间写进去的东西——
 * 前端会以为自己已经同步，之后条件拉取一路 unchanged，那次改动就永远看不到了。
 *
 * 所以写接口回一个 stale 标记：前端看到 stale 就不采纳新版本号，改为立刻重拉整块板。
 */
export function revisionHandshake(id: string, since: number | null): { before: number; stale: boolean } {
  const before = boardRevision(id);
  return { before, stale: since !== null && since !== before };
}

/** candidate 是否在 ancestor 的子树里（防止画板层级成环） */
function isDescendant(boards: Board[], candidate: string, ancestor: string): boolean {
  let cursor: string | null | undefined = candidate;
  const guard = new Set<string>();
  while (cursor) {
    if (cursor === ancestor) return true;
    if (guard.has(cursor)) return false;
    guard.add(cursor);
    cursor = boards.find((item) => item.id === cursor)?.parentId ?? null;
  }
  return false;
}

export function patchBoard(id: string, body: Record<string, any>): Board {
  const board = store.requireBoard(id);
  const updated = store.mutateBoard(board.id, (target, data) => {
    if (body.name !== undefined) target.name = normalizeBoardName(body.name);
    if (body.group !== undefined) target.group = normalizeBoardGroup(body.group);
    if (body.parentId !== undefined) {
      const next = normalizeParentId(body.parentId);
      // 不许把板挂到自己或自己的后代下面，否则左栏的树会转圈
      if (next === target.id) throw badRequest("画板不能挂在自己下面");
      if (next && isDescendant(data.boards, next, target.id)) throw badRequest("不能挂到自己的子画板下面");
      target.parentId = next;
    }
    if (body.viewport !== undefined && typeof body.viewport === "object" && body.viewport) {
      target.viewport = normalizeViewport(body.viewport, target.viewport);
    }
    if (body.settings !== undefined) {
      target.settings = normalizeBoardSettings(body.settings, target.settings);
    }
    target.updatedAt = Date.now();
    return target;
  });
  // 板名进 Issue 描述的「来源」那一行，上下文策略更是直接决定描述里带哪些节点
  if (body.name !== undefined || body.settings !== undefined) scheduleIssueSync(board.id);
  return updated;
}

export function deleteBoard(id: string): string {
  const board = store.requireBoard(id);
  store.dropBoard(board.id);
  return board.id;
}

/** 批量几何保存（拖动 / 缩放 / 平移后的防抖落库）。 */
export function saveBoardState(
  id: string,
  body: { viewport?: unknown; cards?: unknown },
): { applied: number; total: number; updatedAt: number } {
  const board = store.requireBoard(id);
  const result = store.mutateBoard(board.id, (target) => {
    if (body.viewport && typeof body.viewport === "object") {
      target.viewport = normalizeViewport(body.viewport, target.viewport);
    }
    const geometry = Array.isArray(body.cards) ? (body.cards as Record<string, any>[]) : [];
    const byId = new Map((target.cards || []).map((card) => [card.id, card]));
    let applied = 0;
    for (const item of geometry) {
      // 用 Map 而不是每条 geometry 都 find 一遍：整板保存是 N 条对 N 张卡，别写成 O(N²)
      const card = byId.get(String(item?.id || ""));
      if (!card) continue;
      card.x = clampNumber(item.x, -100_000, 100_000, card.x);
      card.y = clampNumber(item.y, -100_000, 100_000, card.y);
      card.w = clampNumber(item.w, 140, 1600, card.w);
      card.h = clampNumber(item.h, 80, 2400, card.h);
      card.z = clampNumber(item.z, 0, 100_000, card.z);
      applied += 1;
    }
    if (applied || body.viewport) target.updatedAt = Date.now();
    return { applied, total: geometry.length, updatedAt: target.updatedAt };
  });
  return { ...result, updatedAt: boardRevision(board.id) };
}

/**
 * 全量替换（右侧「画板配置 JSON · 应用」与 agent 的整板改写用）。
 * 坏边（引用不存在的卡片 / 自环 / 重复）直接丢弃而不是报错——容忍 agent 输出。
 * 连线 id **能保住就保住**（同一对 from/to 就是同一条线，见下面 edges 那段）。
 */
export function replaceWhole(id: string, body: Record<string, any>, actor: BoardActor = "user"): Board {
  const board = store.requireBoard(id);
  // 整板改写是最粗的那把刀：动手前先照相（失败不阻断，见 lib/checkpoints.ts 抬头）
  const checkpoint = captureCheckpoint(board, "whole");
  const before = { cards: board.cards?.length || 0, edges: board.edges?.length || 0 };
  const replaced = store.mutateBoard(board.id, (target) => {
    const rawCards = Array.isArray(body.cards) ? body.cards : null;
    if (!rawCards) throw badRequest("whole.cards 必须是数组");
    const cards = rawCards.map((raw: Record<string, any>) => {
      const input: Record<string, any> = { ...raw, createdBy: raw.createdBy === "agent" ? "agent" : "user" };
      try {
        return normalizeCardInput(input, { uploadsDir });
      } catch (err) {
        // 兼容铁律 1：单卡归一化失败只降级该卡（原样透传保存），不毁整板——
        // 「开板 → 保存」不能因为一张卡的字段不合规就把整块板打回去
        if (err instanceof ApiError) {
          return passthroughCard(input, input.type === undefined || input.type === null || input.type === "" ? "text" : String(input.type));
        }
        throw err;
      }
    });
    const ids = new Set(cards.map((card) => card.id));
    if (ids.size !== cards.length) throw badRequest("卡片 id 重复");

    const rawEdges = Array.isArray(body.edges) ? body.edges : [];
    /**
     * 连线 id：**留住还在的那条**。
     *
     * 一条连线的身份就是它的两个端点——同一对 from/to，改个标签、换个顺序、
     * 甚至原封不动地 GET 回来再 PUT 回去，都还是同一条线，没理由换个 id。
     * 这里曾经无条件 `newId("e")`，于是最保守的那种写法（读整板 → 原样回写）
     * 也会把挂在连线上的评论连根剪掉：评论按存活 edge id 过滤，id 一换就成了悬空的。
     * 搬家那条路（lib/board-transfer.ts）早就是保 id 的，这次两边口径统一。
     *
     * 真被删掉的线，它那对端点不在这批里，id 自然不进存活集，评论照旧一起清掉——
     * 「删边 = 连它的评论也走」这条语义一个字没变。
     */
    const keepEdgeByPair = new Map<string, BoardEdge>();
    for (const edge of target.edges || []) {
      const key = `${edge.from}\u0000${edge.to}`;
      if (!keepEdgeByPair.has(key)) keepEdgeByPair.set(key, edge);
    }
    const edges: BoardEdge[] = [];
    const seenPairs = new Set<string>();
    for (const raw of rawEdges as Record<string, any>[]) {
      const from = String(raw.from || "");
      const to = String(raw.to || "");
      if (!ids.has(from) || !ids.has(to) || from === to) continue;
      const pair = `${from}\u0000${to}`;
      // 顺手把重复边的判定从 O(N²) 的 some() 换成 Set：整板改写常常是几百条边
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      const kept = keepEdgeByPair.get(pair);
      edges.push({
        id: kept ? kept.id : newId("e"),
        from,
        to,
        label: cleanText(raw.label, MAX_EDGE_LABEL),
        kind: normalizeEdgeKind(raw.kind),
        color: normalizeEdgeColor(raw.color),
        style: normalizeEdgeStyle(raw.style),
        width: normalizeEdgeWidth(raw.width),
        weight: normalizeEdgeWeight(raw.weight),
        tags: normalizeEdgeTags(raw.tags),
        createdBy: raw.createdBy === "agent" ? "agent" : "user",
        // 留住 id 就一并留住生日：同一条线不该因为别人重存了一次整板就「刚刚才建」。
        // 老板文件里可能压根没有这个字段（读盘不做逐边归一），拿不到就按此刻算
        createdAt: Number.isFinite(Number(kept?.createdAt)) ? Number(kept!.createdAt) : Date.now(),
      });
    }

    if (body.viewport && typeof body.viewport === "object") {
      target.viewport = normalizeViewport(body.viewport, target.viewport);
    }
    if (body.name !== undefined) {
      const name = cleanText(body.name, 60, { fallback: "" });
      if (name) target.name = name;
    }
    if (body.settings !== undefined) target.settings = normalizeBoardSettings(body.settings, target.settings);
    target.cards = cards;
    target.edges = edges;
    // 整板改写常常整批换卡：agent 给的 frameId 可能指向这次没写进来的卡，清掉悬空的
    pruneFrameLinks(target);
    /**
     * 评论表：**不传就不动**。
     * 整板改写通常是 agent 在重写卡片与连线，不该顺手把别人的批注清空——
     * 所以只在显式传了 comments 时才整表替换。两种路径都要剪掉没有落脚点的评论：
     * 这次改写可能删了卡片，也可能删了连线。**没被删的连线 id 已经保住了**
     * （见上面 edges 那段），所以「原样回写」不会再误伤连线上的批注。
     */
    const liveCards = new Set(cards.map((card) => card.id));
    const liveEdges = new Set(edges.map((edge) => edge.id));
    const incoming = Array.isArray(body.comments)
      ? (body.comments as Record<string, any>[]).map((raw) => normalizeCommentInput(raw))
      : target.comments || [];
    target.comments = incoming.filter(
      (comment) =>
        comment.target === "board" ||
        (comment.target === "card" && comment.targetId && liveCards.has(comment.targetId)) ||
        (comment.target === "edge" && comment.targetId && liveEdges.has(comment.targetId)),
    );
    // activity 一个字都不动：它是服务端单向写的表，整表替换语义管不到它（lib/board-activity.ts）
    pushActivity(target, {
      actor,
      action: "whole",
      summary: `整板改写：卡片 ${before.cards} → ${cards.length}、连线 ${before.edges} → ${edges.length}`,
      counts: { cards: cards.length, edges: edges.length },
      checkpoint,
    });
    target.updatedAt = Date.now();
    return target;
  });
  scheduleIssueSync(board.id);
  return replaced;
}

/* ── 分组框的归属关系（frameId） ─────────────────────
   真源只有一处：**子卡身上的 frameId**。框里不存成员名单——存了就要跟
   「卡被删了 / 被拖出去了 / 框被删了」三头对齐，那是又一处会腐坏的一致性。
   代价是这里要有两个守卫：写进来的时候严（400），批量改完之后清一遍悬空引用。 */

/** 建卡 / 改卡时的闸门：frameId 必须指向**同一块板上**一张 type=frame 的卡片。 */
function assertFrameRef(target: Board, card: BoardCard): void {
  if (!card.frameId) return;
  if (card.frameId === card.id) throw badRequest("卡片不能把自己当成分组框");
  // 不做嵌套分组：框里再套框之后，「整体拖动」到底拖的是哪一层、整理该跳过几层，
  // 两件事都说不清；要更深的层级用子画板卡（board）——那本来就是「另开一块板」的手段
  if (card.type === "frame") {
    throw badRequest("分组框不能再放进另一个分组框——要更深的层级请用子画板卡（type=board）");
  }
  const frame = (target.cards || []).find((entry) => entry.id === card.frameId);
  if (!frame) throw notFound(`frameId 指向的卡片不存在：${card.frameId}`);
  if (frame.type !== "frame") {
    throw badRequest(`frameId 只能指向分组框（type=frame），而 ${card.frameId} 是「${typeLabelOf(frame.type)}」卡片`);
  }
}

/**
 * 批量改完之后清一遍悬空的归属：指向已不存在的卡、指向不是框的卡、指向自己，一律清成 null。
 *
 * **删框不删子卡**就落在这儿：框没了，子卡照常留在板上，只是不再归属任何框——
 * 框是组织手段，不是容器所有权。删卡的级联只对连线与批注生效（它们没有独立存在的意义），
 * 卡片有。
 */
export function pruneFrameLinks(target: Board): void {
  const frames = new Set((target.cards || []).filter((card) => card.type === "frame").map((card) => card.id));
  for (const card of target.cards || []) {
    if (card.frameId && (!frames.has(card.frameId) || card.frameId === card.id)) card.frameId = null;
  }
}

/* ── 卡片 ─────────────────────────────────────────── */

export function createCard(boardId: string, body: Record<string, any>): BoardCard {
  const board = store.requireBoard(boardId);
  // 建卡严、收卡宽（兼容铁律 5）：**新建**接口对类型把闸——
  // 未知类型明确拒绝；停用的包也拒绝（画板上已有的这类卡不受影响，只挡新建）。
  // whole / 粘贴 / 信封走各自的路，不经过这道闸。
  const type = body.type === undefined || body.type === null || body.type === "" ? "text" : String(body.type);
  if (!serverPack(type)) {
    throw badRequest(`未知卡片类型「${type}」——这台画板没有对应的卡片包（GET /api/card-packs 看有哪些）`);
  }
  if (!isPackEnabled(type)) {
    throw badRequest(`卡片包「${typeLabelOf(type)}」（${type}）已停用，在卡片中心打开它才能新建这类卡片`);
  }
  const created = store.mutateBoard(board.id, (target) => {
    // strict：建卡严——color / task.status 之类枚举写错就 400，不静默兜底
    const card = normalizeCardInput(body, { uploadsDir, strict: true });
    if ((target.cards || []).some((entry) => entry.id === card.id)) throw conflict("卡片 id 已存在");
    assertFrameRef(target, card);
    target.cards.push(card);
    target.updatedAt = Date.now();
    return card;
  });
  scheduleIssueSync(board.id);
  return created;
}

export function patchCard(boardId: string, cardId: string, body: Record<string, any>): BoardCard {
  const board = store.requireBoard(boardId);
  const updated = store.mutateBoard(board.id, (target) => {
    const existing = (target.cards || []).find((entry) => entry.id === cardId);
    if (!existing) throw notFound("卡片不存在");
    const next = normalizeCardInput(body, { existing, uploadsDir, strict: true });
    assertFrameRef(target, next);
    next.updatedAt = Date.now();
    target.cards = target.cards.map((entry) => (entry.id === cardId ? next : entry));
    // 把一张框改成别的类型，等于这个框没了：框里的卡照常留着，只是不再归属它
    if (existing.type === "frame" && next.type !== "frame") pruneFrameLinks(target);
    target.updatedAt = Date.now();
    return next;
  });
  // 改的可能是这张卡自己（转过 Issue 的话正文变了），也可能是别的卡的上下文
  scheduleIssueSync(board.id);
  return updated;
}

export function deleteCard(boardId: string, cardId: string, actor: BoardActor = "user"): string {
  const board = store.requireBoard(boardId);
  // 单卡删除也打点：它虽然只删一张卡，却会级联带走连线与批注，
  // 而「级联掉的那些东西」正是事后最难自己拼回来的（浏览器那条路有撤销，API 这条没有）
  const checkpoint = captureCheckpoint(board, "delete");
  store.mutateBoard(board.id, (target) => {
    const doomed = (target.cards || []).find((entry) => entry.id === cardId);
    if (!doomed) throw notFound("卡片不存在");
    const goneEdges = new Set(
      (target.edges || []).filter((edge) => edge.from === cardId || edge.to === cardId).map((edge) => edge.id),
    );
    target.cards = (target.cards || []).filter((entry) => entry.id !== cardId);
    target.edges = (target.edges || []).filter((edge) => edge.from !== cardId && edge.to !== cardId);
    // 评论跟着目标走：卡没了，挂在它和它那些连线上的批注也没有落脚点了
    const commentsBefore = (target.comments || []).length;
    target.comments = dropOrphanComments(target.comments, new Set([cardId]), goneEdges);
    // 删掉的可能是个分组框：框里的卡不跟着走，只是解除归属（见 pruneFrameLinks 抬头）
    pruneFrameLinks(target);
    pushActivity(target, {
      actor,
      action: "delete",
      summary: `删卡「${doomed.title || TYPE_FALLBACK_TITLE[doomed.type] || doomed.id}」，连带 ${goneEdges.size} 条连线`,
      counts: { cards: 1, edges: goneEdges.size, comments: commentsBefore - (target.comments || []).length },
      checkpoint,
    });
    target.updatedAt = Date.now();
  });
  scheduleIssueSync(board.id);
  return cardId;
}

/**
 * 批量删卡：一次事务、一次落盘。
 *
 * 之前前端是「for 循环里一张一张调 DELETE」——框选 50 张按 Del 就是 50 次往返
 * 外加 50 次全量写盘（实测约 5 秒，期间整个服务被反复堵住）。
 * 不存在的 id 直接跳过（幂等），返回真正删掉的数量。
 */
export function deleteCards(
  boardId: string,
  rawIds: unknown,
  actor: BoardActor = "user",
): { removed: string[]; updatedAt: number } {
  const board = store.requireBoard(boardId);
  const ids = normalizeCardIdList(rawIds);
  const checkpoint = captureCheckpoint(board, "delete");
  const result = store.mutateBoard(board.id, (target) => {
    const wanted = new Set(ids);
    const present = new Set((target.cards || []).filter((card) => wanted.has(card.id)).map((card) => card.id));
    if (present.size) {
      const goneEdges = new Set(
        (target.edges || [])
          .filter((edge) => present.has(edge.from) || present.has(edge.to))
          .map((edge) => edge.id),
      );
      target.cards = (target.cards || []).filter((card) => !present.has(card.id));
      target.edges = (target.edges || []).filter((edge) => !present.has(edge.from) && !present.has(edge.to));
      const commentsBefore = (target.comments || []).length;
      target.comments = dropOrphanComments(target.comments, present, goneEdges);
      pruneFrameLinks(target);
      pushActivity(target, {
        actor,
        action: "delete",
        summary: `批量删卡 ${present.size} 张，连带 ${goneEdges.size} 条连线`,
        counts: { cards: present.size, edges: goneEdges.size, comments: commentsBefore - (target.comments || []).length },
        checkpoint,
      });
      target.updatedAt = Date.now();
    }
    return { removed: [...present], updatedAt: target.updatedAt };
  });
  scheduleIssueSync(board.id);
  return { ...result, updatedAt: boardRevision(board.id) };
}

/** 批量改卡（改色、类型互转这类）：同样一次事务、一次落盘。 */
export function patchCards(
  boardId: string,
  rawIds: unknown,
  patch: Record<string, any>,
  actor: BoardActor = "user",
): { cards: BoardCard[]; updatedAt: number } {
  const board = store.requireBoard(boardId);
  const ids = normalizeCardIdList(rawIds);
  const checkpoint = captureCheckpoint(board, "patch");
  const result = store.mutateBoard(board.id, (target) => {
    const wanted = new Set(ids);
    const updated: BoardCard[] = [];
    target.cards = (target.cards || []).map((card) => {
      if (!wanted.has(card.id)) return card;
      const next = normalizeCardInput(patch, { existing: card, uploadsDir, strict: true });
      next.updatedAt = Date.now();
      updated.push(next);
      return next;
    });
    for (const card of updated) assertFrameRef(target, card);
    // 这一批里可能有框被转成了别的类型（批量「都转成任务卡」），清一遍悬空归属
    if (updated.length) pruneFrameLinks(target);
    if (updated.length) {
      const keys = Object.keys(patch).filter((key) => key !== "id" && key !== "type");
      pushActivity(target, {
        actor,
        action: "patch",
        summary: `批量改卡 ${updated.length} 张${patch.type ? `（转成 ${typeLabelOf(String(patch.type))}）` : keys.length ? `（${keys.slice(0, 4).join(" / ")}）` : ""}`,
        counts: { cards: updated.length },
        checkpoint,
      });
      target.updatedAt = Date.now();
    }
    return { cards: updated.map(cardPreview), updatedAt: target.updatedAt };
  });
  scheduleIssueSync(board.id);
  return { ...result, updatedAt: boardRevision(board.id) };
}

/**
 * 粘贴一批卡片（⌘V / 右键「粘贴卡片」/「复制卡片」都走这条）。
 *
 * 为什么放服务端：一次粘 10 张就是 10 次往返 + 10 次落盘（批量删除当初就是为这个改的）；
 * 而且「一张卡都有哪些字段」这件事只有 normalizeCardInput 说了算——
 * 前端自己拼 payload 的老路会漏字段：`duplicateCard` 就漏掉了 svg / mermaid / excalidraw /
 * mindmap / todo / ref / book / html / data / boardRef，复制一张 SVG 卡出来是张空卡。
 *
 * 位置：整批按左上角对齐到 `at`（画布坐标）；没给 at 就在原位上错开一点，
 * 相对排布保持不变——粘过来的还是原来那个图形，不是散落一地。
 */
export function pasteCards(
  boardId: string,
  body: Record<string, any>,
  actor: BoardActor = "user",
): { cards: BoardCard[]; edges: BoardEdge[]; updatedAt: number } {
  const incoming = Array.isArray(body?.cards) ? body.cards.filter((card: unknown) => card && typeof card === "object") : [];
  if (!incoming.length) throw badRequest("cards 必须是非空数组");
  if (incoming.length > MAX_BATCH_CARDS) throw badRequest(`一次最多粘贴 ${MAX_BATCH_CARDS} 张卡片`);
  const board = store.requireBoard(boardId);
  const checkpoint = captureCheckpoint(board, "paste");

  // 原样落点 vs 指定落点：都只是整体平移，卡与卡之间的相对位置不动
  const minX = Math.min(...incoming.map((card: any) => clampNumber(card.x, -1e6, 1e6, 0)));
  const minY = Math.min(...incoming.map((card: any) => clampNumber(card.y, -1e6, 1e6, 0)));
  const at = body?.at && typeof body.at === "object" ? body.at : null;
  const dx = at ? clampNumber(at.x, -1e6, 1e6, minX) - minX : 32;
  const dy = at ? clampNumber(at.y, -1e6, 1e6, minY) - minY : 28;

  const result = store.mutateBoard(board.id, (target) => {
    const taken = new Set((target.cards || []).map((card) => card.id));
    const topZ = Math.max(10, ...(target.cards || []).map((card) => card.z || 0));
    const idMap = new Map<string, string>();
    const created: BoardCard[] = [];
    incoming.forEach((raw: any, index: number) => {
      const source = String(raw.id || "");
      // 粘贴出来的永远是新卡：id / 时间戳 / Issue 账本都不能跟着复制过来，
      // 否则「复制一张已转 Issue 的任务卡」会变成两张卡认领同一个 Issue
      const input: Record<string, any> = { ...raw };
      delete input.id;
      delete input.createdAt;
      delete input.updatedAt;
      input.x = clampNumber(raw.x, -1e6, 1e6, 0) + dx;
      input.y = clampNumber(raw.y, -1e6, 1e6, 0) + dy;
      input.z = topZ + 1 + index;
      if (input.task) {
        input.task = {
          ...input.task,
          issueId: null,
          issueNumber: null,
          taskId: null,
          status: "idea",
          issueSyncedAt: null,
          issueSyncHash: null,
          issueSyncError: null,
        };
      }
      const card = normalizeCardInput(input, { uploadsDir });
      while (taken.has(card.id)) card.id = newId("c");
      taken.add(card.id);
      if (source) idMap.set(source, card.id);
      target.cards.push(card);
      created.push(card);
    });

    /**
     * 分组归属跟着批次走：框和它的子卡一起复制时，子卡该归到**新框**上（不是原来那个）。
     * 得等整批建完才能改——框可能排在子卡后面。批次里没有那个框（只复制了子卡）就解除归属：
     * 指向另一处的框在这块板上没有意义，pruneFrameLinks 兜底也会把它清掉。
     */
    for (const card of created) {
      if (!card.frameId) continue;
      card.frameId = idMap.get(card.frameId) || null;
    }
    pruneFrameLinks(target);

    // 只接批次内部的连线：一端还留在原来那块板上的线，粘过来没有意义
    const edges: BoardEdge[] = [];
    const rawEdges = Array.isArray(body?.edges) ? body.edges : [];
    for (const raw of rawEdges) {
      const from = idMap.get(String(raw?.from || ""));
      const to = idMap.get(String(raw?.to || ""));
      if (!from || !to || from === to) continue;
      if ((target.edges || []).some((edge) => edge.from === from && edge.to === to)) continue;
      const edge: BoardEdge = {
        id: newId("e"),
        from,
        to,
        label: cleanText(raw?.label, MAX_EDGE_LABEL),
        kind: normalizeEdgeKind(raw?.kind),
        color: normalizeEdgeColor(raw?.color),
        style: normalizeEdgeStyle(raw?.style),
        width: normalizeEdgeWidth(raw?.width),
        weight: normalizeEdgeWeight(raw?.weight),
        tags: normalizeEdgeTags(raw?.tags),
        createdBy: raw?.createdBy === "agent" ? "agent" : "user",
        createdAt: Date.now(),
      };
      target.edges.push(edge);
      edges.push(edge);
    }

    pushActivity(target, {
      actor,
      action: "paste",
      summary: `粘贴 ${created.length} 张卡片${edges.length ? ` + ${edges.length} 条连线` : ""}`,
      counts: { cards: created.length, edges: edges.length },
      checkpoint,
    });
    target.updatedAt = Date.now();
    return { cards: created.map(cardPreview), edges, updatedAt: target.updatedAt };
  });
  scheduleIssueSync(board.id);
  return { ...result, updatedAt: boardRevision(board.id) };
}

const MAX_BATCH_CARDS = 2000;

function normalizeCardIdList(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const ids = [...new Set(list.map((item) => String(item || "").trim()).filter((id) => CARD_ID_RE.test(id)))];
  if (!ids.length) throw badRequest("ids 必须是非空的卡片 id 数组");
  if (ids.length > MAX_BATCH_CARDS) throw badRequest(`一次最多操作 ${MAX_BATCH_CARDS} 张卡片`);
  return ids;
}

/* ── 连线 ─────────────────────────────────────────── */

/**
 * 连线上的枚举 / 取值区间字段（语义 / 颜色 / 线型 / 线宽 / 关系强弱 / 标签），
 * 「建卡严」的同一口径：写错就当场 400 并列出合法值，不静默兜底成 rel / 跟随语义。
 * null 仍然是合法输入——那是「恢复跟随语义」「取消标注」，不是错值。
 */
function assertEdgeEnums(body: Record<string, any>): void {
  assertEnumValue(body.kind, EDGE_KINDS, "kind");
  assertEnumValue(body.color, CARD_COLORS, "color", { hint: "传 null 恢复跟随语义" });
  assertEnumValue(body.style, EDGE_STYLES, "style", { hint: "传 null 恢复跟随语义" });
  if (body.width !== undefined && body.width !== null && body.width !== "") {
    const width = Number(body.width);
    if (!Number.isInteger(width) || width < 1 || width > 3) {
      throw badRequest(`width「${body.width}」不是合法取值——可选：1 / 2 / 3（细 / 普通 / 粗，传 null 恢复默认）`);
    }
  }
  if (body.weight !== undefined && body.weight !== null && body.weight !== "") {
    const weight = Number(body.weight);
    if (!Number.isInteger(weight) || weight < 1 || weight > 5) {
      throw badRequest(
        `weight「${body.weight}」不是合法取值——可选：1-5 的整数（关系强弱，1 弱 5 强；传 null 取消标注）。` +
          "注意它是**语义**不是线宽，画多粗看 width",
      );
    }
  }
  if (body.tags !== undefined && body.tags !== null) {
    if (!Array.isArray(body.tags)) {
      throw badRequest(`tags 必须是字符串数组（最多 ${MAX_EDGE_TAGS} 个，每个 ≤${MAX_EDGE_TAG} 字），传 [] 清空`);
    }
    if (body.tags.length > MAX_EDGE_TAGS) {
      throw badRequest(`tags 最多 ${MAX_EDGE_TAGS} 个，收到 ${body.tags.length} 个——再多该把这层关系拆成卡片`);
    }
    const bad = body.tags.find((tag: unknown) => typeof tag !== "string");
    if (bad !== undefined) throw badRequest(`tags 里有非字符串项：${JSON.stringify(bad)}`);
  }
}

export function createEdge(boardId: string, body: Record<string, any>): BoardEdge {
  const board = store.requireBoard(boardId);
  assertEdgeEnums(body);
  // 连线一变，沿线注进 Issue 的上下文就变了
  const created = store.mutateBoard(board.id, (target) => {
    const from = String(body.from || "");
    const to = String(body.to || "");
    if (!CARD_ID_RE.test(from) || !CARD_ID_RE.test(to)) throw badRequest("from/to 必须是卡片 id");
    if (from === to) throw badRequest("连线两端不能是同一张卡片");
    const ids = new Set((target.cards || []).map((card) => card.id));
    if (!ids.has(from) || !ids.has(to)) throw notFound("连线引用的卡片不存在");
    if ((target.edges || []).some((entry) => entry.from === from && entry.to === to)) throw conflict("该连线已存在");
    // 带合法且没被占用的 id 就认它：撤销删除要把连线原样放回去，
    // 挂在这条线上的批注认的是那个 id，换一个就成了孤儿被清掉
    const wantId = String(body.id || "");
    const reuseId =
      EDGE_ID_RE.test(wantId) && !(target.edges || []).some((entry) => entry.id === wantId) ? wantId : "";
    const edge: BoardEdge = {
      id: reuseId || newId("e"),
      from,
      to,
      label: cleanText(body.label, MAX_EDGE_LABEL),
      kind: normalizeEdgeKind(body.kind),
      color: normalizeEdgeColor(body.color),
      style: normalizeEdgeStyle(body.style),
      width: normalizeEdgeWidth(body.width),
      weight: normalizeEdgeWeight(body.weight),
      tags: normalizeEdgeTags(body.tags),
      createdBy: body.createdBy === "agent" ? "agent" : "user",
      createdAt: Date.now(),
    };
    target.edges.push(edge);
    target.updatedAt = Date.now();
    return edge;
  });
  scheduleIssueSync(board.id);
  return created;
}

export function deleteEdge(boardId: string, edgeId: string): string {
  const board = store.requireBoard(boardId);
  store.mutateBoard(board.id, (target) => {
    target.edges = (target.edges || []).filter((entry) => entry.id !== edgeId);
    target.comments = dropOrphanComments(target.comments, new Set(), new Set([edgeId]));
    target.updatedAt = Date.now();
  });
  scheduleIssueSync(board.id);
  return edgeId;
}

/** 连线标签就地更新（前端不再靠「删了重建」换标签）。 */
export function patchEdge(boardId: string, edgeId: string, body: Record<string, any>): BoardEdge {
  const board = store.requireBoard(boardId);
  assertEdgeEnums(body);
  return store.mutateBoard(board.id, (target) => {
    const edge = (target.edges || []).find((entry) => entry.id === edgeId);
    if (!edge) throw notFound("连线不存在");
    if (body.label !== undefined) edge.label = cleanText(body.label, MAX_EDGE_LABEL);
    if (body.kind !== undefined) edge.kind = normalizeEdgeKind(body.kind);
    // 外观三件套：传 null 就是「恢复跟随语义」，所以 undefined 才算没提
    if (body.color !== undefined) edge.color = normalizeEdgeColor(body.color);
    if (body.style !== undefined) edge.style = normalizeEdgeStyle(body.style);
    if (body.width !== undefined) edge.width = normalizeEdgeWidth(body.width);
    // 语义两件套：weight 传 null = 「取消标注」，tags 传 [] = 「清空标签」
    if (body.weight !== undefined) edge.weight = normalizeEdgeWeight(body.weight);
    if (body.tags !== undefined) edge.tags = normalizeEdgeTags(body.tags);
    target.updatedAt = Date.now();
    return edge;
  });
}

/* ── 评论（画板批注） ─────────────────────────────── */

/** 目标没了就把评论一起带走：留着只会在列表里堆一堆点不开的孤儿。 */
function dropOrphanComments(
  comments: BoardComment[] | undefined,
  goneCards: Set<string>,
  goneEdges: Set<string>,
): BoardComment[] {
  return (comments || []).filter((comment) => {
    if (!comment.targetId) return true;
    if (comment.target === "card") return !goneCards.has(comment.targetId);
    if (comment.target === "edge") return !goneEdges.has(comment.targetId);
    return true;
  });
}

export type CommentStatusFilter = "open" | "resolved" | "all";

export interface CommentQuery {
  status?: unknown;
  target?: unknown;
  targetId?: unknown;
}

/**
 * 读评论。默认只回未解决的——「还没处理完的意见」才是每次进来要看的那一批，
 * 已解决的是档案，要看得显式问。
 */
export function listComments(boardId: string, query: CommentQuery = {}): BoardComment[] {
  const board = store.requireBoard(boardId);
  const rawStatus = String(query.status || "open");
  const status: CommentStatusFilter =
    rawStatus === "all" || rawStatus === "resolved" ? rawStatus : "open";
  const target = String(query.target || "");
  const targetId = String(query.targetId || "");
  return (board.comments || [])
    .filter((comment) => {
      if (status === "open" && comment.resolved) return false;
      if (status === "resolved" && !comment.resolved) return false;
      if (target && comment.target !== target) return false;
      if (targetId && comment.targetId !== targetId) return false;
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function createComment(boardId: string, body: Record<string, any>): BoardComment {
  const board = store.requireBoard(boardId);
  // 卡片上「还没处理」的评论是 Issue 描述的一部分：加/改/解决/删都要跟着推一次
  const comment = store.mutateBoard(board.id, (target) => {
    if ((target.comments || []).length >= MAX_BOARD_COMMENTS) {
      throw badRequest(`一块画板最多 ${MAX_BOARD_COMMENTS} 条评论，先处理掉一些再来`);
    }
    const created = normalizeCommentInput(body, {
      cardIds: new Set((target.cards || []).map((card) => card.id)),
      edgeIds: new Set((target.edges || []).map((edge) => edge.id)),
    });
    if ((target.comments || []).some((entry) => entry.id === created.id)) throw conflict("评论 id 已存在");
    target.comments = [...(target.comments || []), created];
    target.updatedAt = Date.now();
    return created;
  });
  scheduleIssueSync(board.id);
  return comment;
}

function requireComment(target: Board, commentId: string): BoardComment {
  if (!COMMENT_ID_RE.test(commentId || "")) throw badRequest("评论 id 无效");
  const found = (target.comments || []).find((entry) => entry.id === commentId);
  if (!found) throw notFound("评论不存在");
  return found;
}

/** 改评论：正文、解决状态、钉的位置。目标（挂在哪张卡）不给改，见 normalizeCommentInput。 */
export function patchComment(boardId: string, commentId: string, body: Record<string, any>): BoardComment {
  const board = store.requireBoard(boardId);
  const comment = store.mutateBoard(board.id, (target) => {
    const existing = requireComment(target, commentId);
    const updated = normalizeCommentInput(body, { existing });
    target.comments = (target.comments || []).map((entry) => (entry.id === commentId ? updated : entry));
    target.updatedAt = Date.now();
    return updated;
  });
  scheduleIssueSync(board.id);
  return comment;
}

/** 回复一条评论（图书评论那套：一条批注下面接着说，不另起一条）。 */
export function replyToComment(boardId: string, commentId: string, body: Record<string, any>): BoardComment {
  const board = store.requireBoard(boardId);
  const comment = store.mutateBoard(board.id, (target) => {
    const existing = requireComment(target, commentId);
    if ((existing.replies || []).length >= MAX_COMMENT_REPLIES) {
      throw badRequest(`一条评论最多 ${MAX_COMMENT_REPLIES} 条回复`);
    }
    const reply = normalizeCommentReply(body);
    const updated: BoardComment = {
      ...existing,
      replies: [...(existing.replies || []), reply],
      updatedAt: Date.now(),
    };
    target.comments = (target.comments || []).map((entry) => (entry.id === commentId ? updated : entry));
    target.updatedAt = Date.now();
    return updated;
  });
  scheduleIssueSync(board.id);
  return comment;
}

export function deleteComment(boardId: string, commentId: string): string {
  const board = store.requireBoard(boardId);
  store.mutateBoard(board.id, (target) => {
    requireComment(target, commentId);
    target.comments = (target.comments || []).filter((entry) => entry.id !== commentId);
    target.updatedAt = Date.now();
  });
  scheduleIssueSync(board.id);
  return commentId;
}

/** 一句话描述评论挂在哪，导出与注进 Issue 都用它。 */
function commentTargetLabel(board: Board, comment: BoardComment): string {
  if (comment.target === "card") {
    const card = (board.cards || []).find((item) => item.id === comment.targetId);
    if (!card) return "（已删除的卡片）";
    return `卡片「${card.title || TYPE_FALLBACK_TITLE[card.type] || card.id}」`;
  }
  if (comment.target === "edge") {
    const edge = (board.edges || []).find((item) => item.id === comment.targetId);
    if (!edge) return "（已删除的连线）";
    const byId = new Map((board.cards || []).map((card) => [card.id, card]));
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return `连线 ${from?.title || edge.from} → ${to?.title || edge.to}`;
  }
  return comment.x === null ? "整块画板" : "画布";
}

/* ── 跨画板卡片索引（卡片导航页 /nav 的数据源） ─────────

   跟 searchBoards 的分工：那个是「搜出哪几块板里有」，答案按板聚合、每板只带几张卡；
   这个是「把卡片本身摊平成一条时间线」，按卡排序、可翻页——导航页要的是后者。 */

/** 一页最多给多少张：导航卡带预览文本，几百张就够铺满好几屏了 */
const NAV_MAX_LIMIT = 400;
const NAV_DEFAULT_LIMIT = 120;
/** 导航卡上那段预览的长度：三行左右，再长卡片就不齐了 */
const NAV_PREVIEW_CHARS = 110;

export interface CardIndexOptions {
  /** 分组名；空串 = 未分组那一撮；null/缺省 = 不限分组 */
  group?: string | null;
  /** 只看某一块板 */
  boardId?: string | null;
  query?: string;
  types?: CardType[];
  sort?: NavSort;
  order?: NavOrder;
  limit?: number;
  offset?: number;
}

/**
 * 导航卡上那段预览：有关键词就截命中处，没有就把**标题之外**的可读文本拼一段。
 * 排除标题是因为导航卡上标题已经单独占一行，再复读一遍等于白占三行。
 */
function navPreview(card: BoardCard, keyword: string): string {
  if (keyword) return cardSnippet(card, keyword, 42);
  const text = cardSearchParts(card)
    .filter((part) => part !== card.title)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > NAV_PREVIEW_CHARS ? `${text.slice(0, NAV_PREVIEW_CHARS)}…` : text;
}

/**
 * 跨画板的卡片索引：按时间排序、可按分组/画板/类型/关键词收窄、可翻页。
 *
 * 预览文本只给切出来的那一页算——全量算一遍，翻到第一页也要为六千多张卡拼字符串。
 */
export function cardIndex(options: CardIndexOptions = {}): BoardNavResult {
  const keyword = cleanText(options.query, SEARCH_MAX_QUERY).toLowerCase();
  const wantTypes = new Set((options.types || []).filter((type) => (BOARD_CARD_TYPES as readonly string[]).includes(type)));
  const sort: NavSort = options.sort === "created" ? "created" : "updated";
  const order: NavOrder = options.order === "asc" ? "asc" : "desc";
  const limit = clampNumber(options.limit, 1, NAV_MAX_LIMIT, NAV_DEFAULT_LIMIT);
  const offset = clampNumber(options.offset, 0, 1_000_000, 0);
  const wantGroup = typeof options.group === "string" ? options.group.trim() : null;
  const wantBoard = options.boardId || null;

  const typeCounts: Partial<Record<CardType, number>> = {};
  const hits: { board: Board; card: BoardCard; time: number }[] = [];
  for (const board of store.load().boards) {
    if (wantBoard && board.id !== wantBoard) continue;
    if (wantGroup !== null && (board.group || "") !== wantGroup) continue;
    for (const card of board.cards || []) {
      if (keyword && !cardSearchText(card).includes(keyword)) continue;
      // 类型计数在类型筛选**之前**统计：筛选条要一直显示全部可选项与各自的数量
      typeCounts[card.type] = (typeCounts[card.type] || 0) + 1;
      if (wantTypes.size && !wantTypes.has(card.type)) continue;
      hits.push({ board, card, time: sort === "created" ? card.createdAt : card.updatedAt || card.createdAt });
    }
  }
  hits.sort((a, b) => (order === "asc" ? a.time - b.time : b.time - a.time));

  const cards: BoardNavCard[] = hits.slice(offset, offset + limit).map(({ board, card }) => ({
    id: card.id,
    type: card.type,
    color: card.color,
    title: card.title || "",
    preview: navPreview(card, keyword),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt || card.createdAt,
    boardId: board.id,
    boardName: board.name,
    group: board.group || "",
    taskStatus: card.type === "task" ? card.task?.status || null : null,
  }));
  return { cards, total: hits.length, limit, offset, typeCounts };
}

/* ── 跨画板任务聚合 ───────────────────────────────── */

export function taskIndex(): TaskIndexItem[] {
  const tasks: TaskIndexItem[] = [];
  for (const board of store.load().boards) {
    for (const card of board.cards || []) {
      if (card.type !== "task") continue;
      tasks.push({ boardId: board.id, boardName: board.name, card: cardPreview(card) });
    }
  }
  tasks.sort((a, b) => (b.card.updatedAt || 0) - (a.card.updatedAt || 0));
  return tasks;
}

/** 任务卡关联的执行任务最新状态（批量查 Runner，不落库）。 */
export async function taskStatuses(boardId: string): Promise<Record<string, LiveTaskStatus>> {
  const board = store.requireBoard(boardId);
  const running = (board.cards || []).filter((card) => card.type === "task" && card.task?.taskId);
  const results = await Promise.all(
    running.map(async (card): Promise<[string, LiveTaskStatus]> => {
      const taskId = card.task!.taskId!;
      try {
        const data = await taskBackend.getTask(taskId);
        const task = data?.task || data || {};
        return [
          card.id,
          {
            taskId,
            status: task?.status || "unknown",
            summary: cleanText(task?.summary, 400, { fallback: "" }),
            updatedAt: task?.updatedAt || null,
          },
        ];
      } catch {
        return [card.id, { taskId, status: "unknown", summary: "", updatedAt: null }];
      }
    }),
  );
  return Object.fromEntries(results);
}

/* ── 任务链路（调 Runner，Issue/任务真源在 Goal Agent） ── */

export interface IssueResult {
  alreadyIssued: boolean;
  issue: { id: string; number: string | null } | null;
  card: BoardCard;
}

/** 卡片转 Issue（幂等：已有 issueId 直接返回现状）。 */
export async function convertCardToIssue(
  boardId: string,
  cardId: string,
  overrides: { context?: unknown } = {},
): Promise<IssueResult> {
  const board = store.requireBoard(boardId);
  const existing = (board.cards || []).find((card) => card.id === cardId);
  if (!existing) throw notFound("卡片不存在");
  if (existing.type !== "task") throw badRequest("只有任务卡片可以转 Issue");
  if (existing.task?.issueId) {
    return { alreadyIssued: true, issue: null, card: cardPreview(existing) };
  }

  // 正文与之后每次同步共用同一份拼装（lib/issue-sync.ts），两边永远拼出同样的东西；
  // 上下文策略：单次调用 > 画板设置 > 默认（一跳上下游）
  const payload = buildIssuePayload(board, existing, overrides.context);

  const issue = await taskBackend.createIssue(
    {
      title: payload.title,
      description: payload.description,
      priority: payload.priority,
      labels: ["board"],
    },
    // 来源坐标只给 local 后端用（深链 / 孤儿判定）；远程后端的请求体不带它
    { boardId: board.id, cardId: existing.id },
  );
  const issueId = issue?.id || issue?.issue?.id;
  if (!issueId) throw new ApiError("Runner 未返回 issue id", 500);
  const issueData = issue?.issue || issue || {};
  const issueNumber = issueData.number ?? issueData.identifier ?? null;

  const card = store.mutateBoard(board.id, (target) => {
    const found = target.cards.find((entry) => entry.id === existing.id)!;
    found.task = normalizeTaskField({
      ...found.task,
      issueId,
      issueNumber,
      status: "issued",
      // 刚建出来的这一版就是最新的：记下指纹，之后没改动就不会白推一次
      issueSyncedAt: Date.now(),
      issueSyncHash: payload.hash,
      issueSyncError: null,
    });
    found.updatedAt = Date.now();
    target.updatedAt = Date.now();
    return found;
  });
  return { alreadyIssued: false, issue: { id: issueId, number: issueNumber }, card: cardPreview(card) };
}

export interface LaunchResult {
  task: { sessionId: string | null; mode: "implement" | "analyze" };
  card: BoardCard;
}

/** 已转 Issue 的卡片发起执行任务。 */
export async function launchCardTask(
  boardId: string,
  cardId: string,
  rawMode: unknown,
  rawAgentId?: unknown,
): Promise<LaunchResult> {
  const board = store.requireBoard(boardId);
  const existing = (board.cards || []).find((card) => card.id === cardId);
  if (!existing) throw notFound("卡片不存在");
  if (existing.type !== "task" || !existing.task?.issueId) throw badRequest("请先把卡片转为 Issue 再发起任务");
  const mode: "implement" | "analyze" = rawMode === "analyze" ? "analyze" : "implement";
  // agentId 走 options 通道而不是 payload：只有 local 后端消费，远程请求体保持原形状
  const agentId = typeof rawAgentId === "string" && rawAgentId ? rawAgentId : null;
  /*
   * 发起任务前把这张卡的最新内容推过去 —— 这是「执行的一定是画板上的现状」最后一道闸。
   * agent 拿到的 prompt 是 Goal Agent 里存着的那份 Issue（buildIssueTaskPrompt），
   * 所以自动同步没跑到（画板设置关了、Runner 刚才不通）时，也不能带着旧需求开工。
   * 指纹没变就是个空转，不额外发请求；推不动就直接抛错，别偷偷用旧的跑。
   */
  const report = await syncIssuesNow(boardId, { force: true, cardIds: [cardId] });
  const failed = report.cards.find((item) => item.status === "failed");
  if (failed) throw new ApiError(`最新内容没能同步给 Goal Agent，任务未发起：${failed.error}`, 502);
  const prompt = agentPromptOf(existing);
  const result = await taskBackend.launch(
    existing.task.issueId,
    {
      mode,
      // 卡片自带指令随任务一起下发；Runner 不认这个字段也无害（会被忽略）
      ...(prompt ? { extraInstructions: prompt } : {}),
    },
    agentId ? { agentId } : undefined,
  );
  const sessionId = result?.sessionId || null;
  const card = store.mutateBoard(board.id, (target) => {
    const found = target.cards.find((entry) => entry.id === existing.id)!;
    found.task = normalizeTaskField({ ...found.task, taskId: sessionId, status: "running" });
    found.updatedAt = Date.now();
    target.updatedAt = Date.now();
    return found;
  });
  return { task: { sessionId, mode }, card: cardPreview(card) };
}

export type { Viewport };

/* ── 改板安全网：快照与工作日志 ─────────────────────
   打点发生在各批量入口内部（见上面那些 captureCheckpoint 调用）；
   这里只有「查 / 回滚 / 删」三件事。 */

export interface CheckpointListResult {
  enabled: boolean;
  keep: number;
  checkpoints: CheckpointInfo[];
}

export function boardCheckpoints(id: string): CheckpointListResult {
  store.requireBoard(id);
  return { enabled: checkpointsEnabled(), keep: checkpointKeep(), checkpoints: listCheckpoints(id) };
}

export function boardActivityLog(id: string): BoardActivity[] {
  return boardActivity(store.requireBoard(id));
}

/**
 * 回滚到某一份快照。
 *
 * 两条刻意的取舍：
 *  1. **回滚前先给现状打一份点**（原因 restore）——否则「回滚」本身就成了唯一一次
 *     没有回头路的批量写：点错一份快照就把当前内容永久换掉了。
 *  2. **只还原内容，不还原身份与归属**：卡片 / 连线 / 批注 / 视口 / 画板设置照抄快照，
 *     `id` `createdAt` `parentId` `group` `name` 保持现状不动。理由是那几个字段属于
 *     「这块板在左栏里是谁、挂在哪」，跟「板上画了什么」不是一回事——
 *     用户回滚内容时不会想连带把改过的板名和分组也退回去。
 *     （快照文件本身仍是**完整**的板 JSON：真要连身份一起救，把文件拷回 boards/ 就行。）
 */
export function restoreCheckpoint(
  id: string,
  stamp: string,
  actor: BoardActor = "user",
): { board: Board; restored: string; checkpoint: string | null } {
  const board = store.requireBoard(id);
  const snapshot = readCheckpoint(id, stamp);
  if (!snapshot) throw notFound("快照不存在（可能已被保留上限挤掉）");
  const checkpoint = captureCheckpoint(board, "restore");
  const restored = store.mutateBoard(board.id, (target) => {
    target.cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
    target.edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
    target.comments = Array.isArray(snapshot.comments) ? snapshot.comments : [];
    if (snapshot.viewport && typeof snapshot.viewport === "object") {
      target.viewport = normalizeViewport(snapshot.viewport, target.viewport);
    }
    if (snapshot.settings) target.settings = normalizeBoardSettings(snapshot.settings, target.settings);
    // 快照是我们自己写的、本来就自洽；但文件是可以被手工改的，清一遍不亏
    pruneFrameLinks(target);
    pushActivity(target, {
      actor,
      action: "restore",
      summary: `回滚到 ${stamp} 的快照：卡片 ${target.cards.length}、连线 ${target.edges.length}`,
      counts: { cards: target.cards.length, edges: target.edges.length, comments: target.comments.length },
      checkpoint,
    });
    // 回滚是一次正常的写：照常 bump 版本号，别的窗口 / agent 下一跳轮询才看得见
    target.updatedAt = Date.now();
    return target;
  });
  scheduleIssueSync(board.id);
  return { board: restored, restored: stamp, checkpoint };
}

/* ── 导出 ─────────────────────────────────────────── */

const KIND_LABEL: Record<string, string> = {
  rel: "关联",
  blocks: "阻塞",
  enables: "前置",
  references: "引用",
  produces: "产出",
};

/** 导出成 JSON（结构与 whole 的入参兼容，可直接改完再 PUT 回去）。 */
export function exportBoardJson(id: string): Record<string, unknown> {
  const board = store.requireBoard(id);
  return {
    id: board.id,
    name: board.name,
    // 分组与父板也带上：这份 JSON 现在也是「导入画板」认的形状之一，
    // 少了它们，导回来的板会掉出原来的项目、变成一块顶层板（whole 不认这两个字段，多带无害）
    group: board.group || "",
    parentId: board.parentId ?? null,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    viewport: board.viewport,
    settings: normalizeBoardSettings(board.settings),
    cards: (board.cards || []).map(cardPreview),
    edges: (board.edges || []).map((edge) => ({ ...edge, kind: normalizeEdgeKind(edge.kind) })),
    // 带上评论，导出的 JSON 才是完整的一块板；改完 PUT 回 whole 也认这个字段
    comments: board.comments || [],
  };
}

const TIDY_MODE_SET = new Set<string>(TIDY_MODES);

/**
 * timeline / kanban 要按规格里的 date / enum 字段分组，但 lib/layout.ts 是纯计算模块
 * （前后端共用，不能引 node:fs）——所以规格由这边喂进去。前端那条路喂的是 store.specs。
 */
function layoutSpecs(): Record<string, LayoutSpecLike> {
  const map: Record<string, LayoutSpecLike> = {};
  for (const spec of allSpecs()) map[spec.id] = { fields: spec.fields };
  return map;
}

/**
 * 服务端跑整理：与前端顶栏「整理」同一套算法（lib/layout.ts 是纯计算，两边共用）。
 *
 * 这条路会打点，而前端顶栏那条（本地算完走 `PUT /state`）不打——不是漏了：
 * 顶栏整理完当场给「撤销」，而 agent 调 `POST /tidy` 之后没有任何回退入口，
 * 一个 mode 传错就能把用户摆了半天的板推平。
 */
export async function tidyBoardLayout(
  id: string,
  rawMode: unknown,
  actor: BoardActor = "user",
): Promise<{ mode: TidyMode; moved: number; changed: number }> {
  if (rawMode !== undefined && (typeof rawMode !== "string" || !TIDY_MODE_SET.has(rawMode))) {
    throw badRequest(`未知整理模式；可选：${TIDY_MODES.join(" / ")}`);
  }
  const mode = (rawMode === undefined ? "tidy" : rawMode) as TidyMode;
  // Layout can yield (notably when loading dagre). Work on a snapshot and reject
  // stale results rather than overwriting another user's intervening edits.
  const board = structuredClone(store.requireBoard(id));
  const snapshot = JSON.stringify(board);
  let positions;
  try { positions = await runLayout(board.cards || [], board.edges || [], mode, { specs: layoutSpecs() }); }
  catch (error) { if (error instanceof RangeError) throw badRequest(error.message); throw error; }
  const current = store.requireBoard(id);
  if (JSON.stringify(current) !== snapshot) throw conflict("画板在整理计算期间已更新，请重新读取后重试");
  const before = new Map(board.cards.map((card) => [card.id, card]));
  const changed = positions.filter((place) => {
    const card = before.get(place.id);
    return card && (place.x !== card.x || place.y !== card.y);
  });
  // `moved` retains the historical scope count; `changed` is the actual change count.
  if (!changed.length) return { mode, moved: positions.length, changed: 0 };
  const checkpoint = captureCheckpoint(current, "tidy");
  store.mutateBoard(board.id, (target) => {
    const byId = new Map(changed.map((item) => [item.id, item]));
    for (const card of target.cards || []) {
      const next = byId.get(card.id);
      if (!next) continue;
      card.x = next.x;
      card.y = next.y;
    }
    pushActivity(target, {
      actor,
      action: "tidy",
      summary: `服务端整理（${mode}）：移动了 ${changed.length} 张卡片`,
      counts: { cards: changed.length },
      checkpoint,
    });
    target.updatedAt = Date.now();
  });
  return { mode, moved: positions.length, changed: changed.length };
}

/** 画板缩略数据：子画板卡用它在卡面上画出目标板的轮廓，所以只要几何与颜色。 */
export function boardPreview(id: string) {
  const board = store.requireBoard(id);
  const cards = (board.cards || []).map((card) => ({
    id: card.id,
    type: card.type,
    color: card.color,
    x: card.x,
    y: card.y,
    w: card.w,
    h: card.h,
    // 缩略图上要认得出是哪张卡，所以带一句标题；正文仍然不给
    title: cleanText(card.title || card.task?.goal || card.content || "", 60, { fallback: "" }),
  }));
  const byId = new Map(cards.map((card) => [card.id, card]));
  const edges = (board.edges || [])
    .map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return null;
      return {
        x1: from.x + from.w / 2,
        y1: from.y + from.h / 2,
        x2: to.x + to.w / 2,
        y2: to.y + to.h / 2,
      };
    })
    .filter(Boolean);
  return {
    id: board.id,
    name: board.name,
    updatedAt: board.updatedAt,
    counts: { cards: cards.length, edges: (board.edges || []).length },
    cards,
    edges,
  };
}

/** 导出成 Markdown（给人看 / 贴给 agent 当上下文）。 */
export function exportBoardMarkdown(id: string): string {
  const board = store.requireBoard(id);
  const cards = board.cards || [];
  const edges = board.edges || [];
  const comments = board.comments || [];
  const openComments = comments.filter((comment) => !comment.resolved);
  const byId = new Map(cards.map((card) => [card.id, card]));
  // 卡片评论就近摊在那张卡下面：agent 拿这份 md 改板子时，
  // 「这张卡要怎么改」必须跟卡片正文挨着，翻到文末再找一遍就没人看了
  const commentsByCard = new Map<string, BoardComment[]>();
  for (const comment of comments) {
    if (comment.target !== "card" || !comment.targetId) continue;
    if (!commentsByCard.has(comment.targetId)) commentsByCard.set(comment.targetId, []);
    commentsByCard.get(comment.targetId)!.push(comment);
  }
  const lines: string[] = [`# ${board.name}`, ""];
  lines.push(
    `> 画板 \`${board.id}\` · 卡片 ${cards.length} 张 · 连线 ${edges.length} 条` +
      (comments.length ? ` · 评论 ${comments.length} 条（未解决 ${openComments.length}）` : "") +
      ` · 导出于 ${new Date().toISOString()}`,
    "",
  );

  const byType = new Map<string, BoardCard[]>();
  for (const card of cards) {
    if (!byType.has(card.type)) byType.set(card.type, []);
    byType.get(card.type)!.push(card);
  }

  for (const [type, list] of byType) {
    lines.push(`## ${TYPE_FALLBACK_TITLE[type as BoardCard["type"]] || type}（${list.length}）`, "");
    for (const card of list) {
      lines.push(`### ${card.title || "(未命名)"}`);
      lines.push("");
      lines.push(`- id：\`${card.id}\``);
      // 类型专属行由卡片包贡献（cards/<type>/schema.ts 的 markdownLines）；
      // 公共行（链接 / 出处 / 文件名）不按类型分派——类型互转留下的残留字段也照导。
      // 行序机械保持原实现：只有 task 的块在公共行之前。
      const pack = serverPack(card.type);
      const packLines = pack?.schema.markdownLines?.(card) || [];
      if (pack?.schema.markdownBeforeCommon) lines.push(...packLines);
      if (card.link?.url) lines.push(`- 链接：${card.link.url}`);
      if (card.quote?.source) lines.push(`- 出处：${card.quote.source}`);
      if (card.file?.name) lines.push(`- 文件：${card.file.name}`);
      if (!pack?.schema.markdownBeforeCommon) lines.push(...packLines);
      // 未知类型（本机没有对应卡片包）：导出同样降级——字段原样列出来，内容一个字不丢
      if (!pack) {
        for (const [key, value] of Object.entries(card as unknown as Record<string, unknown>)) {
          if (["id", "type", "createdAt", "updatedAt", "createdBy", "x", "y", "w", "h", "z", "color", "title", "content", "agentPrompt", "frameId"].includes(key)) continue;
          lines.push(`- ${key}：${JSON.stringify(value)}`);
        }
        lines.push(`- （类型 \`${card.type}\` 在本机没有对应卡片包，字段按原样导出）`);
      }
      const body = card.content || card.task?.goal || "";
      if (body) {
        lines.push("");
        lines.push(body);
      }
      if (card.agentPrompt) {
        lines.push("");
        lines.push(`> agent 指令：${card.agentPrompt}`);
      }
      const cardComments = commentsByCard.get(card.id) || [];
      if (cardComments.length) {
        lines.push("");
        lines.push(...commentLines(cardComments, "评论"));
      }
      lines.push("");
    }
  }

  if (edges.length) {
    lines.push("## 连线", "");
    for (const edge of edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      const kind = KIND_LABEL[normalizeEdgeKind(edge.kind)] || "关联";
      // 语义两件套跟在标签后面：读这份 md 的 agent 要知道「这条关系有多强、归哪几条主线」
      const marks = [
        edge.label || "",
        edge.weight ? `强度 ${edge.weight}/5` : "",
        (edge.tags || []).length ? (edge.tags || []).map((tag) => `#${tag}`).join(" ") : "",
      ].filter(Boolean);
      lines.push(
        `- ${from.title || from.id} —[${[kind, ...marks].join(" · ")}]→ ${to.title || to.id}`,
      );
    }
    lines.push("");
  }

  // 卡片评论已经跟着卡片走了，这里只收画布上和连线上的那些
  const looseComments = comments.filter((comment) => comment.target !== "card");
  if (looseComments.length) {
    lines.push(`## 画布与连线上的评论（${looseComments.length}）`, "");
    for (const comment of looseComments) {
      lines.push(`### ${commentTargetLabel(board, comment)}`, "");
      lines.push(...commentLines([comment], ""));
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** 一组评论摊成 Markdown 引用块（正文 + 回复 + 状态），导出与卡片内联共用。 */
function commentLines(comments: BoardComment[], heading: string): string[] {
  const lines: string[] = [];
  if (heading) lines.push(`> **${heading}（${comments.length}）**`);
  for (const comment of comments) {
    const who = comment.createdBy === "agent" ? "agent" : "我";
    const state = comment.resolved ? "已解决" : "待处理";
    lines.push(`> - [${state}] ${who} \`${comment.id}\`：${comment.text.replace(/\n/g, " ")}`);
    for (const reply of comment.replies || []) {
      const replyWho = reply.createdBy === "agent" ? "agent" : "我";
      lines.push(`>   - 回复（${replyWho}）：${reply.text.replace(/\n/g, " ")}`);
    }
  }
  return lines;
}
