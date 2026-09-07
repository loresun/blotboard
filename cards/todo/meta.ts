import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 待办卡（收集箱）：卡面上直接勾、直接加，深度整理进抽屉。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "todo",
  label: "待办",
  fallbackTitle: "待办清单",
  icon: "todo",
  size: [300, 280],
  defaultW: 300,
  defaultH: 280,
  color: "amber",
  fieldKey: "todo",
  groupOrder: 5,
  envelope: true,
  defaultEnabled: true,
  searchParts: (card) => (card.todo?.items || []).map((item) => item.text),
};
