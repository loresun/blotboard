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
  // body.agentId（可选）：local 后端下用注册的 ACP agent 真跑；远程后端下被丢弃（行为不变）
  const result = await launchCardTask(assertBoardId(boardId), cardId, body.mode, body.agentId);
  return ok({ task: result.task, card: result.card }, 201);
});
