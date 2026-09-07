/**
 * 画板 → Goal Agent 的 Issue 单向同步。
 *
 * 数据归属：Issue 的**存放地**仍是 Goal Agent，但「这个需求是什么」的真源是画板上的那张卡。
 * 过去只在「转 Issue」那一刻推一次，之后卡片改了 Goal Agent 那边还是旧的，
 * 发起任务时 agent 读到的就是旧需求 —— 这个模块就是补上那条回推。
 *
 * 三条口径：
 * - **只推我们自己写的三个字段**（title / description / priority）。analysis、acceptanceCriteria、
 *   status 是 Goal Agent 侧（人或 agent）产生的，一律不碰，免得把那边的成果洗掉。
 * - **指纹去重**：推过去的正文算一个 hash 存在卡上，一样就不发请求 —— 改颜色、挪位置不惊动 Runner。
 * - **一块板一条串行链**：防抖合并连续编辑，同一块板的同步排队跑，不会两路并发写同一份账本。
 *
 * 反向（Goal Agent 改了回灌画板）刻意不做：画板才是这份需求的写入端。
 */
import crypto from "node:crypto";
import { normalizeBoardSettings, normalizeTaskField, normalizeIssueContext, cleanText, TYPE_FALLBACK_TITLE } from "./board-schema";
import { TASK_BACKEND } from "./features";
import { taskBackend } from "./integrations/task-backend";
import { mindmapOutlineLines } from "./mindmap";
import { excalidrawText } from "./search-text";
import * as store from "./storage";
import type { Board, BoardCard, IssueContextPolicy } from "./types";

/**
 * 编辑保存到真正推送之间的静默期：抽屉「停手 0.8 秒落一次盘」，
 * 连着改几处会落好几次盘，这里再合并一次，Goal Agent 那边只收到最后那一版。
 */
const DEBOUNCE_MS = Number(process.env.BLOTBOARD_ISSUE_SYNC_DEBOUNCE_MS || 1200);

/* ── Issue 正文的拼装（转 Issue 与同步共用同一份，两边永远拼出同样的东西） ── */

function describeCard(card: BoardCard | undefined): string | null {
  if (!card) return null;
  // 新类型没有普通正文，得各自给一句能用的摘要，否则注进 Issue 的就是一行空标题
  let extra = "";
  if (card.type === "ref" && card.ref?.items.length) {
    const titles = card.ref.items.slice(0, 6).map((item) => item.title).join("；");
    extra = `知识库「${card.ref.query}」${card.ref.items.length} 条：${titles}`;
  } else if (card.type === "book" && card.book?.bookId) {
    const book = card.book;
    extra = [`书库里的《${book.name}》`, book.subtitle, book.author ? `作者：${book.author}` : "", book.desc]
      .filter(Boolean)
      .join(" · ");
  } else if (card.type === "mindmap" && card.mindmap) {
    extra = mindmapOutlineLines(card.mindmap.root, 0).join(" ").replace(/\s+/g, " ");
  } else if (card.type === "todo" && card.todo?.items.length) {
    const open = card.todo.items.filter((item) => !item.done);
    extra = `待办 ${open.length}/${card.todo.items.length} 未完成：${open.slice(0, 8).map((item) => item.text).join("；")}`;
  } else if (card.type === "mermaid" && card.mermaid?.source) {
    extra = `Mermaid 图：${card.mermaid.source.replace(/\s+/g, " ").slice(0, 200)}`;
  } else if (card.type === "svg" && card.svg?.source) {
    extra = "一张 SVG 图";
  } else if (card.type === "excalidraw" && card.excalidraw?.source) {
    // .excalidraw JSON 灌进 Issue 描述没意义（一坨结构化字段），但画上写的字是有意义的
    const drawn = excalidrawText(card.excalidraw.source).replace(/\s+/g, " ").slice(0, 200);
    extra = drawn ? `一张 Excalidraw 自由画，画上写着：${drawn}` : "一张 Excalidraw 自由画";
  } else if (card.type === "html" && card.html?.url) {
    // 卡面是一个 iframe，注进 Issue 只能是那个地址——agent 要看内容得自己去开
    extra = `嵌在画板上的网页：${card.html.url}`;
  } else if (card.type === "board" && card.boardRef?.boardId) {
    extra = `子画板 ${card.boardRef.name || card.boardRef.boardId}`;
  }
  const text = cleanText(card.task?.goal || card.content || card.link?.url || extra, 400, { fallback: "" });
  return `- ${card.title || TYPE_FALLBACK_TITLE[card.type] || "卡片"}${text ? `：${text}` : ""}`;
}

