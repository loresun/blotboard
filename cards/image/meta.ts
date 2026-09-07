import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 图片卡：引用一个上传件（file.uploadId），卡面直接显示图。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "image",
  label: "图片",
  fallbackTitle: "图片卡片",
  icon: "image",
  size: [340, 280],
  defaultW: 340,
  defaultH: 280,
  color: "rose",
  fieldKey: "file",
  groupOrder: 11,
  // file 字段 image / pdf 共用；检索贡献只在这里给一次，pdf 包不再重复
  searchParts: (card) => [card.file?.name],
};
