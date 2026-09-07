import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/**
 * 规格卡：Tier-1 声明式引擎的宿主——按一份「卡片规格」（data/card-specs/*.json）
 * 填好的结构化信息。它不是十六分之一种普通卡片，是中间层引擎的入口。
 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "data",
  label: "规格",
  fallbackTitle: "规格卡片",
  icon: "data",
  size: [320, 240],
  defaultW: 320,
  defaultH: 240,
  color: "slate",
  fieldKey: "data",
  // 原 layout.ts GROUP_ORDER 里没有 data，indexOf 得 -1、排在最前——机械保持
  groupOrder: -1,
  defaultEnabled: true,
  // 规格卡：一张卡上大部分内容在 fields 里，不进 haystack 就等于搜不到
  searchParts: (card) => {
    const parts: (string | null | undefined)[] = [card.data?.specId];
    for (const value of Object.values(card.data?.fields || {})) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          parts.push(typeof item === "object" ? Object.values(item || {}).join(" ") : String(item));
        }
      } else {
        parts.push(String(value));
      }
    }
    return parts;
  },
};
