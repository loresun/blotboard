"use client";

/**
 * 真正的 Excalidraw 编辑器（`@excalidraw/excalidraw` 官方 React 组件）。
 *
 * 单独一个文件的原因：这里带着 Excalidraw 的 1MB+ JS 和一整套 CSS，
 * 必须能被 next/dynamic 切成独立 chunk——只有双击 Excalidraw 卡时才下载，
 * 别的板子不该为它付首屏。
 *
 * ⚠️ import 顺序有意义：excalidraw-assets 要在库之前求值（见那个文件的注释）。
 */
import "@/lib/excalidraw-assets";
import "@excalidraw/excalidraw/index.css";
import { useLocale } from "@/lib/i18n/client";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawScene } from "@/lib/excalidraw-scene";

export function ExcalidrawCanvas({
  scene,
  onApi,
  onChange,
}: {
  /** 打开时灌进画布的初始场景；Excalidraw 只在挂载时读一次 */
  scene: ExcalidrawScene | null;
  onApi: (api: ExcalidrawImperativeAPI) => void;
  onChange: () => void;
}) {
  // 内嵌编辑器自己的界面语言也跟着画板走：以前写死中文，英文用户点进去
  // 整条 Excalidraw 工具条还是中文，比不翻译更突兀
  const { locale } = useLocale();
  return (
    <Excalidraw
      excalidrawAPI={onApi}
      onChange={onChange}
      langCode={locale === "zh" ? "zh-CN" : "en"}
      initialData={{
        elements: scene?.elements ?? [],
        // appState 里可能带着上次保存的网格/背景色；宽高、滚动位置这些
        // 由 Excalidraw 自己的 restore 清掉，这里原样交给它
        appState: { ...(scene?.appState ?? {}), collaborators: new Map() },
        files: scene?.files ?? {},
        scrollToContent: true,
      }}
      UIOptions={{
        canvasActions: {
          // 卡片的主题跟着画板走，画布里再切深浅色会让缩略图和卡面对不上
          toggleTheme: false,
        },
      }}
    />
  );
}
