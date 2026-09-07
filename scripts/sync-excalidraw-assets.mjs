/**
 * 把 Excalidraw 的字体资源从 node_modules 同步进 public/。
 *
 * Excalidraw 的手写体是运行时按 unicode-range 分片去 `EXCALIDRAW_ASSET_PATH` 拉的
 * （见 lib/excalidraw-assets.ts）。不同步就只能打官方 CDN——断网时中文直接掉回系统字体，
 * 画出来的东西和存下来的缩略图对不上。
 *
 * 这堆文件（含中文的 Xiaolai 分片）十几 MB，不进 git：
 * 用一个 .version 戳记跟包版本比对，版本一致就直接跳过，所以每次启动的开销是一次 readFile。
 *
 *   node scripts/sync-excalidraw-assets.mjs      单独跑
 *   server.mjs 启动时也会调 ensureExcalidrawAssets()
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(projectRoot, "node_modules", "@excalidraw", "excalidraw");
const sourceFonts = path.join(packageRoot, "dist", "prod", "fonts");
const targetRoot = path.join(projectRoot, "public", "excalidraw-assets");
const stampFile = path.join(targetRoot, ".version");

/** @returns {{ synced: boolean, reason: string }} */
export function ensureExcalidrawAssets() {
  if (!fs.existsSync(sourceFonts)) {
    return { synced: false, reason: "没装 @excalidraw/excalidraw，跳过" };
  }
  let version = "unknown";
  try {
    version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version || "unknown";
  } catch {
    /* 读不到版本就当 unknown，下面照样会同步一次 */
  }
  const stamp = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, "utf8").trim() : "";
  if (stamp === version && fs.existsSync(path.join(targetRoot, "fonts"))) {
    return { synced: false, reason: `已是 ${version}` };
  }
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.cpSync(sourceFonts, path.join(targetRoot, "fonts"), { recursive: true });
  fs.writeFileSync(stampFile, `${version}\n`, "utf8");
  return { synced: true, reason: `已同步 ${version}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = ensureExcalidrawAssets();
    console.log(`[excalidraw-assets] ${result.reason}`);
  } catch (err) {
    // 资源同步失败不该让 npm install / 构建整个挂掉：库自己会回退到 CDN
    console.warn(`[excalidraw-assets] 同步失败（将回退到 CDN 字体）：${err?.message || err}`);
  }
}
