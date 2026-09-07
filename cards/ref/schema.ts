/** 资料卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import { REF_MODES, type RefField, type RefItem, type RefMode } from "@/lib/types";
import { MAX_TITLE, URL_RE, cleanText } from "@/lib/normalize-base";
import type { CardPackSchema } from "@/lib/card-pack-types";

export const MAX_REF_ITEMS = 40;

/** 知识库资料组：一次检索里被勾中的若干条，只留定位与展示要用的字段，正文仍回知识库取。 */
export function normalizeRefField(ref: Partial<RefField> = {}): RefField {
  const rawItems = Array.isArray(ref.items) ? ref.items : [];
  const seen = new Set<string>();
  const items: RefItem[] = [];
  for (const raw of rawItems as Partial<RefItem>[]) {
    const resourceId = cleanText(raw?.resourceId, 200);
    if (!resourceId || seen.has(resourceId)) continue;
    seen.add(resourceId);
    const url = cleanText(raw?.url, 2048);
    items.push({
      resourceId,
      title: cleanText(raw?.title, MAX_TITLE, { fallback: resourceId }),
      docId: cleanText(raw?.docId, 40),
      url: url && URL_RE.test(url) ? url : "",
      platform: cleanText(raw?.platform, 40),
      snippet: cleanText(raw?.snippet, 1200),
      score: Number.isFinite(Number(raw?.score)) ? Math.round(Number(raw?.score) * 1e4) / 1e4 : null,
    });
    if (items.length >= MAX_REF_ITEMS) break;
  }
  return {
    source: "aidocs",
    query: cleanText(ref.query, 300),
    mode: (REF_MODES as readonly string[]).includes(String(ref.mode)) ? (ref.mode as RefMode) : "vector",
    items,
    fetchedAt: Number.isFinite(Number(ref.fetchedAt)) ? Number(ref.fetchedAt) : Date.now(),
  };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.ref = normalizeRefField(input.ref);
  },
  onConvert(card, patch) {
    card.ref = normalizeRefField({ ...(card.ref || {}), ...(patch.ref || {}) });
  },
  onPatch(card, patch) {
    if (patch.ref !== undefined) card.ref = normalizeRefField({ ...(card.ref || {}), ...patch.ref });
  },
  markdownLines(card) {
    if (!card.ref) return [];
    const lines = [`- 知识库检索：「${card.ref.query}」· ${card.ref.mode} · ${card.ref.items.length} 条`];
    for (const item of card.ref.items) {
      lines.push(`  - ${item.title}${item.url ? ` — ${item.url}` : ""}（\`${item.resourceId}\`）`);
    }
    return lines;
  },
};
