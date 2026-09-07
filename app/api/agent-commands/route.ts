import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { createCommand, listCommands } from "@/lib/agent-command-store";

export const dynamic = "force-dynamic";

export const GET = route(async () => ok({ commands: listCommands() }));

export const POST = route(async (request: Request) => {
  assertCanWrite(request);
  const body = await readJson(request);
  return ok({ command: createCommand(body) }, 201);
});
