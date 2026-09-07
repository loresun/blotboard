import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 资料卡：一次知识库检索勾中的若干条，正文仍在知识库，卡里只留定位信息。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "ref",
  label: "资料",
  fallbackTitle: "资料卡片",
  icon: "ref",
  size: [340, 260],
  defaultW: 340,
  defaultH: 260,
  color: "blue",
  fieldKey: "ref",
  groupOrder: 1,
  // 自包含：卡里是一次检索的结果快照，正文在知识库；同 book，链接可达与否不影响数据完整
  envelope: true,
  searchParts: (card) => [
    card.ref?.query,
    ...(card.ref?.items || []).flatMap((item) => [item.title, item.snippet]),
  ],
};
