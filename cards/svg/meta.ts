import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** SVG 卡：贴一段 SVG 源码当图看（data URI 渲染，脚本不执行）。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "svg",
  label: "SVG",
  fallbackTitle: "SVG 图",
  icon: "svg",
  size: [380, 300],
  defaultW: 380,
  defaultH: 300,
  color: "violet",
  fieldKey: "svg",
  groupOrder: 8,
  envelope: true,
  // svg 源码是标签噪音，不参与搜索（机械保持 search-text 原口径）
};
