import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 图书卡：指向本机书库里的一本书，卡面显示封面，正文回书库读。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "book",
  label: "图书",
  fallbackTitle: "图书卡片",
  icon: "book",
  size: [360, 240],
  defaultW: 360,
  defaultH: 240,
  color: "rose",
  fieldKey: "book",
  groupOrder: 2,
  // 自包含：卡里是书的元信息快照，正文在书库；对端没配书库也只是链接点不开，数据无损
  envelope: true,
  searchParts: (card) => [card.book?.bookId, card.book?.name, card.book?.subtitle, card.book?.author, card.book?.desc],
};
