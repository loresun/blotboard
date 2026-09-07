import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 网页嵌入卡：外部 PPT / 网页，沙箱 iframe 渲染；只存 URL，不存正文。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "html",
  label: "网页",
  fallbackTitle: "网页嵌入",
  icon: "html",
  size: [460, 320],
  defaultW: 460,
  defaultH: 320,
  color: "violet",
  fieldKey: "html",
  groupOrder: 10,
  // 自包含：只存 url（仍要过嵌入白名单校验，不合规按原规则拒）
  envelope: true,
  searchParts: (card) => [card.html?.url],
};
