import { ok, readJson, route } from "@/lib/http";
import { validateEnvelope } from "@/lib/card-ingest";

export const dynamic = "force-dynamic";

/**
 * 干跑校验：贴一段信封 JSON，回报「解出几张卡、每张卡的字段是什么、哪里不合规」，**不落库**。
 * 只读，不需要写鉴权——别人给的卡片先在这里看清楚，再决定要不要 ingest。
 */
export const POST = route(async (request: Request) => {
  const body = await readJson(request);
  return ok({ report: validateEnvelope(body) });
});
