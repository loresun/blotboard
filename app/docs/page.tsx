import { localeMetadata } from "@/lib/i18n/metadata";
import { DocsApp } from "@/components/DocsApp";

/**
 * 帮助页（与 /nav /resources /tasks 同构的独立子页）：纯客户端 SPA，内容全走 `/api/docs`；
 * 壳每请求渲染——同 app/page.tsx 的约定，别把任何运行时状态烤进构建产物。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return localeMetadata("meta.docs.title", "meta.docs.desc");
}

export default function Page() {
  return <DocsApp />;
}
