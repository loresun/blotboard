import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";
import type { MindNode } from "@/lib/types";

function collectMindTexts(node: MindNode | null | undefined, out: string[]): void {
  if (!node) return;
  if (node.text) out.push(node.text);
  for (const child of node.children || []) collectMindTexts(child, out);
}

/** 思维导图卡：子卡片形态的最简导图（深度 10 / 节点 400 上限）。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "mindmap",
  label: "导图",
  fallbackTitle: "思维导图",
  icon: "mindmap",
  size: [420, 300],
  defaultW: 420,
  defaultH: 300,
  color: "green",
  fieldKey: "mindmap",
  groupOrder: 4,
  envelope: true,
  searchParts: (card) => {
    const out: string[] = [];
    if (card.mindmap?.root) collectMindTexts(card.mindmap.root, out);
    return out;
  },
};
