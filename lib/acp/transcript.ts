/**
 * ACP run 的流式 transcript：`<data>/runs/<runId>.jsonl`，一行一条、只增不改。
 *
 * 为什么单独存而不进 issues.json：session/update 是高频流水（一次 run 几百条很正常），
 * 塞进单文件全量读写的 Issue 存储会把每次落盘都拖成整库重写；jsonl append 是 O(1)。
 * 任务台轮询用行号做增量（?offset=N 只回第 N 条之后的），不上 SSE——沿用现有轮询节奏。
 */
import fs from "node:fs";
import path from "node:path";
import { RUNS_DIR } from "../config";

export interface TranscriptEntry {
  at: number;
  /** update = session/update 原文；status / permission_* / stderr 是客户端自己的记账 */
  type: "update" | "status" | "permission_request" | "permission_decision" | "stderr";
  [key: string]: unknown;
}

/** runId 由服务端生成（r_ 前缀），这里再验一遍防路径拼接踩出目录外 */
function fileOf(runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`非法 runId：${runId}`);
  return path.join(RUNS_DIR, `${runId}.jsonl`);
}

/**
 * 单个 run 的 transcript 上限。写到顶就停笔，只补一条「已截断」记号。
 *
 * 为什么必须有上限：这里收的是**别人进程**的 stdout —— 一个跑飞的 agent
 * （死循环刷日志、把整个仓库 cat 出来）能按 MB/s 的速度往这写，而 append 这条路上
 * 没有任何天然的刹车：run 不结束就一直写，磁盘满了先死的是画板本身（板文件也落在同一个盘上）。
 *
 * 为什么是 8 MB：`readTranscript` 每次轮询都把**整个文件**读进来逐行 JSON.parse
 * （见下面那个函数的注释：为有限流水做的取舍）。8 MB 已经是单次轮询几十毫秒、
 * 浏览器侧几万条记录的量级——再大，先撑不住的是任务台的渲染而不是磁盘。
 * 正常一次 run 是几百 KB，撞上限的基本只有「跑飞了」这一种情况。
 */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/** 本进程内已经封顶的 run（Next 分 bundle 下模块级变量不通用，挂 globalThis，同 acp/manager.ts） */
function cappedRuns(): Set<string> {
  const g = globalThis as any;
  if (!g.__blotboardTranscriptCapped) g.__blotboardTranscriptCapped = new Set<string>();
  return g.__blotboardTranscriptCapped as Set<string>;
}

export function appendTranscript(runId: string, entry: Omit<TranscriptEntry, "at"> & { at?: number }): void {
  try {
    const capped = cappedRuns();
    if (capped.has(runId)) return;
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const file = fileOf(runId);
    const line = `${JSON.stringify({ at: Date.now(), ...entry })}\n`;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* 还没有这个文件 */
    }
    if (size + Buffer.byteLength(line) > MAX_TRANSCRIPT_BYTES) {
      // 先记下「这个 run 封顶了」再写记号：记号本身也走 appendFileSync，
      // 靠这个 Set 保证它在本进程里只写一次（越线的那条正文就不要了）
      capped.add(runId);
      fs.appendFileSync(
        file,
        `${JSON.stringify({
          at: Date.now(),
          type: "status",
          status: "truncated",
          truncated: true,
          detail: `transcript 已达上限 ${MAX_TRANSCRIPT_BYTES} 字节，后续输出不再记录（run 本身继续跑）`,
        })}\n`,
      );
      console.warn(`[acp] transcript 写满上限，停止记录：${runId}`);
      return;
    }
    fs.appendFileSync(file, line);
  } catch (err) {
    // transcript 是观测面不是账本：写不进去只损失回放，不能反过来打断执行
    console.error(`[acp] transcript 写入失败（${runId}）：${String((err as Error)?.message || err)}`);
  }
}

/**
 * 增量读：跳过前 offset 行，返回之后的条目与新的 offset。
 * 全量读文件再按行切——run transcript 是有限流水（一次执行几百 KB 量级），
 * 不值得为它上流式读；真到那个量级先撑爆的是浏览器渲染。
 */
export function readTranscript(runId: string, offset = 0): { entries: TranscriptEntry[]; offset: number } {
  let raw = "";
  try {
    raw = fs.readFileSync(fileOf(runId), "utf8");
  } catch {
    return { entries: [], offset: 0 };
  }
  // 末尾没换行 = 最后一行还在写：不计入 offset，下一轮再读它的完整版
  const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
  const lines = complete.split("\n").filter((line) => line.trim());
  const start = Math.max(0, Math.min(offset, lines.length));
  const entries: TranscriptEntry[] = [];
  for (const line of lines.slice(start)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* 坏行（不该发生）：跳过这一条，别让整个接口 500 */
    }
  }
  return { entries, offset: lines.length };
}
