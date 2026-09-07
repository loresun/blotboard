import { ok, route } from "@/lib/http";
import { taskIndex } from "@/lib/board-service";

export const dynamic = "force-dynamic";

/** 跨画板任务聚合（goal-agent 模式下任务台 /tasks 的数据源）。必须排在 /api/boards/[boardId] 之前——Next 静态段优先，天然满足。 */
export const GET = route(async () => {
  const tasks = taskIndex();
  return ok({ tasks, total: tasks.length });
});
