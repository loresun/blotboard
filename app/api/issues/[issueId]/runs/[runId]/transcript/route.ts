import { readTranscript } from "@/lib/acp/transcript";
import { ok, notFound, route } from "@/lib/http";
import { assertLocalRun } from "@/lib/issue-service";
import { findRun } from "@/lib/issue-store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ issueId: string; runId: string }> };

/**
 * ACP run 的流式 transcript 增量读（任务台详情轮询用，不上 SSE）。
 * ?offset=N：只回第 N 条之后的（行号语义，响应里的 offset 就是下次该传的值）。
 * 顺带回 run 的当前状态与挂起的权限请求——轮询一次拿全，前端不用拆两个请求。
 */
export const GET = route(async (request: Request, ctx: Ctx) => {
  const { issueId, runId } = await ctx.params;
  assertLocalRun(runId);
  const found = findRun(runId);
  if (!found || found.issue.id !== issueId) throw notFound("run 不存在");
  const url = new URL(request.url);
  const rawOffset = Number(url.searchParams.get("offset") || 0);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  const { entries, offset: nextOffset } = readTranscript(runId, offset);
  const { run } = found;
  return ok({
    entries,
    offset: nextOffset,
    run: {
      id: run.id,
      status: run.status,
      note: run.note,
      kind: run.kind || "prompt",
      agentName: run.agentName || null,
      permissionRequest: run.permissionRequest || null,
      updatedAt: run.updatedAt,
    },
  });
});
