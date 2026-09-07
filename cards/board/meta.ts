import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 子画板卡：把另一块画板当成本板上的一个节点，双击下钻。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "board",
  label: "子画板",
  fallbackTitle: "子画板",
  icon: "board",
  size: [280, 150],
  defaultW: 280,
  defaultH: 150,
  color: "slate",
  fieldKey: "boardRef",
  groupOrder: 14,
  searchParts: (card) => [card.boardRef?.name],
};
