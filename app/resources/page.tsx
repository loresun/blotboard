import { localeMetadata } from "@/lib/i18n/metadata";
import { ResourcesApp } from "@/components/ResourcesApp";

/**
 * 与画板主页 / 导航页同为纯客户端 SPA，数据全走 /api；壳每请求渲染——
 * 别把任何运行时状态烤进构建产物（同 app/page.tsx 的约定）。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return localeMetadata("meta.resources.title", "meta.resources.desc");
}

export default function Page() {
  return <ResourcesApp />;
}
