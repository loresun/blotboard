import { assertCanWrite } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/http";
import { taskBackend } from "@/lib/integrations/task-backend";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

/**
 * 任务后端直通（白名单在 taskBackend 实现里，见 lib/integrations/task-backend.ts）。
 * 画板前端用它做两件事：查任务进展（GET /api/runner/tasks/:id）、
 * 从 Agent 抽屉派一个改画板的任务（POST /api/runner/tasks）。
 * 浏览器只带同源头，token 由本服务在服务端补上，不下发浏览器。
 * 后端未配置时统一 503（此时前端入口本来就不渲染）。
 */
async function proxy(request: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  const sub = (path || []).join("/");
  if (request.method !== "GET") assertCanWrite(request);
  // 查询串原样带过去（产出列表要 ?taskId=），但只放行白名单里的路径
  const query = new URL(request.url).search;
  const body = request.method === "GET" ? undefined : await readJson(request);
  const data = await taskBackend.proxy<any>(request.method, sub, query, body);
  return ok(data && typeof data === "object" ? data : { data });
}

export const GET = route(proxy);
export const POST = route(proxy);
export const PATCH = route(proxy);
