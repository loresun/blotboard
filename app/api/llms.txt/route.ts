/**
 * GET /llms.txt —— 这台部署的 llms 自描述（免鉴权只读，与 8011 标杆对齐）。
 *
 * 正文**现场拼装**（`lib/llms-txt.ts`），不再读项目根的静态 llms.txt：那份文件写的是
 * 某一台机器的地址与开关，属于部署状态不属于源码，改了配置还会当场过期。
 * 链接与样例里的 base 跟着调用方此刻访问的 host 走，与 /api/skill 同一条理由。
 */
import { requestOrigin, route } from "@/lib/http";
import { renderLlmsTxt } from "@/lib/llms-txt";

export const dynamic = "force-dynamic";

export const GET = route(async (request: Request) => {
  const origin = requestOrigin(request) || new URL(request.url).origin;
  return new Response(renderLlmsTxt(origin), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
});
