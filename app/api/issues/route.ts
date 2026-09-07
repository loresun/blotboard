import { ok, route } from "@/lib/http";
import { TASK_BACKEND } from "@/lib/features";
import { assertLocalIssues, issueMatches, listDecoratedIssues } from "@/lib/issue-service";

export const dynamic = "force-dynamic";

/**
 * local 任务后端的 Issue 列表（任务台 `/tasks` 的数据源）。
 *
 * ?board= 按来源画板收窄，?q= 关键词（标题 / 正文 / 编号 / 标签），
 * ?status= 按镜头收窄（pending / in_progress / attention / done / aborted / all）。
 * 镜头计数在**状态筛选之前**、board+q 筛选之后统计——左栏的五个数字要跟着
 * 当前收窄范围走，但不能被自己筛没了。
 *
 * 孤儿 Issue（画板 / 卡片已删）照样列出（orphan: true）——这正是任务台
 * 相对「本板视角」的价值：模态框永远看不到它们。
 */
export const GET = route(async (request: Request) => {
  assertLocalIssues();
  const url = new URL(request.url);
  const board = url.searchParams.get("board") || "";
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const lens = url.searchParams.get("status") || "all";

  const pool = listDecoratedIssues().filter(
    (item) => (!board || item.boardId === board) && (!q || issueMatches(item, q)),
  );
  const counts = { all: pool.length, pending: 0, in_progress: 0, attention: 0, done: 0, aborted: 0 };
  for (const item of pool) counts[item.lens] += 1;
  const issues = (lens === "all" ? pool : pool.filter((item) => item.lens === lens))
    // 按活动时间排：最近有动静的排最前（与任务台中栏的阅读顺序一致）
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return ok({ backend: TASK_BACKEND, issues, total: issues.length, counts });
});
