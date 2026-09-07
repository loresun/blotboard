import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** Mermaid 图表卡：流程图 / 时序图 / 甘特…源码存卡里，前端渲染、导出走服务端。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "mermaid",
  label: "图表",
  fallbackTitle: "Mermaid 图",
  icon: "mermaid",
  size: [420, 320],
  defaultW: 420,
  defaultH: 320,
  color: "blue",
  fieldKey: "mermaid",
  groupOrder: 7,
  envelope: true,
  defaultEnabled: true,
  searchParts: (card) => [card.mermaid?.source],
};
