import { ok, route } from "@/lib/http";
import { getTemplate } from "@/lib/template-store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ templateId: string }> };

/** 模板详情：含 cards / edges / viewport / agentPrompt。 */
export const GET = route(async (_request: Request, ctx: Ctx) => {
  const { templateId } = await ctx.params;
  return ok({ template: getTemplate(templateId) });
});
