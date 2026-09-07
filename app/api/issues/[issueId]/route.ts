import { assertCanWrite } from "@/lib/auth";
import { notFound, ok, readJson, route } from "@/lib/http";
import { assertLocalIssue, decorateIssue } from "@/lib/issue-service";
import { getIssue, patchIssue, requireIssue } from "@/lib/issue-store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ issueId: string }> };

/**
 * Issue 详情（local 后端）：完整字段 + runs（含各自的 prompt）+ 日志，
 * 外加一份顶层 prompt——最近一次 run 的完整 prompt，任务台「复制完整 prompt」直接用；
 * 还没发起过任务时给正文本身（复制出去也是能用的任务说明）。
 */
export const GET = route(async (_request: Request, ctx: Ctx) => {
  const { issueId } = await ctx.params;
  assertLocalIssue(issueId);
  const issue = requireIssue(issueId);
  const lastRun = issue.runs[issue.runs.length - 1] || null;
  return ok({
    issue: decorateIssue(issue),
    prompt: lastRun?.prompt || issue.description,
  });
});

/**
 * 改 Issue —— **agent 的回写口**（docs/RUNNER.md）：
 * status / labels / note（追加日志），画板的正文回推也复用（title/description/priority）。
 * 鉴权与其他写口同一套：x-auth-key = 内部 token，或浏览器同源 + x-board-web 头。
 */
export const PATCH = route(async (request: Request, ctx: Ctx) => {
  const { issueId } = await ctx.params;
  assertLocalIssue(issueId);
  assertCanWrite(request);
  if (!getIssue(issueId)) throw notFound("Issue 不存在");
  const body = await readJson(request);
  const issue = patchIssue(issueId, body);
  if (!issue) throw notFound("Issue 不存在");
  return ok({ issue: decorateIssue(issue) });
});
