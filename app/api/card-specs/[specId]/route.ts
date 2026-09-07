import { assertCanWrite } from "@/lib/auth";
import { badRequest, ok, readJson, route } from "@/lib/http";
import { deleteUserSpec, getSpec, isEnabled, setSpecEnabled } from "@/lib/card-spec-store";
import { specPromptBlock } from "@/lib/card-spec-schema";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ specId: string }> };

/** 规格详情：字段定义 + 显示映射 + 示例 + 给 agent 的说明块。 */
export const GET = route(async (_request: Request, ctx: Ctx) => {
  const { specId } = await ctx.params;
  const spec = getSpec(specId);
  return ok({ spec, enabled: isEnabled(spec), prompt: specPromptBlock(spec) });
});

/** 开 / 关一份规格（插件开关）。body: { enabled: boolean } */
export const PATCH = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { specId } = await ctx.params;
  const body = await readJson(request);
  if (typeof body.enabled !== "boolean") throw badRequest("enabled 必须是布尔");
  return ok({ spec: setSpecEnabled(specId, body.enabled) });
});

/** 删除自定义规格（内置规格只能停用，不能删）。 */
export const DELETE = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { specId } = await ctx.params;
  return ok({ deleted: deleteUserSpec(specId) });
});
