import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 链接卡：一个 URL + 标题 / 描述快照，页脚一键打开。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "link",
  label: "链接",
  fallbackTitle: "链接卡片",
  icon: "link",
  size: [280, 160],
  // 历史出入：落库默认高 150，与前端预估 160 差 10px——机械迁移保持原值
  defaultW: 280,
  defaultH: 150,
  color: "green",
  fieldKey: "link",
  groupOrder: 13,
  envelope: true,
  defaultEnabled: true,
  searchParts: (card) => [card.link?.url, card.link?.title, card.link?.desc],
};
