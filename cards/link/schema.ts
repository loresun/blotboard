/** 链接卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import type { LinkField } from "@/lib/types";
import { URL_RE, cleanText } from "@/lib/normalize-base";
import { badRequest } from "@/lib/http";
import type { CardPackSchema } from "@/lib/card-pack-types";

export function normalizeLinkField(link: Partial<LinkField> = {}): LinkField {
  const url = cleanText(link.url, 2048);
  if (url && !URL_RE.test(url)) throw badRequest("link.url 必须是合法 http(s) 链接");
  let host = "";
  if (url) {
    try {
      host = new URL(url).host;
    } catch {
      host = "";
    }
  }
  return { url, host, title: cleanText(link.title, 300), desc: cleanText(link.desc, 2000) };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.link = normalizeLinkField(input.link);
  },
  onConvert(card) {
    card.link = normalizeLinkField(card.link || {});
  },
  onPatch(card, patch) {
    if (patch.link !== undefined) card.link = normalizeLinkField({ ...(card.link || {}), ...patch.link });
  },
  // `- 链接：` 那一行不按类型分派（残留的 link 字段也导）——留在 board-service 的公共段
};
