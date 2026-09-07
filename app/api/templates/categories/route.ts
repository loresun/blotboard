import { ok, route } from "@/lib/http";
import { listCategories } from "@/lib/template-store";

export const dynamic = "force-dynamic";

export const GET = route(async () => ok({ categories: listCategories() }));
