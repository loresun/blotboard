import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoProductionServers } from "./scripts/build-guard.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 上级目录里有别的 lockfile，显式钉死工作区根，避免 Next 猜错
  turbopack: { root: projectRoot },
  typescript: { ignoreBuildErrors: false },
  // inventory audit: 根路径 /llms.txt 与 8011 标杆对齐（实质指向 /api/llms.txt 同一处理器）
  async rewrites() {
    return [{ source: "/llms.txt", destination: "/api/llms.txt" }];
  },
};

export default (phase) => {
  // Protect direct `next build` as well as the guarded npm entry point.
  if (phase === "phase-production-build") assertNoProductionServers(projectRoot);
  return nextConfig;
};
