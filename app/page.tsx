import { BoardApp } from "@/components/BoardApp";

/**
 * 画板是纯客户端 SPA，数据全走 /api；但**壳必须每请求渲染**：
 * `<body data-features / data-*-base>` 来自运行时环境变量（哪些可选集成开着），
 * force-static 会把 build 那一刻的 env 烤死进 HTML——用户改 ecosystem 配置重启后
 * 页面还是旧开关。内网工具，多这一次服务端渲染可忽略。
 */
export const dynamic = "force-dynamic";

export default function Page() {
  return <BoardApp />;
}
