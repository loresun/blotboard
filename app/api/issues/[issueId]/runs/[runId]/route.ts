import { handleExternalRunStatus, syncSourceCard } from "@/lib/acp/manager";
import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { assertLocalRun, decorateIssue } from "@/lib/issue-service";
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
  const { issueId, runId } = await ctx.params;
  assertLocalRun(runId);
  assertCanWrite(request);
  const body = await readJson(request);
  const { issue, run } = patchRun(issueId, runId, body);
  // acp run 的联动：改成 aborted 走 cancel 链路（session/cancel → 5s → SIGTERM），
  // 其他终态直接收尾子进程——run 转终态时会话一定跟着结束（设计决策 §3）
  if (body.status !== undefined) {
    handleExternalRunStatus(runId, run.status);
    // 来源卡的状态也跟着走：这条 run 归画板所有，就别让卡片一直停在「执行中」。
    // 走这里而不是只走 manager 内部：HTTP 回写这条路可能根本没有内存会话（重启后、
    // 或者 copy-prompt 那种压根没子进程的 run），钩子进不去，卡片就永远不更新。
    syncSourceCard(issueId, runId, run.status);
  }
  return ok({ issue: decorateIssue(issue), run });
});
