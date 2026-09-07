/** Mermaid 卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import type { MermaidField } from "@/lib/types";
import { MAX_DIAGRAM_SOURCE, codeSourceText } from "@/lib/normalize-base";
import type { CardPackSchema } from "@/lib/card-pack-types";

/**
 * source 是一段 Mermaid 源码。给对象在这里没有任何合理解释，
 * 而老写法 `String(对象)` 会落 `"[object Object]"` 进库、卡面只剩一句渲染失败——
 * 所以当场 400 点名（见 normalize-base.codeSourceText）。
 */
export function normalizeMermaidField(mermaid: Partial<MermaidField> = {}): MermaidField {
  return { source: codeSourceText(mermaid.source, "mermaid.source").slice(0, MAX_DIAGRAM_SOURCE).trim() };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.mermaid = normalizeMermaidField(input.mermaid);
  },
  onConvert(card, patch) {
    card.mermaid = normalizeMermaidField(patch.mermaid || card.mermaid || {});
  },
  onPatch(card, patch) {
    if (patch.mermaid !== undefined) card.mermaid = normalizeMermaidField(patch.mermaid);
  },
  markdownLines(card) {
    if (!card.mermaid?.source) return [];
    return ["", "```mermaid", card.mermaid.source, "```"];
  },
};
