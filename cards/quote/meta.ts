import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 引用卡：一段话 + 出处。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "quote",
  label: "引用",
  fallbackTitle: "引用卡片",
  icon: "quote",
  size: [300, 200],
  defaultW: 300,
  defaultH: 200,
  color: "violet",
  fieldKey: "quote",
  groupOrder: 0,
  envelope: true,
  defaultEnabled: true,
  searchParts: (card) => [card.quote?.source],
};
