import { ok, readJson, route } from "@/lib/http";
import { searchProvider } from "@/lib/integrations/search-provider";

export const dynamic = "force-dynamic";

/**
 * 知识库检索代理（只读，不落库，所以不要 token——与画板其它读接口一致）。
 * body: { query, mode: "hybrid" | "vector", limit, platform }
 * 知识库未配置时统一 503（此时前端入口本来就不渲染）。
 */
export const POST = route(async (request: Request) => {
  const body = await readJson(request);
  const result = await searchProvider.search({
    query: String(body.query || ""),
    mode: body.mode === "hybrid" ? "hybrid" : "vector",
    limit: Number(body.limit) || 10,
    platform: body.platform ? String(body.platform) : undefined,
  });
  return ok({ ...result });
});
