import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 文本卡：最朴素的一张卡，只有公共字段（标题 + 正文），没有专属字段。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "text",
  label: "文本",
  fallbackTitle: "文本卡片",
  icon: "text",
  size: [280, 170],
  defaultW: 280,
  defaultH: 170,
  color: "amber",
  fieldKey: null,
  groupOrder: 3,
  envelope: true,
  defaultEnabled: true,
};
