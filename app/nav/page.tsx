import { localeMetadata } from "@/lib/i18n/metadata";
import { BoardNavApp } from "@/components/BoardNavApp";

/**
 * 与画板主页同样是纯客户端 SPA，数据全走 /api；壳同样每请求渲染——
 * body dataset 里的功能开关来自运行时 env，不能烤死在 build 产物里（见 app/page.tsx）。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return localeMetadata("meta.nav.title", "meta.nav.desc");
}

export default function Page() {
  return <BoardNavApp />;
}
