/**
 * Excalidraw 场景的解析 / 渲染工具（浏览器侧）。
 *
 * 卡面为什么不直接把 .excalidraw JSON 交给 <Excalidraw> 渲染：那是个完整编辑器，
 * 一张板上十几张卡就是十几个 canvas + 事件系统。卡面只要一张图，
 * 所以走官方的 exportToBlob（同一套渲染管线，出 PNG），编辑才挂真正的编辑器。
 *
 * `@excalidraw/excalidraw` 打包后约 1MB+，跟 mermaid 一样按需 import——
 * 没有 Excalidraw 卡的板不该为它买单。
 */
import "./excalidraw-assets";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

export interface ExcalidrawScene {
  elements: ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
}

type ExcalidrawModule = typeof import("@excalidraw/excalidraw");

let libPromise: Promise<ExcalidrawModule> | null = null;

/** 懒加载 Excalidraw 库；多处调用共用同一个 Promise。 */
export function loadExcalidraw(): Promise<ExcalidrawModule> {
  if (!libPromise) libPromise = import("@excalidraw/excalidraw");
  return libPromise;
}

/**
 * 把卡片里存的 source 解析成场景。
 *
 * 宽进：既吃完整的 .excalidraw 文件（{type,elements,appState,files}），
 * 也吃「只有 elements 数组」的裸粘贴，还吃 Excalidraw 复制到剪贴板的
 * excalidraw/clipboard 格式——用户手上能拿到的三种形态都认。
 * 解析不出来返回 null，调用方负责提示，而不是把半截数据画出来。
 */
export function parseScene(source: string): ExcalidrawScene | null {
  const raw = source.trim();
  if (!raw) return null;
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const elements = Array.isArray(data) ? data : Array.isArray(data?.elements) ? data.elements : null;
  if (!elements) return null;
  const appState = !Array.isArray(data) && data?.appState && typeof data.appState === "object" ? data.appState : {};
  const files = !Array.isArray(data) && data?.files && typeof data.files === "object" ? data.files : {};
  return {
    elements: elements.filter((element: any) => element && typeof element === "object"),
    appState,
    files,
  };
}

/** 场景里真正会画出来的元素（删掉的元素 Excalidraw 会留在文件里做撤销/协同）。 */
export function visibleElements(scene: ExcalidrawScene): ExcalidrawElement[] {
  return scene.elements.filter((element) => !(element as { isDeleted?: boolean }).isDeleted);
}

/** 按 .excalidraw 文件格式序列化，跟 Excalidraw 自己「导出到文件」出来的一致。 */
export async function serializeScene(scene: ExcalidrawScene): Promise<string> {
  const lib = await loadExcalidraw();
  return lib.serializeAsJSON(
    scene.elements,
    scene.appState as AppState,
    scene.files,
    "local",
  );
}

/**
 * 过一遍官方 restore：老版本文件缺的字段补上、坏掉的绑定修掉。
 * 直接把外来 JSON 丢给渲染/编辑器容易在细节上炸（比如缺 index、绑定指向不存在的元素）。
 */
export async function restoreScene(scene: ExcalidrawScene) {
  const lib = await loadExcalidraw();
  return lib.restore({ elements: scene.elements, appState: scene.appState, files: scene.files }, null, null);
}

/**
 * 场景 → PNG dataURL。卡面缩略图和「保存时回写的 thumbnail」都走这条。
 * maxWidthOrHeight 限死长边，避免一张大图把 boards.json 撑起来。
 */
export async function sceneToPngDataUrl(scene: ExcalidrawScene, maxWidthOrHeight = 900): Promise<string> {
  const lib = await loadExcalidraw();
  const restored = await restoreScene(scene);
  const elements = restored.elements.filter((element) => !element.isDeleted);
  if (!elements.length) return "";
  const blob = await lib.exportToBlob({
    elements,
    appState: {
      ...restored.appState,
      exportBackground: true,
      exportWithDarkMode: false,
      viewBackgroundColor: restored.appState.viewBackgroundColor || "#ffffff",
    },
    files: restored.files,
    mimeType: "image/png",
    exportPadding: 12,
    maxWidthOrHeight,
  });
  return await blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("缩略图读取失败"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 生成落库用的缩略图：先按 900 长边出图，超上限就降到 560 再试一次，
 * 还超就返回空串——宁可卡面走实时渲染，也不要把一坨 base64 塞进 boards.json。
 */
export async function sceneToThumbnail(scene: ExcalidrawScene, maxBytes: number): Promise<string> {
  for (const size of [900, 560]) {
    const dataUrl = await sceneToPngDataUrl(scene, size);
    if (!dataUrl) return "";
    if (dataUrl.length <= maxBytes) return dataUrl;
  }
  return "";
}

/**
 * 场景的版本号：卡面图 URL 上的 `?v=`。
 *
 * 卡面不在浏览器里渲染了（服务端出图，见 app/api/…/cards/[cardId]/drawing），
 * 前端只需要一个「这份场景变没变」的短标记：画一改哈希就变、URL 就变，
 * 那张图才能按 immutable 缓存而不会拿到旧的。
 * djb2 足够——它防的是「同一张卡换了内容」，不是防碰撞攻击。
 */
export function sceneRev(source: string): string {
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
  return `${source.length.toString(36)}${(hash >>> 0).toString(36)}`;
}
