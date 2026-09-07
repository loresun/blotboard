import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";
import { excalidrawText } from "@/lib/excalidraw-text";

/** Excalidraw 自由画卡：完整 .excalidraw JSON + 卡面缩略图。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "excalidraw",
  label: "Excalidraw",
  fallbackTitle: "Excalidraw",
  icon: "excalidraw",
  size: [420, 320],
  defaultW: 420,
  defaultH: 320,
  color: "amber",
  fieldKey: "excalidraw",
  groupOrder: 9,
  // 自包含：source 是自带的 .excalidraw JSON 字符串，换台机器照样能完整重建
  envelope: true,
  // 只捞画上写的字进搜索，不搜整份场景 JSON
  searchParts: (card) => [excalidrawText(card.excalidraw?.source)],
};
