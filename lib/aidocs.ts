/**
 * 知识库检索桥（地址由 `AIDOCS_URL` 给；**实现层**：只被 lib/integrations/search-provider.ts
 * 引用，业务代码一律走 searchProvider 接口——未配置时那边换成 503 的 null 实现）。
 *
 * 画板不存知识库正文——卡片只留 resource_id / 标题 / 摘要 / 原文链接，
 * 正文永远回知识库取（跟「Issue 真源在任务后端」是同一条红线：不复制别人的数据）。
 * 走服务端代理而不是浏览器直连：地址集中配置，前端不用关心知识库在哪、有没有跨域。
 */
import { AIDOCS_URL } from "./config";
import { ApiError } from "./http";
import type { RefItem, RefMode } from "./types";

const TIMEOUT_MS = 75_000;
export const MAX_SEARCH_LIMIT = 30;

export interface AidocsSearchInput {
  query: string;
  mode?: RefMode;
  limit?: number;
  platform?: string;
}

export interface AidocsSearchResult {
  query: string;
  mode: RefMode;
  total: number;
  items: RefItem[];
}

async function callAidocs<T = any>(path: string, payload: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${AIDOCS_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: any) {
    const message =
      err?.name === "TimeoutError" || err?.name === "AbortError"
        ? "知识库请求超时"
        : "连不上知识库，请检查知识库地址、网络与服务状态";
    throw new ApiError(message, 502);
  }
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok || data?.success === false) {
    // Remote error strings are not safe public API messages.
    throw new ApiError(`知识库请求未成功（HTTP ${response.status}），请检查知识库服务日志`, 502);
  }
  return (data?.data ?? data) as T;
}

/** 混合检索命中的是「文档」，向量检索命中的是「切片」——统一成同一种条目形状。 */
function toItem(raw: Record<string, any>): RefItem | null {
  const resourceId = String(raw.resource_id || (raw.doc_id ? `doc:${raw.platform || "unknown"}:${raw.doc_id}` : ""));
  if (!resourceId) return null;
  // resource_id 形如 doc:{platform}:{docId}，末段就是知识库里的主键
  const docId = String(raw.doc_id || resourceId.split(":").pop() || "");
  return {
    resourceId,
    docId: /^\d+$/.test(docId) ? docId : "",
    title: String(raw.title || resourceId),
    url: typeof raw.source_url === "string" && /^https?:\/\//i.test(raw.source_url) ? raw.source_url : "",
    platform: String(raw.platform || raw.source_type || ""),
    snippet: String(raw.snippet || raw.chunk_text || "").slice(0, 1200),
    score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : null,
  };
}

export async function searchAidocs(input: AidocsSearchInput): Promise<AidocsSearchResult> {
  const query = String(input.query || "").trim();
  if (!query) throw new ApiError("检索词不能为空", 400);
  const mode: RefMode = input.mode === "hybrid" ? "hybrid" : "vector";
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.round(Number(input.limit) || 10)));
  const platform = String(input.platform || "").trim();

  const data =
    mode === "vector"
      ? await callAidocs("/api/agent/vectors/search", { query, top_k: limit, ...(platform ? { platform } : {}) })
      : await callAidocs("/api/agent/search", { query, limit, ...(platform ? { platform } : {}) });

  const rows: Record<string, any>[] = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.chunks)
      ? data.chunks
      : [];

  // 向量检索按切片返回，同一篇会出现多条；按 resource_id 去重只留分最高的那条
  const byId = new Map<string, RefItem>();
  for (const row of rows) {
    const item = toItem(row);
    if (!item) continue;
    const prev = byId.get(item.resourceId);
    if (!prev || (item.score || 0) > (prev.score || 0)) byId.set(item.resourceId, item);
  }

  return {
    query: String(data?.query_interpreted || data?.query || query),
    mode,
    total: Number(data?.total ?? byId.size),
    items: [...byId.values()],
  };
}
