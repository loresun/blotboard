/** Mermaid 卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import type { MermaidField } from "@/lib/types";
import {
  MAX_DIAGRAM_SOURCE,
  assertSourceNotTopLevel,
  codeSourceText,
} from "@/lib/normalize-base";
import { badRequest } from "@/lib/http";
import type { CardPackSchema } from "@/lib/card-pack-types";

/**
 * source 是一段 Mermaid 源码。给对象在这里没有任何合理解释，
 * 而老写法 `String(对象)` 会落 `"[object Object]"` 进库、卡面只剩一句渲染失败——
 * 所以当场 400 点名（见 normalize-base.codeSourceText）。
 *
 * 超上限同样 400 不截断（与 code / svg / excalidraw 卡对齐）：截一半的图语法必然坏，
 * 与其静默存一张画不出来的卡，不如让调用方当场知道。
 */
export function normalizeMermaidField(mermaid: Partial<MermaidField> = {}): MermaidField {
  const raw = codeSourceText(mermaid.source, "mermaid.source");
  if (raw.length > MAX_DIAGRAM_SOURCE) {
    throw badRequest(
      `mermaid.source 太长了（${raw.length} 字符，上限 ${MAX_DIAGRAM_SOURCE}）：` +
        "一张卡装的是一张能一眼看完的图，整份图请拆成几张卡",
    );
  }
  return { source: raw.trim() };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    assertSourceNotTopLevel(input, "mermaid", "mermaid");
    card.mermaid = normalizeMermaidField(input.mermaid);
  },
  onConvert(card, patch) {
    assertSourceNotTopLevel(patch, "mermaid", "mermaid");
    card.mermaid = normalizeMermaidField(patch.mermaid || card.mermaid || {});
  },
  onPatch(card, patch) {
    assertSourceNotTopLevel(patch, "mermaid", "mermaid");
    if (patch.mermaid !== undefined) card.mermaid = normalizeMermaidField(patch.mermaid);
  },
  markdownLines(card) {
    if (!card.mermaid?.source) return [];
    return ["", "```mermaid", card.mermaid.source, "```"];
  },
};
