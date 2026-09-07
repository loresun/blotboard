import { localeMetadata } from "@/lib/i18n/metadata";
import { TasksApp } from "@/components/TasksApp";

/**
 * 任务台（与 /nav 同构的独立子页）：纯客户端 SPA，数据全走 /api；
 * 壳每请求渲染——body dataset 里的任务后端种类来自运行时 env，
 * 不能烤死在 build 产物里（见 app/page.tsx 的同款注释）。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return localeMetadata("meta.tasks.title", "meta.tasks.desc");
}

export default function Page() {
  return <TasksApp />;
}
