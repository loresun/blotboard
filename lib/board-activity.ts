/**
 * 工作日志：agent（或浏览器）通过批量入口改过板之后，在板上留下的那行痕迹。
 *
 * **存哪儿：板文件里的 `board.activity`**（不是单开一个文件）。理由三条：
 *  · 生命周期与评论完全同构——跟着板走、随板导出、板删了一起消失，
 *    不需要为它再造一套「板没了要去清谁」的规矩（快照是反的：那是救命用的，故意留着）；
 *  · 一次读板就把它带回来了，历史抽屉不用再打第二个口，轮询也顺带刷新；
 *  · 体量可控——上限 50 条、每条一百来字节，比一张卡还小；
 *    真要长期审计该走外部日志，那不是画板的活。
 *
 * **透传铁律的对偶**：评论是「不传就不动」，日志更严一格——**只由服务端写**。
 * 请求体里带 `activity` 一律忽略（whole / 信封 / 粘贴都一样），所以整表替换语义
 * 天然误伤不到它：replaceWhole 只赋值 cards / edges / comments，activity 原地不动。
 */
import { MAX_BOARD_ACTIVITY, type Board, type BoardActivity, type BoardActivityAction, type BoardActor } from "./types";

export interface ActivityInput {
  actor: BoardActor;
  action: BoardActivityAction;
  summary: string;
  counts?: Record<string, number>;
  /** 这次改动之前那一刻的快照 id；打点失败 / 功能关掉时是 null */
  checkpoint?: string | null;
}

/** 日志正文的长度上限：它是「一句话说清改了什么」，长了该去看快照 diff。 */
const MAX_SUMMARY = 200;

/**
 * 往板上追加一条日志（最新在前，超出上限滚掉最旧的）。
 * **就地改 target**，所以要在 store.mutateBoard 的回调里调用——
 * 跟这次业务改动同一次事务、同一次落盘，不额外写一遍盘。
 */
export function pushActivity(target: Board, input: ActivityInput): BoardActivity {
  const entry: BoardActivity = {
    at: Date.now(),
    actor: input.actor === "agent" ? "agent" : "user",
    action: input.action,
    summary: String(input.summary || "").slice(0, MAX_SUMMARY),
    ...(input.counts && Object.keys(input.counts).length ? { counts: input.counts } : {}),
    checkpoint: input.checkpoint || null,
  };
  target.activity = [entry, ...(target.activity || [])].slice(0, MAX_BOARD_ACTIVITY);
  return entry;
}

/** 老板子里没有这张表，读的时候补空数组（与 comments 同一处理）。 */
export function boardActivity(board: Board): BoardActivity[] {
  return board.activity || [];
}
