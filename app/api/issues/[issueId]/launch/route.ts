import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { taskBackend } from "@/lib/integrations/task-backend";
import { assertLocalIssues, decorateIssue } from "@/lib/issue-service";
import { requireIssue } from "@/lib/issue-store";
import { mutateBoard, get as getBoard } from "@/lib/storage";
import { normalizeTaskField } from "@/lib/board-schema";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ issueId: string }> };

/**
 * 对已有 Issue 直接发起执行（local 后端专属；形状对齐 RUNNER.md §1.3 的
 * `POST /api/issues/:id/launch`）。任务台派单走这条——它面对的是 Issue 而不是卡片，
 * 孤儿 Issue（来源卡已删）也照样能派。body：{ mode?, agentId? }；
 * 带 agentId = spawn 注册的 ACP agent，不带 = 生成 prompt 供复制（与卡片入口同一套语义）。
 */
export const POST = route(async (request: Request, ctx: Ctx) => {
  assertLocalIssues();
  assertCanWrite(request);
  const { issueId } = await ctx.params;
  const issue = requireIssue(issueId);
  const body = await readJson(request);
  const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : null;
  const result = await taskBackend.launch(issueId, { mode: body.mode }, agentId ? { agentId } : undefined);

  // 来源卡片还在的话把 taskId 指到新 run：卡片页脚的轮询立刻跟上这次执行
  if (issue.boardId && issue.cardId && result?.sessionId) {
    try {
      const board = getBoard(issue.boardId);
      const card = board?.cards?.find((item) => item.id === issue.cardId);
      if (card && card.task?.issueId === issueId) {
        mutateBoard(issue.boardId, (target) => {
          const found = target.cards.find((entry) => entry.id === issue.cardId);
          if (found) {
            found.task = normalizeTaskField({ ...found.task, taskId: result.sessionId, status: "running" });
            found.updatedAt = Date.now();
            target.updatedAt = Date.now();
          }
          return null;
        });
      }
    } catch {
      /* 卡片联动失败不阻塞派单：任务台自己的账是全的 */
    }
  }

  return ok({ task: { sessionId: result?.sessionId || null, mode: result?.mode }, issue: decorateIssue(requireIssue(issueId)) }, 201);
});
