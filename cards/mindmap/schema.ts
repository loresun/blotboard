/** 思维导图卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import crypto from "node:crypto";
import { MIND_LAYOUTS, MIND_THEMES, type MindLayout, type MindNode, type MindTheme, type MindmapField } from "@/lib/types";
import { cleanText } from "@/lib/normalize-base";
import { mindmapOutlineLines } from "@/lib/mindmap";
import type { CardPackSchema } from "@/lib/card-pack-types";

export const MAX_MIND_NODES = 400;
const MAX_MIND_DEPTH = 10;

function normalizeMindNode(raw: any, depth: number, budget: { left: number }): MindNode {
  const node: MindNode = {
    id: /^m_[a-z0-9]+$/.test(String(raw?.id || "")) ? String(raw.id) : `m_${crypto.randomBytes(5).toString("hex")}`,
    text: cleanText(raw?.text, 300),
    children: [],
  };
  if (raw?.collapsed === true) node.collapsed = true;
  const children = Array.isArray(raw?.children) ? raw.children : [];
  if (depth >= MAX_MIND_DEPTH) return node;
  for (const child of children) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    node.children.push(normalizeMindNode(child, depth + 1, budget));
  }
  return node;
}

/** 思维导图：一棵有上限的树（深度 10 / 节点 400），够画「最简导图」，也挡住畸形输入。 */
export function normalizeMindmapField(input: Partial<MindmapField> = {}): MindmapField {
  const budget = { left: MAX_MIND_NODES };
  const root = normalizeMindNode(input.root || { text: "" }, 0, budget);
  if (!root.text) root.text = "中心主题";
  const layout = (MIND_LAYOUTS as readonly string[]).includes(String(input.layout))
    ? (input.layout as MindLayout)
    : "right";
  const theme = (MIND_THEMES as readonly string[]).includes(String(input.theme))
    ? (input.theme as MindTheme)
    : "classic";
  return { root, layout, theme };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.mindmap = normalizeMindmapField(input.mindmap);
  },
  onConvert(card, patch) {
    card.mindmap = normalizeMindmapField(patch.mindmap || card.mindmap || {});
  },
  onPatch(card, patch) {
    if (patch.mindmap === undefined) return;
    // 只传 layout（或只传 root）时跟现有的合并——整体替换会把没提到的那半边清成默认值
    card.mindmap = normalizeMindmapField({
      root: patch.mindmap?.root ?? card.mindmap?.root,
      layout: patch.mindmap?.layout ?? card.mindmap?.layout,
      theme: patch.mindmap?.theme ?? card.mindmap?.theme,
    });
  },
  markdownLines(card) {
    if (!card.mindmap) return [];
    return ["", ...mindmapOutlineLines(card.mindmap.root, 0)];
  },
};
