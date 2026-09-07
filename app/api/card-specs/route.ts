import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { allSpecs, isEnabled, listSpecCategories, listSpecs, saveUserSpec } from "@/lib/card-spec-store";

export const dynamic = "force-dynamic";

/**
 * 规格列表（含停用的——列表里要能把它再打开）。只读，不需要写鉴权。
 * `?full=1` 连字段定义与显示映射一起给：前端渲染规格卡需要这些，一次拉完省得逐个再请求。
 */
export const GET = route(async (request: Request) => {
  const full = new URL(request.url).searchParams.get("full") === "1";
  const specs = full ? allSpecs().map((spec) => ({ ...spec, enabled: isEnabled(spec) })) : listSpecs();
  return ok({ specs, categories: listSpecCategories() });
});

/** 新建 / 更新一份**自定义**规格（写进用户数据目录）。body = 规格 JSON，可带 overwrite。 */
export const POST = route(async (request: Request) => {
  assertCanWrite(request);
  const body = await readJson(request);
  const { overwrite, ...raw } = body;
  const spec = saveUserSpec(raw, { overwrite: overwrite === true });
  return ok({ spec }, 201);
});
