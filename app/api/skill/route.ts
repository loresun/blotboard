import { renderInstallSkill } from "@/lib/agent-onboarding";
import { badRequest, ok, requestOrigin, route } from "@/lib/http";
import { buildSkillDocument, focusSkillDocument, parseSkillFocus, renderSkillMarkdown } from "@/lib/skill";

export const dynamic = "force-dynamic";

/**
 * 本部署的 agent 指南，**现场拼装**（免鉴权只读，OPEN-SOURCE-PLAN §6.4）：
 * 只讲启用的卡片包与规格、按当前任务后端讲对应链路、未配置的服务整节略过——
 * 装了什么说什么，直接消灭「skill 文档与部署漂移」。
 *
 * `?format=md`（默认）给可直接喂 agent 的 Markdown；`?format=json` 给分节结构
 * （宿主想按节挑选 / 二次拼装时用）。/api/capabilities 是机器可读的能力清单，这里是人话版。
 *
 * `?focus=cards,tasks` 只输出相关章节（合法值见 lib/skill.ts 的 SKILL_FOCUS，
 * 也在 `/api/capabilities` 的 skillFocus 段里）——全量一两万字，而 agent 往往
 * 只是要往板上加几张卡。不传就是全量。
 */
export const GET = route(async (request: Request) => {
  // 指南里的链接跟着用户此刻访问的 host 走（与导出产物同一条理由：写死 127.0.0.1 换台机器全是死链）
  const origin = requestOrigin(request);
  const params = new URL(request.url).searchParams;
  if (params.get("format") === "install") {
    if (params.has("focus")) throw badRequest("安装入口不接受 focus；请使用 format=md 读取分节指南");
    return new Response(renderInstallSkill(origin || new URL(request.url).origin), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": 'attachment; filename="SKILL.md"',
        "cache-control": "no-store",
      },
    });
  }
  const focus = parseSkillFocus(params.get("focus"));
  const doc = focusSkillDocument(buildSkillDocument(origin || undefined), focus);

  if (params.get("format") === "json") {
    return ok({ ...doc } as unknown as Record<string, unknown>);
  }
  return new Response(renderSkillMarkdown(doc), {
    status: 200,
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
  });
});