/**
 * 按上下文策略收集要注入 Issue 描述的画板节点。
 * 默认 neighbors（沿连线一跳的上下游），与迁移前行为一致。
 */
function collectContext(board: Board, card: BoardCard, policy: IssueContextPolicy): string {
  const allowed = (item: BoardCard) => !policy.types.length || policy.types.includes(item.type);
  const byId = new Map((board.cards || []).map((item) => [item.id, item]));
  const describeAll = (cards: BoardCard[]) => cards.filter(allowed).map((item) => describeCard(item)).filter(Boolean) as string[];

  if (policy.mode === "none") return "";

  if (policy.mode === "all") {
    const others = describeAll((board.cards || []).filter((item) => item.id !== card.id));
    return others.length ? `本画板全部节点：\n${others.join("\n")}` : "";
  }

  const upstream = (board.edges || [])
    .filter((edge) => edge.to === card.id)
    .map((edge) => byId.get(edge.from))
    .filter((item): item is BoardCard => Boolean(item) && allowed(item!));
  const downstream = (board.edges || [])
    .filter((edge) => edge.from === card.id)
    .map((edge) => byId.get(edge.to))
    .filter((item): item is BoardCard => Boolean(item) && allowed(item!));

  const parts: string[] = [];
  if (policy.mode !== "downstream" && upstream.length) {
    parts.push(`上游关联节点：\n${describeAll(upstream).join("\n")}`);
  }
  if (policy.mode !== "upstream" && downstream.length) {
    parts.push(`下游关联节点：\n${describeAll(downstream).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** 卡片自带的 agent 指令片段（F8）：转 Issue / 发起任务时都要带上。 */
export function agentPromptOf(card: BoardCard): string {
  return cleanText(card.agentPrompt, 4000, { fallback: "" });
}

export interface IssuePayload {
  title: string;
  description: string;
  priority: string;
  /** title + description + priority 的指纹，用来判断「这一版推过了没有」 */
  hash: string;
}

/**
 * 一张任务卡当前应该对应的 Issue 正文。
 *
 * 转 Issue 与之后每一次同步都走这里 —— 只要卡片（以及它的上下文、评论、agent 指令）没变，
 * 拼出来的就是同一份，指纹也就一样。
 */
export function buildIssuePayload(board: Board, card: BoardCard, contextOverride?: unknown): IssuePayload {
  const boardPolicy = normalizeBoardSettings(board.settings).issueContext;
  const policy = contextOverride === undefined ? boardPolicy : normalizeIssueContext(contextOverride, boardPolicy);
  const context = collectContext(board, card, policy);
  const prompt = agentPromptOf(card);
  // 这张卡上还没处理的评论一起下发：评论就是「这里要改成什么样」，
  // 转 Issue 时把它落下，等于让执行的人看不到最要紧的那句话
  const notes = (board.comments || []).filter(
    (comment) => !comment.resolved && comment.target === "card" && comment.targetId === card.id,
  );
  const noteText = notes
    .map((comment) =>
      [`- ${comment.text}`, ...(comment.replies || []).map((reply) => `  - 追加：${reply.text}`)].join("\n"),
    )
    .join("\n");
  const description = [
    card.task?.goal || card.content || card.title,
    `来源：画板「${board.name}」卡片 ${card.id}`,
    context ? `画板上下文（该想法在画板上的关联节点，执行时可参考）：\n${context}` : "",
    noteText ? `卡片上待处理的评论（画板上标出来要改的地方）：\n${noteText}` : "",
    prompt ? `卡片附带的执行指令：\n${prompt}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const title = card.title || cleanText(card.content, 120, { fallback: "画板任务卡片" });
  const priority = card.task?.priority || "none";
  // 分隔符写成 `\u0000` 转义，而不是在源码里直接埋一个 0x00 字节：
  // 埋了的话 file/grep 会把整个文件判成二进制，`grep -r` 从此**悄悄跳过它**
  // （既不报错也不列出来——「代码里明明有这个字串却搜不到」就是这么来的）。
  // 转义与原字节运行时完全等价，已落盘的指纹 hash 一个字节都不会变。
  const hash = crypto
    .createHash("sha1")
    .update(`${title}\u0000${description}\u0000${priority}`)
    .digest("hex")
    .slice(0, 32);
  return { title, description, priority, hash };
}

/* ── 同步 ─────────────────────────────────────────── */

export interface CardSyncOutcome {
  cardId: string;
  issueId: string;
  /** synced = 真推了；skipped = 指纹没变；failed = Runner 那边没收下 */
  status: "synced" | "skipped" | "failed";
  error?: string;
}

export interface SyncReport {
  boardId: string;
  synced: number;
  skipped: number;
  failed: number;
  /** 画板设置成 off、又没带 force 时为 true（此时什么都没做） */
  disabled?: boolean;
  cards: CardSyncOutcome[];
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** 一块板一条链：防抖到点的那次和「立即同步」那次不会并发写同一份账本 */
const chains = new Map<string, Promise<unknown>>();

function issuedCards(board: Board, only?: Set<string>): BoardCard[] {
  return (board.cards || []).filter(
    (card) => card.type === "task" && card.task?.issueId && (!only || only.has(card.id)),
  );
}

/** 把一次同步的结果落回卡片；只有真有变化时才动 board.updatedAt。 */
function recordOutcomes(boardId: string, outcomes: CardSyncOutcome[], hashes: Map<string, string>): void {
  if (!outcomes.length) return;
  const now = Date.now();
  try {
    store.mutateBoard(boardId, (target) => {
      let touched = false;
      for (const outcome of outcomes) {
        if (outcome.status === "skipped") continue;
        const card = (target.cards || []).find((entry) => entry.id === outcome.cardId);
        // 这中间卡可能被删了、或者被解绑重连到别的 Issue 上，那这次结果就不该再写回去
        if (!card || card.task?.issueId !== outcome.issueId) continue;
        card.task = normalizeTaskField({
          ...card.task,
          ...(outcome.status === "synced"
            ? { issueSyncedAt: now, issueSyncHash: hashes.get(outcome.cardId) || null, issueSyncError: null }
            : { issueSyncError: outcome.error || "同步失败" }),
        });
        touched = true;
      }
      // 卡片的 updatedAt 刻意不动：这不是「用户改了这张卡」，只是同步账本
      if (touched) target.updatedAt = now;
      return touched;
    });
  } catch {
    /* 板被删了之类：同步账本写不进去不影响任何业务，下次编辑会重推 */
  }
}

/**
 * 把这块板上「转过 Issue 且内容变过」的卡片推给 Goal Agent。
 *
 * @param force 忽略指纹与画板开关，全部重推（手动「立即同步」、发起任务前的兜底都用它）
 * @param cardIds 只同步这几张（不传 = 整块板扫一遍）
 */
async function syncBoardIssues(
  boardId: string,
  options: { force?: boolean; cardIds?: string[] } = {},
): Promise<SyncReport> {
  const previous = chains.get(boardId) || Promise.resolve();
  const run = previous.catch(() => undefined).then(() => syncNow(boardId, options));
  chains.set(boardId, run);
  try {
    return await run;
  } finally {
    if (chains.get(boardId) === run) chains.delete(boardId);
  }
}

async function syncNow(boardId: string, options: { force?: boolean; cardIds?: string[] }): Promise<SyncReport> {
  const force = options.force === true;
  const empty: SyncReport = { boardId, synced: 0, skipped: 0, failed: 0, cards: [] };
  // 任务后端如今永远在（没配外部 Runner 时是 local），不再有「整体未配置」的分支
  let board: Board;
  try {
    board = store.requireBoard(boardId);
  } catch {
    return empty; // 板已经不在了：这次同步没有意义
  }
  if (!force && normalizeBoardSettings(board.settings).issueSync === "off") {
    return { ...empty, disabled: true };
  }

  const only = options.cardIds ? new Set(options.cardIds) : undefined;
  const targets = issuedCards(board, only);
  if (!targets.length) return empty;

  const hashes = new Map<string, string>();
  const outcomes: CardSyncOutcome[] = [];
  for (const card of targets) {
    const issueId = card.task!.issueId!;
    const payload = buildIssuePayload(board, card);
    // 上次推的就是这一版：不发请求。失败过的（有 issueSyncError）要重试，别卡死在那儿
    if (!force && card.task?.issueSyncHash === payload.hash && !card.task?.issueSyncError) {
      outcomes.push({ cardId: card.id, issueId, status: "skipped" });
      continue;
    }
    hashes.set(card.id, payload.hash);
    try {
      const result = await taskBackend.patchIssue(issueId, {
        title: payload.title,
        description: payload.description,
        priority: payload.priority,
      });
      // 后端对「Issue 不存在」是 200 + issue:null，不是 404 —— 得自己认出来
      //（goal-agent 与 local 同一口径；文案按后端分，goal-agent 链路一字不改）
      const issue = result?.issue ?? result;
      if (!issue || typeof issue !== "object" || !issue.id) {
        throw new Error(
          TASK_BACKEND === "goal-agent"
            ? "Goal Agent 里找不到这个 Issue（可能已被删除）"
            : "任务后端里找不到这个 Issue（可能已被删除）",
        );
      }
      outcomes.push({ cardId: card.id, issueId, status: "synced" });
    } catch (err) {
      outcomes.push({ cardId: card.id, issueId, status: "failed", error: String((err as Error)?.message || err) });
    }
  }

  recordOutcomes(boardId, outcomes, hashes);
  return {
    boardId,
    synced: outcomes.filter((item) => item.status === "synced").length,
    skipped: outcomes.filter((item) => item.status === "skipped").length,
    failed: outcomes.filter((item) => item.status === "failed").length,
    cards: outcomes,
  };
}

/**
 * 画板内容变了 → 排一次同步（防抖）。
 *
 * 所有写口都调它，判断「这次改动跟 Issue 有没有关系」交给指纹去做：
 * 没有转过 Issue 的板，这里只是取消并重设一个定时器，代价可以忽略。
 */
export function scheduleIssueSync(boardId: string): void {
  const existing = timers.get(boardId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(boardId);
    void syncBoardIssues(boardId).catch((err) => {
      console.warn(`[issue-sync] ${boardId} 同步失败：${String((err as Error)?.message || err)}`);
    });
  }, DEBOUNCE_MS);
  // 别让一个待发的同步吊住进程退出（冒烟脚本 / 测试里尤其明显）
  timer.unref?.();
  timers.set(boardId, timer);
}

/** 立刻同步（手动按钮、发起任务前）：先把还在防抖里的那一次取消，避免重复推。 */
export async function syncIssuesNow(
  boardId: string,
  options: { force?: boolean; cardIds?: string[] } = {},
): Promise<SyncReport> {
  const existing = timers.get(boardId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(boardId);
  }
  return syncBoardIssues(boardId, options);
}
