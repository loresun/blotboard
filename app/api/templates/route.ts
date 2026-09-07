import { ok, route } from "@/lib/http";
import { listTemplates } from "@/lib/template-store";

export const dynamic = "force-dynamic";

/** 模板列表（只读，不需要写鉴权）。 */
export const GET = route(async () => ok({ templates: listTemplates() }));
