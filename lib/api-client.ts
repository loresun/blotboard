"use client";

/** 前端 fetch 封装：自动带同源写头，统一把 { ok:false, error } 变成异常。 */
import type {
  BoardComment,
  BoardDetail,
  BoardListItem,
  BoardNavResult,
  BoardCard,
  BoardEdge,
  CommentTarget,
  BoardPreviewData,
  BoardSearchResult,
  CardColor,
  EdgeStyle,
  CardType,
  NavOrder,
  NavSort,
  RefItem,
  RefMode,
  BoardSettings,
  EdgeKind,
  LiveTaskStatus,
  TaskIndexItem,
  UploadRecord,
} from "./types";
import type { AgentCommand } from "./agent-commands";
import type { Template, TemplateCategory, TemplateListItem } from "./template-schema";
import type { CardSpec, SpecCategory } from "./card-spec-schema";
import type { SpecListItem } from "./card-spec-store";
import type { BookSummary } from "./integrations/library-provider";
import type { IngestResult, ValidateReport } from "./card-ingest";
import type { EmbedRule } from "./embed-allow";
import type { PrintDoc } from "./export-print";
import type { BoardHistoryState } from "./board-history-types";
import { mediaTypeForName } from "./upload-accept";
import { browserStorageActive } from "./storage-mode";
import { browserBoards } from "./browser-board-repository";

const WEB_HEADERS = { "x-board-web": "1" };

/**
 * 改画板的请求都带上「我手上是哪一版」。
 *
 * 服务端据此回一个 stale 标记：写之前手上就不是最新版的话，
 * 前端不能把写完的新版本号认作自己的版本号——否则会漏掉别人在这中间写进去的东西
 * （之后条件拉取一路 unchanged，那次改动就永远看不到了）。
 */
function writeHeaders(since?: number | null): Record<string, string> {
  return since ? { ...WEB_HEADERS, "x-board-since": String(since) } : { ...WEB_HEADERS };
}

