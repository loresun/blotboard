/**
 * Excalidraw 字体资源路径。
 *
 * Excalidraw 的手写体（Excalifont / Virgil / 中文的 Xiaolai…）不在 JS bundle 里，
 * 运行时按 unicode-range 分片去 `EXCALIDRAW_ASSET_PATH` 拉；不设的话默认打 CDN，
 * 断网就退化成系统字体（中文尤其明显）。这里钉到本地 /excalidraw-assets/，
 * 文件由 scripts/sync-excalidraw-assets.mjs 从 node_modules 同步进 public/。
 *
 * ⚠️ 这个模块必须在 **任何** `@excalidraw/excalidraw` 导入之前求值——
 * 字体表是在库初始化时按这个变量拼 URL 的。所以凡是要 import 那个包的模块，
 * 第一行先 import 本文件（ESM 按声明顺序求值）。
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export const EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

if (typeof window !== "undefined" && !window.EXCALIDRAW_ASSET_PATH) {
  window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
}
