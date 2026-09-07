/**
 * 引用资源库（agent-skill 规格卡的跨画板聚合视图）。
 *
 * 资源的真源**就是画板上的一张张规格卡**——不另设数据库、不另设登记口：
 * 卡片继承了画板的全部能力（评论即交活、信封判重、批量收发、导出、快照回滚），
 * 这里只做一件事：把散在各块板上的 agent-skill 卡摊平成一份清单，
 * 给 `/resources` 页（人看）与 `GET /api/resources`（agent 看）同一份数据。
 *
 * 与 searchBoards 同一取舍：全量线性扫，本地单机数据量下毫秒级；
 * 换 SQLite 时再下沉成索引查询。
 */
import * as store from "./storage";
import type { BoardCard, DataValue } from "./types";
import { findSpec, isEnabled } from "./card-spec-store";

/** 哪份规格算「引用资源」——一处定义，API / 页面 / skill 指南都从这来 */
export const RESOURCE_SPEC_ID = "agent-skill";

/** 标量资源字段：能直接当文本搜索与展示的（list 型字段不进来，资源规格里没用它） */
function scalarFields(fields: Record<string, DataValue>): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) out[key] = value;
  }
  return out;
}

export interface ResourceEntry {
  cardId: string;
  boardId: string;
  boardName: string;
  boardGroup: string;
  /** 深链：新标签打开画板并定位到这张卡（与分享链接同一套约定） */
  link: string;
  title: string;
  fields: Record<string, string | number | boolean | string[]>;
  updatedAt: number;
  createdAt: number;
}

export interface ResourceQuery {
  q?: string;
  kind?: string;
  status?: string;
}

export interface ResourceIndex {
  spec: { id: string; name: string; enabled: boolean };
  /** 全部资源条数（过滤前） */
  total: number;
  /** 按类型 / 状态计数（过滤前），给页面侧栏与 agent 概览 */
  counts: { kinds: Record<string, number>; statuses: Record<string, number> };
  /** 过滤后命中（应用 q / kind / status 之后） */
  resources: ResourceEntry[];
  matched: number;
}

function entryOf(card: BoardCard, board: { id: string; name: string; group?: string }): ResourceEntry {
  const fields = scalarFields(card.data?.fields || {});
  return {
    cardId: card.id,
    boardId: board.id,
    boardName: board.name,
    boardGroup: board.group || "",
    link: `/?board=${encodeURIComponent(board.id)}&card=${encodeURIComponent(card.id)}`,
    title: card.title || String(fields.name || "未命名资源"),
    fields,
    updatedAt: card.updatedAt || card.createdAt,
    createdAt: card.createdAt,
  };
}

/** 文本检索口径：名称 / 用途 / 安装 / 用法 / 触发词 / 备注——agent 按「我要干的事」来搜 */
function haystackOf(entry: ResourceEntry): string {
  const f = entry.fields;
  const tags = Array.isArray(f.triggers) ? f.triggers.join(" ") : "";
  const agents = Array.isArray(f.agents) ? f.agents.join(" ") : "";
  return [entry.title, f.purpose, f.usage, f.install, f.notes, tags, agents, f.url]
    .filter((part) => typeof part === "string")
    .join(" ")
    .toLowerCase();
}

export function listResources(query: ResourceQuery = {}): ResourceIndex {
  const spec = findSpec(RESOURCE_SPEC_ID);
  const keyword = (query.q || "").trim().toLowerCase();
  const kind = (query.kind || "").trim();
  const status = (query.status || "").trim();

  const kinds: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const all: ResourceEntry[] = [];
  for (const board of store.load().boards) {
    for (const card of board.cards || []) {
      if (card.type !== "data" || card.data?.specId !== RESOURCE_SPEC_ID) continue;
      const entry = entryOf(card, board);
      all.push(entry);
      const kindValue = String(entry.fields.kind || "other");
      const statusValue = String(entry.fields.status || "");
      kinds[kindValue] = (kinds[kindValue] || 0) + 1;
      if (statusValue) statuses[statusValue] = (statuses[statusValue] || 0) + 1;
    }
  }
  // 新登记的排前面，再看名称——资源库的第一诉求是「最近又收了什么」
  all.sort((a, b) => b.createdAt - a.createdAt || a.title.localeCompare(b.title, "zh-Hans-CN"));

  const resources = all.filter((entry) => {
    if (kind && String(entry.fields.kind || "other") !== kind) return false;
    if (status && String(entry.fields.status || "") !== status) return false;
    if (keyword && !haystackOf(entry).includes(keyword)) return false;
    return true;
  });

  return {
    spec: {
      id: RESOURCE_SPEC_ID,
      name: spec?.name || RESOURCE_SPEC_ID,
      enabled: spec ? isEnabled(spec) : false,
    },
    total: all.length,
    counts: { kinds, statuses },
    resources,
    matched: resources.length,
  };
}
