import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { deleteCommand, updateCommand } from "@/lib/agent-command-store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ commandId: string }> };

export const PATCH = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { commandId } = await ctx.params;
  const body = await readJson(request);
  return ok({ command: updateCommand(commandId, body) });
});

/** 自定义指令真删；内置指令「删除」= 清掉覆盖层恢复默认。 */
export const DELETE = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { commandId } = await ctx.params;
  return ok(deleteCommand(commandId));
});
