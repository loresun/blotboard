import { ok, route } from "@/lib/http";
import { listResources } from "@/lib/resources";

export const dynamic = "force-dynamic";

/**
 * 引用资源清单（只读，免鉴权，与其它读口一致）：把散在各块画板上的
 * agent-skill 规格卡摊平成一份清单——agent 进来一个请求就能看到
 * 这台部署登记了哪些能直接装上用的 skill / 工具。
 * `?q=关键词&kind=skill&status=verified` 逐个过滤；人看的同一份数据在 `/resources` 页。
 */
export const GET = route(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const index = listResources({
    q: params.get("q") || undefined,
    kind: params.get("kind") || undefined,
    status: params.get("status") || undefined,
  });
  return ok({ ...index });
});
