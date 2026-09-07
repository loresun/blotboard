import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** PDF 卡：引用一个上传件，卡面是文件条，点开在新页读。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "pdf",
  label: "PDF",
  fallbackTitle: "PDF 卡片",
  icon: "pdf",
  size: [280, 150],
  defaultW: 280,
  defaultH: 150,
  color: "rose",
  fieldKey: "file",
  groupOrder: 12,
  // file.name 的检索贡献在 image 包里给过一次（两型共用 file 字段），这里不重复
};
