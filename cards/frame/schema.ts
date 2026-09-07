/** 分组框的服务端归一化。字段极少：框只有一个「折不折叠」的状态。 */
import type { FrameField } from "@/lib/types";
import type { CardPackSchema } from "@/lib/card-pack-types";

/**
 * 框的标题是卡片自己的 `title`，这里不重复存一份——
 * 一个东西两处真源，迟早有一处忘了改（见 lib/types.ts 的 FrameField 抬头）。
 */
export function normalizeFrameField(frame: Partial<FrameField> = {}): FrameField {
  return { collapsed: frame?.collapsed === true };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.frame = normalizeFrameField(input.frame);
  },
  onConvert(card, patch) {
    card.frame = normalizeFrameField(patch.frame || card.frame || {});
  },
  onPatch(card, patch) {
    if (patch.frame !== undefined) card.frame = normalizeFrameField(patch.frame);
  },
  markdownLines(card) {
    // 导出里框只留一行说明：谁在框里靠子卡的 frameId 记着，
    // 而 md 是按类型分节排的，硬把子卡搬进来会打乱那个结构
    return [`- 分组框${card.frame?.collapsed ? "（已折叠）" : ""}：框住的卡片在正文各自的类型小节里`];
  },
};
