import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { applyTemplate } from "@/lib/template-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ templateId: string }> };

/** 应用模板到一块新画板。body: { name? } */
export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { templateId } = await ctx.params;
  const body = await readJson(request);
  const result = applyTemplate(templateId, body.name);
  return ok({ ...result }, 201);
});
