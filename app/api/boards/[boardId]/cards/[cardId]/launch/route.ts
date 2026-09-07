import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { assertBoardId } from "@/lib/board-schema";
import { launchCardTask } from "@/lib/board-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ boardId: string; cardId: string }> };

export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { boardId, cardId } = await ctx.params;
  const body = await readJson(request);
  // body.agentId（可选）：用注册表里的本机 ACP agent 真跑这一轮——**任何任务后端下都成立**
  // （远程后端下 Issue 真源仍归对端，本机只留执行台账，见 lib/integrations/acp-lane.ts）
  const result = await launchCardTask(assertBoardId(boardId), cardId, body.mode, body.agentId);
  return ok({ task: result.task, card: result.card }, 201);
});
