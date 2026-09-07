import { route } from "@/lib/http";
import { PUBLIC_URL } from "@/lib/config";
import { getSpec } from "@/lib/card-spec-store";
import { specPromptBlock, specSchemaDocument } from "@/lib/card-spec-schema";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ specId: string }> };

/**
 * 一份规格的 JSON Schema（Draft 2020-12）。
 * `?format=prompt` 换成给 agent 看的 Markdown 说明块（同样的信息，省 token）。
 * 两者都是裸响应（不裹 { ok }），方便直接喂给校验器 / 提示词。
 */
export const GET = route(async (request: Request, ctx: Ctx) => {
  const { specId } = await ctx.params;
  const spec = getSpec(specId);
  const format = new URL(request.url).searchParams.get("format");
  if (format === "prompt") {
    return new Response(specPromptBlock(spec), {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(JSON.stringify(specSchemaDocument(spec, PUBLIC_URL), null, 2), {
    status: 200,
    headers: { "content-type": "application/schema+json; charset=utf-8", "cache-control": "no-store" },
  });
});
