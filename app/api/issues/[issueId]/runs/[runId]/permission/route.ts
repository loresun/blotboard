import { resolvePermission } from "@/lib/acp/manager";
import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { assertLocalRun, decorateIssue } from "@/lib/issue-service";
import { requireIssue } from "@/lib/issue-store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ issueId: string; runId: string }> };

/**
 * 兑现 ACP run 挂起的权限请求（ask 档位下 agent 的 session/request_permission
 * 停在这等人）：body { optionId } → resolve 挂着的 JSON-RPC 请求，run 回到 running。
 * 服务重启导致 resolver 丢失的场景由启动扫描兜底（run 已被标中止），这里回 409 说清楚。
 */
export const POST = route(async (request: Request, ctx: Ctx) => {
  const { issueId, runId } = await ctx.params;
  assertLocalRun(runId);
  assertCanWrite(request);
  const body = await readJson(request);
  const run = resolvePermission(issueId, runId, body.optionId);
  return ok({ run, issue: decorateIssue(requireIssue(issueId)) });
});
