/**
 * HTML 嵌入卡的白名单现状（只读）。
 *
 * 给编辑器用：地址栏旁边要能当场说「这个地址嵌不了」，而不是让用户填完保存再吃一个 400。
 * 规则本身是环境变量配的（BLOTBOARD_HTML_ALLOW），前端拿到后用同一份匹配逻辑
 * （lib/embed-allow.ts）预判——**判断权仍在服务端**，这里只是把规则告诉前端。
 */
import { ok, route } from "@/lib/http";
import { HTML_EMBED_ALLOW_SPEC, HTML_EMBED_RULES } from "@/lib/config";
import { describeAllowRules } from "@/lib/embed-allow";

export const dynamic = "force-dynamic";

export const GET = route(async () =>
  ok({
    spec: HTML_EMBED_ALLOW_SPEC,
    rules: HTML_EMBED_RULES,
    description: describeAllowRules(HTML_EMBED_RULES),
  }),
);
