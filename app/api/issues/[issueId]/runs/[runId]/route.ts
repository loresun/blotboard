import { handleExternalRunStatus } from "@/lib/acp/manager";
import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { assertLocalIssues, decorateIssue } from "@/lib/issue-service";
import { patchRun } from "@/lib/issue-store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ issueId: string; runId: string }> };

/**
 * 改 run 状态 / 备注 —— agent 回报执行进度的口（docs/RUNNER.md）：
 * running / waiting / completed / failed / aborted（+ 初始的 pending）。
 * run 状态会顺带把 Issue 状态推着走（映射见 lib/issue-store.ts patchRun 注释），
 * 任务卡页脚轮询的就是这个 run（taskId = runId）。
 */
export const PATCH = route(async (request: Request, ctx: Ctx) => {
  assertLocalIssues();
  assertCanWrite(request);
  const { issueId, runId } = await ctx.params;
  const body = await readJson(request);
  const { issue, run } = patchRun(issueId, runId, body);
  // acp run 的联动：改成 aborted 走 cancel 链路（session/cancel → 5s → SIGTERM），
  // 其他终态直接收尾子进程——run 转终态时会话一定跟着结束（设计决策 §3）
  if (body.status !== undefined) handleExternalRunStatus(runId, run.status);
  return ok({ issue: decorateIssue(issue), run });
});
