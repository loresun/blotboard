/**
 * 归一化原语（id 规则 / 文本清洗 / 数值 clamp / 各类上限）。
 *
 * 从 lib/board-schema.ts 拆出来的底座：卡片包的 schema（cards/&lt;type&gt;/schema.ts）
 * 与 board-schema 本体都要用它，单独成模块是为了让依赖保持无环——
 * board-schema → card-registry → cards/&lt;type&gt;/schema → 这里。
 * 旧的导入路径不受影响：board-schema 原样 re-export 这里的一切。
 */
import crypto from "node:crypto";
import { badRequest } from "./http";

export const BOARD_ID_RE = /^b_[a-z0-9_]+$/;
export const CARD_ID_RE = /^c_[a-z0-9_]+$/;
export const EDGE_ID_RE = /^e_[a-z0-9_]+$/;
/** 评论 id 与卡片 id 不会撞：CARD_ID_RE 要求 `c` 后面紧跟下划线，`cm_` 落不进去 */
export const COMMENT_ID_RE = /^cm_[a-z0-9_]+$/;
export const COMMENT_REPLY_ID_RE = /^cr_[a-z0-9_]+$/;
export const UPLOAD_ID_RE = /^web-\d{13}-[a-f0-9]{12}\.[a-z0-9]+$/;

export const MAX_AGENT_PROMPT = 4000;
export const MAX_TITLE = 300;
export const MAX_CONTENT = 20_000;
export const MAX_NAME = 60;
export const MAX_EDGE_LABEL = 120;
/** 一条连线最多挂几个标签：再多就该把这层关系拆成卡片，而不是往线上堆 */
export const MAX_EDGE_TAGS = 6;
/** 单个标签的长度：标签是「一个词」，写句子该用 label */
export const MAX_EDGE_TAG = 20;

export const URL_RE = /^https?:\/\/[^\s"'<>]{3,2048}$/i;

/** svg / mermaid 源码（以及 excalidraw 的文本兜底路径）的长度上限。 */
export const MAX_DIAGRAM_SOURCE = 40_000;

export function newId(prefix: "b" | "c" | "e" | "cm" | "cr"): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

export function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  { round = true }: { round?: boolean } = {},
): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.min(max, Math.max(min, num));
  return round ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

/**
 * 「建卡严」的枚举闸门：单卡新建 / 改卡 / 连线上收到不在白名单里的值就当场 400，
 * 并把合法值列出来。
 *
 * 为什么值得单开一个函数：这些字段原来一律**静默兜底**（color 非法 → slate、
 * kind 非法 → rel），调用方——尤其是 agent——会以为自己设置成功了，
 * 直到打开画板才发现颜色不对，而那时已经无从判断是哪一步吞掉的。
 *
 * 三条边界：
 *  · `undefined` / `null` / `""` 一律放行——那是「不设置 / 跟随默认」，不是错值；
 *  · 只在**建卡严**的入口用（POST/PATCH 单卡、连线）。whole / 粘贴 / 信封是「收卡宽」的路，
 *    仍旧兜底，不能因为一个颜色把整块板打回去；
 *  · 未知类型卡片的**专属字段**照旧原样透传（透传铁律），这里管的只是公共字段。
 */
export function assertEnumValue(
  value: unknown,
  allowed: readonly string[],
  field: string,
  { hint = "" }: { hint?: string } = {},
): void {
  if (value === undefined || value === null || value === "") return;
  const text = String(value);
  if (allowed.includes(text)) return;
  throw badRequest(
    `${field}「${text}」不是合法取值——可选：${allowed.join(" / ")}${hint ? `（${hint}）` : ""}`,
  );
}

export function cleanText(value: unknown, max: number, { fallback = "" }: { fallback?: string } = {}): string {
  const text = String(value ?? "").replace(/\x00/g, "").trim();
  if (!text) return fallback;
  return text.slice(0, max);
}

/* ── 「本质是一段源码 / JSON 字符串」的字段 ──────────────
 *
 * 这类字段（excalidraw.source / mermaid.source / svg.source）在库里永远是字符串，
 * 但调用方——尤其是 agent——很自然会把**解析好的对象**直接塞进来：
 * `.excalidraw` 文件 JSON.parse 之后就是一个对象，顺手 `{ source: scene }` 发过来。
 * 老写法 `String(input.source)` 会静默落一个 `"[object Object]"` 进库：
 * 卡面全废、原数据回不来，而且报错在建卡时一声不吭，人要到打开卡片才发现。
 *
 * 所以一律不许落 `[object Object]`，按字段的本质分两条路（见下面两个函数）。
 */

/** 对象 / 数组这种「非标量」形状（Date、正则这些当标量处理，String() 出来是有意义的）。 */
function isStructured(value: unknown): boolean {
  return typeof value === "object" && value !== null && !(value instanceof Date) && !(value instanceof RegExp);
}

/**
 * 字段本身就是一段 JSON（excalidraw.source）：对象 / 数组**序列化回字符串**，
 * 因为传对象是完全合理的一种给法，字符串与对象只是同一份数据的两种写法。
 */
export function jsonSourceText(value: unknown, field: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (isStructured(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      // 循环引用之类：与其存半份坏 JSON，不如当场说清楚
      throw badRequest(`${field} 序列化失败（可能有循环引用）：请传 JSON 字符串或可序列化的对象`);
    }
  }
  return String(value).trim();
}

/**
 * 字段是一段**给别的语言看的源码**（mermaid.source / svg.source）：对象在这里
 * 没有任何合理解释（塞进去的 JSON 既画不出图也解析不回来），当场 400 点名，
 * 别让调用方对着一张空白卡片猜。
 */
export function codeSourceText(value: unknown, field: string): string {
  if (value === null || value === undefined) return "";
  if (isStructured(value)) {
    throw badRequest(`${field} 要的是一段源码字符串，收到的是 ${Array.isArray(value) ? "数组" : "对象"}：请先自己拼成字符串再传`);
  }
  return String(value);
}