async function call<T = any>(method: string, path: string, body?: unknown, since?: number | null): Promise<T> {
  const base = writeHeaders(since);
  const response = await fetch(path, {
    method,
    headers: body == null ? base : { "content-type": "application/json", ...base },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 ${response.status}`);
  return data as T;
}

/** 导入画板的两种语义（服务端与浏览器库共用同一套说法，见 api.importBoards） */
export type BoardImportMode = "copy" | "restore";

export interface BoardImportSummary {
  imported: number;
  boardIds: string[];
  skipped: number;
  /** 导入侧发现的缺憾：附件没跟过来、卡片按原样收下…… 直接摆给用户看 */
  notes: string[];
}

/** 完整规格 + 开关状态（GET /api/card-specs?full=1） */
export type FullSpec = CardSpec & { enabled: boolean };

/** 一份自动快照（GET /api/boards/:id/checkpoints）；形状与 lib/checkpoints.ts 的 CheckpointInfo 一致 */
export interface BoardCheckpoint {
  stamp: string;
  reason: string;
  at: number;
  counts: { cards: number; edges: number; comments: number };
  bytes: number;
}

/* ── 本地 Issue（local 任务后端）的响应形状，任务台 /tasks 用 ── */

export interface LocalIssueRunInfo {
  id: string;
  status: string;
  mode: string;
  launchedAt: number;
  updatedAt: number;
  note?: string | null;
  prompt?: string;
  /** prompt = 复制转交（默认）；acp = 画板 spawn 的 agent 子进程在跑 */
  kind?: "prompt" | "acp";
  agentId?: string | null;
  agentName?: string | null;
  /** acp 专属：挂起的权限请求（ask 档位，等人选） */
  permissionRequest?: { at: number; title: string; options: { optionId: string; name: string; kind: string }[] } | null;
}

/* ── Runner 设置（ACP agent 注册表，/api/runner-settings） ── */

export interface RunnerAgentInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
  /** env 值不出服务端，只回 key 名 */
  envKeys: string[];
}

export interface RunnerSettingsInfo {
  backend: string;
  settings: {
    agents: RunnerAgentInfo[];
    defaultAgentId: string | null;
    permissionMode: "ask" | "auto";
  };
  /** 内置 ACP agent 预设（「一键添加」用，真源 lib/acp/presets.ts） */
  presets?: RunnerPresetInfo[];
}

export interface RunnerPresetInfo {
  key: string;
  name: string;
  command: string;
  args: string[];
  fallback?: { command: string; args: string[] };
  auth: string;
  note?: string;
}

/** 一次 ACP 连通性检测的结果（POST /api/runner-settings/probe） */
export interface AcpProbeResult {
  ok: boolean;
  stage: "spawn" | "initialize" | "session" | "done";
  command: string;
  args: string[];
  ms: number;
  protocolVersion: number | null;
  authMethods: string[];
  needsAuth: boolean;
  error: string | null;
  stderrTail: string | null;
  /* 探预设时才有 */
  presetKey?: string;
  name?: string;
  via?: "primary" | "fallback" | null;
  auth?: string;
  note?: string | null;
}

/** transcript 增量拉取的一页 */
export interface RunTranscriptPage {
  entries: { at: number; type: string; [key: string]: unknown }[];
  offset: number;
  run: {
    id: string;
    status: string;
    note: string | null;
    kind: string;
    agentName: string | null;
    permissionRequest: { at: number; title: string; options: { optionId: string; name: string; kind: string }[] } | null;
    updatedAt: number;
  };
}

export interface LocalIssueItem {
  id: string;
  number: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  labels: string[];
  boardId: string | null;
  cardId: string | null;
  createdAt: number;
  updatedAt: number;
  runs: LocalIssueRunInfo[];
  log: { at: number; event: string; detail?: string }[];
  /** 服务端算好的镜头桶（pending / in_progress / attention / done / aborted） */
  lens: string;
  boardName: string | null;
  cardTitle: string | null;
  /** 来源画板 / 卡片已删——只有任务台能看到这类 Issue */
  orphan: boolean;
  runCount: number;
  lastRun: { id: string; status: string; mode: string; updatedAt: number } | null;
}

export interface SpecCategoryItem {
  id: SpecCategory;
  label: string;
  hint: string;
  count: number;
}

export interface TemplateCategoryItem {
  id: TemplateCategory;
  label: string;
  hint: string;
  count: number;
}

/** apply / insert 的返回：新板 id + 这一批落下去的卡片、连线、待填卡 */
export interface TemplateApplied {
  boardId: string;
  board: BoardDetail;
  template: { id: string; name: string };
  cardIds: string[];
  edgeIds: string[];
  fillableIds: string[];
}

/**
 * 所有写接口的公共返回：写完之后这块板的版本号，
 * 外加 stale——「你写之前手上那一版就已经过期了」，这时前端要重拉整块板。
 */
export type Revised<T = Record<string, never>> = T & { updatedAt: number; stale?: boolean };

/** 一次 Issue 同步扫下来的结果（POST /api/boards/:id/issue-sync） */
export interface IssueSyncReport {
  synced: number;
  skipped: number;
  failed: number;
  disabled?: boolean;
  cards: { cardId: string; issueId: string; status: "synced" | "skipped" | "failed"; error?: string }[];
}

/** 连线可改的字段；外观三件套传 null = 恢复「跟随语义」 */
export interface EdgePatch {
  label?: string;
  kind?: EdgeKind;
  color?: CardColor | null;
  style?: EdgeStyle | null;
  width?: number | null;
  /** 关系强弱 1-5（语义，跟视觉的 width 分开）；null = 取消标注 */
  weight?: number | null;
  /** 关系标签，≤6 个；[] = 清空 */
  tags?: string[];
}

/** 引用资源库的一条（GET /api/resources 的 resources[]；形状与 lib/resources.ts 的 ResourceEntry 一致） */
export interface ResourceEntryInfo {
  cardId: string;
  boardId: string;
  boardName: string;
  boardGroup: string;
  /** 深链：新标签打开画板并定位到这张卡 */
  link: string;
  title: string;
  fields: Record<string, string | number | boolean | string[]>;
  updatedAt: number;
  createdAt: number;
}

/** 引用资源库清单（GET /api/resources 整体响应） */
export interface ResourceIndexInfo {
  spec: { id: string; name: string; enabled: boolean };
  total: number;
  counts: { kinds: Record<string, number>; statuses: Record<string, number> };
  resources: ResourceEntryInfo[];
  matched: number;
}

/** 帮助文档目录里的一页（GET /api/docs 的 groups[].docs[]；真源是 docs/guide/*.md 的 frontmatter） */
export interface DocMetaInfo {
  slug: string;
  title: string;
  summary: string;
  group: string;
  order: number;
  /** 正文首段的纯文本摘录，目录搜索用它当干草堆 */
  excerpt: string;
}

/** 帮助文档的一整页（GET /api/docs?slug=xxx） */
export interface DocEntryInfo extends DocMetaInfo {
  body: string;
}

export const api = {
  listBoards: () => browserStorageActive()
    ? browserBoards.listBoards()
    : call<{ boards: BoardListItem[] }>("GET", "/api/boards").then((data) => data.boards || []),

  /** 跨画板全文搜索（板名/分组 + 卡片内容） */
  searchBoards: (query: string) => browserStorageActive()
    ? browserBoards.searchBoards(query)
    : call<BoardSearchResult>("GET", `/api/boards/search?q=${encodeURIComponent(query)}`),

  /** 引用资源库（跨画板聚合的 agent-skill 规格卡）；过滤在服务端做，页面通常全量拉回来本地筛 */
  listResources: (query: { q?: string; kind?: string; status?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.kind) params.set("kind", query.kind);
    if (query.status) params.set("status", query.status);
    const qs = params.toString();
    return call<ResourceIndexInfo>("GET", `/api/resources${qs ? `?${qs}` : ""}`);
  },

  /* ── 帮助文档（docs/guide/*.md，只读） ─────────────── */

  listDocs: () => call<{ total: number; groups: { name: string; docs: DocMetaInfo[] }[] }>("GET", "/api/docs"),

  getDoc: (slug: string) =>
    call<{ doc: DocEntryInfo }>("GET", `/api/docs?slug=${encodeURIComponent(slug)}`).then((data) => data.doc),

  /**
   * 导入画板：body 直接放**导出文件的原文**（画板包 JSON / 单块板 JSON / 导出的 HTML 都认）。
   *
   * · copy（默认）一律当新板收下，绝不动已有的板——别人发来的文件走这条；
   * · restore 保住原 id、同 id 覆盖——恢复自己的备份走这条。
   * 浏览器库没有服务端，同一份文件在本地解析后并进 IndexedDB，语义一一对应。
   */
  async importBoards(payload: string, mode: BoardImportMode = "copy"): Promise<BoardImportSummary> {
    if (browserStorageActive()) {
      const result = await browserBoards.importBundle(payload, mode === "restore" ? "merge" : "copy");
      // notes 原样往上传：附件缺件之类的话不转告，用户看到的就只有一句「已导入 N 块」
      return { imported: result.imported, boardIds: result.boardIds, skipped: 0, notes: result.notes };
    }
    const params = new URLSearchParams(
      mode === "restore" ? { mode: "restore", onConflict: "replace" } : { mode: "copy" },
    );
    const response = await fetch(`/api/boards/import?${params.toString()}`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8", ...WEB_HEADERS },
      body: payload,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `导入失败 ${response.status}`);
    return {
      imported: (data.imported || []).length,
      boardIds: (data.imported || []).map((item: { id: string }) => item.id),
      skipped: (data.skipped || []).length,
      notes: data.notes || [],
    };
  },

  createBoard: (name: string, options: { parentId?: string; group?: string } = {}) => browserStorageActive()
    ? browserBoards.createBoard(name, options)
    : call<{ board: BoardListItem }>("POST", "/api/boards", { name, ...options }).then((data) => data.board),

  getBoard: (boardId: string) => browserStorageActive()
    ? browserBoards.getBoard(boardId)
    : call<{ board: BoardDetail }>("GET", `/api/boards/${boardId}`).then((data) => data.board),

  /**
   * 条件拉取：本地这块板的 updatedAt 与服务端一致时，服务端只回一个
   * `{ unchanged: true }`（几十字节），这里返回 null——调用方据此跳过整块重建。
   * 轮询专用；要「无论如何拿到整块板」用上面的 getBoard。
   */
  getBoardSince: (boardId: string, since: number | null | undefined) => browserStorageActive()
    ? browserBoards.getBoardSince(boardId, since)
    : call<{ board?: BoardDetail; unchanged?: boolean }>(
      "GET",
      since ? `/api/boards/${boardId}?since=${since}` : `/api/boards/${boardId}`,
    ).then((data) => (data.unchanged ? null : (data.board as BoardDetail))),

  renameBoard: (boardId: string, name: string) => browserStorageActive()
    ? browserBoards.renameBoard(boardId, name)
    : call<{ board: BoardDetail }>("PATCH", `/api/boards/${boardId}`, { name }).then((data) => data.board),

  patchBoard: (boardId: string, patch: Record<string, unknown>) => browserStorageActive()
    ? browserBoards.patchBoard(boardId, patch)
    : call<{ board: BoardListItem }>("PATCH", `/api/boards/${boardId}`, patch).then((data) => data.board),

  patchBoardSettings: (boardId: string, settings: Partial<BoardSettings>) => browserStorageActive()
    ? browserBoards.patchBoardSettings(boardId, settings)
    : call<{ board: BoardDetail }>("PATCH", `/api/boards/${boardId}`, { settings }).then((data) => data.board),

  /**
   * PDF 排版用的分块产物（`format=print`）。内容与单文件 HTML 导出同源，
   * 分页 / 纸张 / 页码在浏览器那侧算（lib/export-pdf.ts）。
   */
  printDoc: (boardId: string, options: { comments?: boolean; q?: string; types?: string[]; ids?: string[] } = {}) => {
    const params = new URLSearchParams({ format: "print" });
    if (options.comments) params.set("comments", "1");
    if (options.q?.trim()) params.set("q", options.q.trim());
    if (options.types?.length) params.set("types", options.types.join(","));
    if (options.ids?.length) params.set("ids", options.ids.join(","));
    return call<{ doc: PrintDoc }>("GET", `/api/boards/${encodeURIComponent(boardId)}/export?${params}`).then(
      (data) => data.doc,
    );
  },

  exportBoardJson: (boardId: string) => browserStorageActive()
    ? browserBoards.exportBoardJson(boardId)
    : call<{ board: Record<string, unknown> }>("GET", `/api/boards/${boardId}/export?format=json`).then((data) => data.board),

  async exportBoardMarkdown(boardId: string): Promise<string> {
    const response = await fetch(`/api/boards/${boardId}/export?format=md`, { headers: WEB_HEADERS });
    if (!response.ok) throw new Error(`导出失败 ${response.status}`);
    return response.text();
  },

  deleteBoard: (boardId: string) => browserStorageActive() ? browserBoards.deleteBoard(boardId) : call("DELETE", `/api/boards/${boardId}`),

  /* ── 改板安全网：快照与工作日志 ─────────────────────
     工作日志随整块板一起下发（board.activity），所以这里只有快照那三口。 */

  tidyBoard: (boardId: string, mode: string) => browserStorageActive() ? browserBoards.tidyBoard(boardId, mode) : call<{ moved: number; changed: number }>("POST", `/api/boards/${boardId}/tidy`, { mode }),
  boardHistory: (boardId: string) => browserStorageActive()
    ? Promise.resolve({ history: { entries: [], canUndo: false, canRedo: false, cursor: 0, limit: 0, maxBytes: 0, warning: "浏览器存储目前不提供连续撤销历史，请使用全库备份" } satisfies BoardHistoryState })
    : call<{ history: BoardHistoryState }>("GET", `/api/boards/${boardId}/history`),
  stepHistory: (boardId: string, action: "undo" | "redo", since: number) =>
    call<{ board: BoardDetail; history: BoardHistoryState; label: string }>("POST", `/api/boards/${boardId}/history`, { action }, since),

  listCheckpoints: (boardId: string) => browserStorageActive()
    ? Promise.resolve({ enabled: false, keep: 0, checkpoints: [] as BoardCheckpoint[] })
    : call<{ enabled: boolean; keep: number; checkpoints: BoardCheckpoint[] }>(
      "GET",
      `/api/boards/${boardId}/checkpoints`,
    ),

  restoreCheckpoint: (boardId: string, stamp: string) =>
    call<{ board: BoardDetail; restored: string; checkpoint: string | null }>(
      "POST",
      `/api/boards/${boardId}/checkpoints/${encodeURIComponent(stamp)}/restore`,
    ),

  deleteCheckpoint: (boardId: string, stamp: string) =>
    call<{ removed: string }>("DELETE", `/api/boards/${boardId}/checkpoints/${encodeURIComponent(stamp)}`),

  saveState: (boardId: string, payload: { viewport?: unknown; cards?: unknown }, since?: number | null) => browserStorageActive()
    ? browserBoards.saveState(boardId, payload as { viewport?: unknown; cards?: any[] })
    : call<Revised<{ applied: number }>>("PUT", `/api/boards/${boardId}/state`, payload, since),

  /** 批量改卡：一次请求、服务端一次事务一次落盘（替代过去的 for 循环单条 PATCH）。 */
  patchCardsBulk: (boardId: string, ids: string[], patch: Record<string, unknown>, since?: number | null) => browserStorageActive()
    ? browserBoards.patchCardsBulk(boardId, ids, patch)
    : call<Revised<{ cards: BoardCard[]; updated: number }>>(
      "PATCH",
      `/api/boards/${boardId}/cards`,
      { ids, patch },
      since,
    ),

  /** 批量删卡：同上。 */
  deleteCardsBulk: (boardId: string, ids: string[], since?: number | null) => browserStorageActive()
    ? browserBoards.deleteCardsBulk(boardId, ids)
    : call<Revised<{ removed: string[] }>>("DELETE", `/api/boards/${boardId}/cards`, { ids }, since),

  replaceWhole: (boardId: string, payload: unknown) => browserStorageActive()
    ? browserBoards.replaceWhole(boardId, payload)
    : call<{ board: BoardDetail }>("PUT", `/api/boards/${boardId}/whole`, payload).then((data) => data.board),

  createCard: (boardId: string, payload: Record<string, unknown>, since?: number | null) => browserStorageActive()
    ? browserBoards.createCard(boardId, payload)
    : call<Revised<{ card: BoardCard }>>("POST", `/api/boards/${boardId}/cards`, payload, since),

  patchCard: (boardId: string, cardId: string, payload: Record<string, unknown>, since?: number | null) => browserStorageActive()
    ? browserBoards.patchCard(boardId, cardId, payload)
    : call<Revised<{ card: BoardCard }>>("PATCH", `/api/boards/${boardId}/cards/${cardId}`, payload, since),

  deleteCard: (boardId: string, cardId: string, since?: number | null) => browserStorageActive()
    ? browserBoards.deleteCard(boardId, cardId)
    : call<Revised>("DELETE", `/api/boards/${boardId}/cards/${cardId}`, undefined, since),

  /** 粘贴一批卡片（含批次内部的连线）：一次请求、服务端一次事务一次落盘 */
  pasteCards: (
    boardId: string,
    payload: { cards: Record<string, unknown>[]; edges?: Record<string, unknown>[]; at?: { x: number; y: number } | null },
    since?: number | null,
  ) => browserStorageActive()
    ? browserBoards.pasteCards(boardId, payload)
    : call<Revised<{ cards: BoardCard[]; edges: BoardEdge[] }>>("POST", `/api/boards/${boardId}/paste`, payload, since),

  createEdge: (
    // id / 外观字段是给「撤销删除」用的：连线要带着原来的 id 和样子回来
    boardId: string,
    payload: { from: string; to: string; label?: string; kind?: EdgeKind; id?: string } & Record<string, unknown>,
    since?: number | null,
  ) => browserStorageActive()
    ? browserBoards.createEdge(boardId, payload)
    : call<Revised<{ edge: BoardEdge }>>("POST", `/api/boards/${boardId}/edges`, payload, since),

  patchEdge: (boardId: string, edgeId: string, payload: EdgePatch, since?: number | null) => browserStorageActive()
    ? browserBoards.patchEdge(boardId, edgeId, payload)
    : call<Revised<{ edge: BoardEdge }>>("PATCH", `/api/boards/${boardId}/edges/${edgeId}`, payload, since),

  runnerIssue: (issueId: string) => call<any>("GET", `/api/runner/issues/${encodeURIComponent(issueId)}`),
  patchRunnerIssue: (issueId: string, patch: Record<string, unknown>) =>
    call<any>("PATCH", `/api/runner/issues/${encodeURIComponent(issueId)}`, patch),
  /** 任务产出（真源在 Goal Agent，画板只是把它接回卡片） */
  taskArtifacts: (taskId: string) =>
    call<any>("GET", `/api/runner/artifacts?taskId=${encodeURIComponent(taskId)}&limit=50`),
  artifactPreview: (artifactId: string) =>
    call<any>("GET", `/api/runner/artifacts/${encodeURIComponent(artifactId)}/preview?maxBytes=20000`),

  boardPreview: (boardId: string) => browserStorageActive()
    ? browserBoards.boardPreview(boardId)
    : call<BoardPreviewData>("GET", `/api/boards/${boardId}/preview`),

  deleteEdge: (boardId: string, edgeId: string, since?: number | null) => browserStorageActive()
    ? browserBoards.deleteEdge(boardId, edgeId)
    : call<Revised>("DELETE", `/api/boards/${boardId}/edges/${edgeId}`, undefined, since),

  /* ── 评论 ─────────────────────────────────────────
     整块板的 GET 已经带了 comments，前端画气泡用那一份；
     这里几个口都是写操作，只有 listComments 是给「只想要意见清单」的场景留的。 */

  listComments: (boardId: string, status: "open" | "resolved" | "all" = "open") =>
    call<{ comments: BoardComment[]; total: number }>(
      "GET",
      `/api/boards/${boardId}/comments?status=${status}`,
    ),

  createComment: (
    boardId: string,
    // 同上：撤销删除时要把原来那条批注（连 id、已解决状态、回复）整条放回去
    payload: {
      target: CommentTarget;
      targetId?: string | null;
      text: string;
      x?: number | null;
      y?: number | null;
      id?: string;
    } & Record<string, unknown>,
    since?: number | null,
  ) => browserStorageActive()
    ? browserBoards.createComment(boardId, payload)
    : call<Revised<{ comment: BoardComment }>>("POST", `/api/boards/${boardId}/comments`, payload, since),

  patchComment: (
    boardId: string,
    commentId: string,
    payload: { text?: string; resolved?: boolean; x?: number | null; y?: number | null },
    since?: number | null,
  ) => browserStorageActive()
    ? browserBoards.patchComment(boardId, commentId, payload)
    : call<Revised<{ comment: BoardComment }>>(
      "PATCH",
      `/api/boards/${boardId}/comments/${commentId}`,
      payload,
      since,
    ),

  replyComment: (boardId: string, commentId: string, text: string, since?: number | null) => browserStorageActive()
    ? browserBoards.replyComment(boardId, commentId, text)
    : call<Revised<{ comment: BoardComment }>>(
      "POST",
      `/api/boards/${boardId}/comments/${commentId}/replies`,
      { text },
      since,
    ),

  deleteComment: (boardId: string, commentId: string, since?: number | null) => browserStorageActive()
    ? browserBoards.deleteComment(boardId, commentId)
    : call<Revised>("DELETE", `/api/boards/${boardId}/comments/${commentId}`, undefined, since),

  /** 知识库检索（服务端代理）；混合检索慢，调用方要给 loading 态 */
  searchAidocs: (payload: { query: string; mode?: RefMode; limit?: number; platform?: string }) =>
    call<{ query: string; mode: RefMode; total: number; items: RefItem[] }>("POST", "/api/aidocs/search", payload),

  /** 本机书库书目（服务端代理）；筛选在前端做，这里一次拉全量 */
  listBooks: () => call<{ total: number; query: string; books: BookSummary[] }>("GET", "/api/books"),

  taskStatuses: (boardId: string) => browserStorageActive()
    ? Promise.resolve({} as Record<string, LiveTaskStatus>)
    : call<{ statuses: Record<string, LiveTaskStatus> }>("GET", `/api/boards/${boardId}/task-status`).then(
      (data) => data.statuses || {},
    ),

  taskIndex: () => call<{ tasks: TaskIndexItem[] }>("GET", "/api/boards/tasks").then((data) => data.tasks || []),

  /** 卡片导航页的数据源：跨画板卡片索引（时间排序 + 分组/画板/类型/关键词收窄 + 翻页） */
  cardIndex: (options: {
    group?: string | null;
    boardId?: string | null;
    query?: string;
    types?: CardType[];
    sort?: NavSort;
    order?: NavOrder;
    limit?: number;
    offset?: number;
  } = {}) => {
    const params = new URLSearchParams();
    // 空串是「未分组」，不能当没传——所以判 null/undefined 而不是判真值
    if (options.group !== null && options.group !== undefined) params.set("group", options.group);
    if (options.boardId) params.set("board", options.boardId);
    if (options.query) params.set("q", options.query);
    if (options.types?.length) params.set("types", options.types.join(","));
    if (options.sort) params.set("sort", options.sort);
    if (options.order) params.set("order", options.order);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    return browserStorageActive()
      ? browserBoards.cardIndex(options)
      : call<BoardNavResult>("GET", `/api/boards/cards?${params.toString()}`);
  },

  cardToIssue: (boardId: string, cardId: string) =>
    call<{ alreadyIssued?: boolean; issue?: { id: string; number: string | null }; card: BoardCard }>(
      "POST",
      `/api/boards/${boardId}/cards/${cardId}/issue`,
    ),

  /** 把这张卡的最新内容推给 Goal Agent（画板 → Issue 单向），手动触发用 */
  syncCardIssue: (boardId: string, cardId: string, force = false) =>
    call<Revised<{ synced: boolean; card: BoardCard }>>(
      "PUT",
      `/api/boards/${boardId}/cards/${cardId}/issue`,
      { force },
    ),

  /** 整块板扫一遍，把内容变过的 Issue 推过去 */
  syncBoardIssues: (boardId: string, force = false) =>
    call<Revised<IssueSyncReport>>("POST", `/api/boards/${boardId}/issue-sync`, { force }),

  /** 卡片发起执行；带 agentId = 交给本机注册的 ACP agent 真跑（任何任务后端下都成立） */
  launchCard: (boardId: string, cardId: string, mode: "implement" | "analyze", agentId?: string | null) =>
    call<{ task: { sessionId: string | null }; card: BoardCard }>(
      "POST",
      `/api/boards/${boardId}/cards/${cardId}/launch`,
      { mode, ...(agentId ? { agentId } : {}) },
    ),

  runnerTask: (taskId: string) => call<any>("GET", `/api/runner/tasks/${encodeURIComponent(taskId)}`),

  /* ── 本地 Issue（local 任务后端；其他后端下这些端点回 501） ── */

  listIssues: (options: { board?: string | null; status?: string; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.board) params.set("board", options.board);
    if (options.status) params.set("status", options.status);
    if (options.q) params.set("q", options.q);
    const search = params.toString();
    return call<{ issues: LocalIssueItem[]; total: number; counts: Record<string, number> }>(
      "GET",
      `/api/issues${search ? `?${search}` : ""}`,
    );
  },

  getIssue: (issueId: string) =>
    call<{ issue: LocalIssueItem; prompt: string }>("GET", `/api/issues/${encodeURIComponent(issueId)}`),

  patchLocalIssue: (issueId: string, patch: Record<string, unknown>) =>
    call<{ issue: LocalIssueItem }>("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, patch),

  /** run 状态回写（任务台的「中止」用；acp run 改 aborted 会触发 cancel 链路） */
  patchLocalRun: (issueId: string, runId: string, patch: Record<string, unknown>) =>
    call<{ issue: LocalIssueItem; run: LocalIssueRunInfo }>(
      "PATCH",
      `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}`,
      patch,
    ),

  /** 对 Issue 直接发起执行（任务台派单口；带 agentId = ACP 真跑，不带 = 生成 prompt） */
  launchIssue: (issueId: string, payload: { mode?: "implement" | "analyze"; agentId?: string }) =>
    call<{ task: { sessionId: string | null }; issue: LocalIssueItem }>(
      "POST",
      `/api/issues/${encodeURIComponent(issueId)}/launch`,
      payload,
    ),

  /** ACP run 的流式 transcript 增量页（offset 用上一页响应里的值） */
  runTranscript: (issueId: string, runId: string, offset = 0) =>
    call<RunTranscriptPage>(
      "GET",
      `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/transcript${offset ? `?offset=${offset}` : ""}`,
    ),

  /** 兑现挂起的权限请求（ask 档位） */
  resolveRunPermission: (issueId: string, runId: string, optionId: string) =>
    call<{ run: LocalIssueRunInfo; issue: LocalIssueItem }>(
      "POST",
      `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/permission`,
      { optionId },
    ),

  runnerSettings: () => call<RunnerSettingsInfo>("GET", "/api/runner-settings"),

  patchRunnerSettings: (patch: Record<string, unknown>) =>
    call<RunnerSettingsInfo>("PATCH", "/api/runner-settings", patch),

  /** ACP 连通性检测：presetKey（探预设，含 npx 兜底）/ agentId（探已注册的）/ command+args（探草稿） */
  probeAcpAgent: (payload: { presetKey?: string; agentId?: string; command?: string; args?: string[]; cwd?: string }) =>
    call<{ result: AcpProbeResult }>("POST", "/api/runner-settings/probe", payload).then((data) => data.result),

  listAgentCommands: () =>
    call<{ commands: AgentCommand[] }>("GET", "/api/agent-commands").then((data) => data.commands || []),

  createAgentCommand: (payload: Partial<AgentCommand>) =>
    call<{ command: AgentCommand }>("POST", "/api/agent-commands", payload).then((data) => data.command),

  updateAgentCommand: (id: string, payload: Partial<AgentCommand>) =>
    call<{ command: AgentCommand }>("PATCH", `/api/agent-commands/${encodeURIComponent(id)}`, payload).then(
      (data) => data.command,
    ),

  deleteAgentCommand: (id: string) => call("DELETE", `/api/agent-commands/${encodeURIComponent(id)}`),

  dispatchAgentTask: (goal: string) => call<any>("POST", "/api/runner/tasks", { goal }),

  listTemplates: () =>
    call<{ templates: TemplateListItem[] }>("GET", "/api/templates").then((data) => data.templates || []),

  templateCategories: () =>
    call<{ categories: TemplateCategoryItem[] }>("GET", "/api/templates/categories").then((data) => data.categories || []),

  getTemplate: (templateId: string) =>
    call<{ template: Template }>("GET", `/api/templates/${encodeURIComponent(templateId)}`).then((data) => data.template),

  applyTemplate: (templateId: string, name?: string) =>
    call<TemplateApplied>("POST", `/api/templates/${encodeURIComponent(templateId)}/apply`, name ? { name } : {}),

  insertTemplate: (templateId: string, boardId: string) =>
    call<TemplateApplied>("POST", `/api/templates/${encodeURIComponent(templateId)}/insert`, { boardId }),

  /* ── 卡片包（20 个原生包的开关） ─────────────────── */

  listCardPacks: () =>
    call<{ packs: { type: string; label: string; icon: string; enabled: boolean; defaultEnabled: boolean }[] }>(
      "GET",
      "/api/card-packs",
    ),

  setCardPackEnabled: (type: string, enabled: boolean) =>
    call<{ packs: { type: string; label: string; icon: string; enabled: boolean; defaultEnabled: boolean }[] }>(
      "PATCH",
      "/api/card-packs",
      { type, enabled },
    ),

  /* ── 卡片规格（插件 + 开关） ───────────────────── */

  listSpecs: () =>
    call<{ specs: SpecListItem[]; categories: SpecCategoryItem[] }>("GET", "/api/card-specs"),

  /** 带字段定义的完整规格：渲染规格卡与编辑表单都要它，一次拉完 */
  /** HTML 嵌入卡的白名单现状（编辑器用它在输入框旁边预判地址能不能嵌） */
  embedAllow: () => call<{ spec: string; rules: EmbedRule[]; description: string }>("GET", "/api/embed-allow"),

  listFullSpecs: () =>
    call<{ specs: FullSpec[]; categories: SpecCategoryItem[] }>("GET", "/api/card-specs?full=1"),

  getSpec: (specId: string) =>
    call<{ spec: CardSpec; enabled: boolean; prompt: string }>("GET", `/api/card-specs/${encodeURIComponent(specId)}`),

  setSpecEnabled: (specId: string, enabled: boolean) =>
    call<{ spec: SpecListItem }>("PATCH", `/api/card-specs/${encodeURIComponent(specId)}`, { enabled }).then(
      (data) => data.spec,
    ),

  deleteSpec: (specId: string) => call("DELETE", `/api/card-specs/${encodeURIComponent(specId)}`),

  saveSpec: (spec: Record<string, unknown>, overwrite = false) =>
    call<{ spec: CardSpec }>("POST", "/api/card-specs", { ...spec, overwrite }).then((data) => data.spec),

  /** 拿一份 schema / 提示词文本（裸响应，不裹 ok） */
  async specSchemaText(specId: string | null, format: "schema" | "prompt"): Promise<string> {
    const path = specId ? `/api/card-specs/${encodeURIComponent(specId)}/schema` : "/api/card-specs/schema";
    const response = await fetch(`${path}${format === "prompt" ? "?format=prompt" : ""}`, { headers: WEB_HEADERS });
    if (!response.ok) throw new Error(`读取失败 ${response.status}`);
    return response.text();
  },

  /** 干跑校验一段信封 JSON（不落库） */
  validateEnvelope: (envelope: unknown) =>
    call<{ report: ValidateReport }>("POST", "/api/card-specs/validate", envelope as Record<string, unknown>).then(
      (data) => data.report,
    ),

  /** 把信封落进某块画板 */
  ingestEnvelope: (boardId: string, envelope: unknown) =>
    call<IngestResult>("POST", `/api/boards/${encodeURIComponent(boardId)}/ingest`, envelope as Record<string, unknown>),

  /** 导出成信封格式（交换格式，别人也能读） */
  exportEnvelope: (boardId: string, onlyData = false) =>
    call<{ envelope: Record<string, unknown> }>(
      "GET",
      `/api/boards/${encodeURIComponent(boardId)}/export?format=cards${onlyData ? "&only=data" : ""}`,
    ).then((data) => data.envelope),

  async upload(file: File): Promise<UploadRecord> {
    const response = await fetch("/api/uploads", {
      method: "POST",
      headers: {
        // 浏览器对 .m4a / .mov / .flac 常给空串，按扩展名兜一个规范 MIME（真源 lib/upload-accept.ts）
        "content-type": file.type || mediaTypeForName(file.name),
        "x-file-name": encodeURIComponent(file.name),
        ...WEB_HEADERS,
      },
      body: file,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || "上传失败");
    return data.upload as UploadRecord;
  },
};
