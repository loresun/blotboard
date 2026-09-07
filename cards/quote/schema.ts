/** 引用卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import type { QuoteField } from "@/lib/types";
import { cleanText } from "@/lib/normalize-base";
import type { CardPackSchema } from "@/lib/card-pack-types";

export function normalizeQuoteField(quote: Partial<QuoteField> = {}): QuoteField {
  return { source: cleanText(quote.source, 300) };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.quote = normalizeQuoteField(input.quote);
  },
  onConvert(card) {
    card.quote = normalizeQuoteField(card.quote || {});
  },
  onPatch(card, patch) {
    if (patch.quote !== undefined) card.quote = normalizeQuoteField({ ...(card.quote || {}), ...patch.quote });
  },
};
