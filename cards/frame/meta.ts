import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/**
 * 分组框：把几张卡圈进一个框，整体拖动、可折叠。
 *
 * envelope: false —— 框本身能自包含，但**框里有什么**记在子卡的 `frameId` 上，
 * 那是本板内主键，换台机器指不到东西（同 image/pdf 的 uploadId、board 的 boardId）。
 * defaultEnabled: false —— 大板才需要分组，新装机不该一上来就多一个不知道干嘛的工具。
 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "frame",
  label: "分组框",
  fallbackTitle: "分组框",
  icon: "frame",
  // 默认就要装得下两三张卡：框太小的话，建出来第一件事永远是拉大它
  size: [460, 320],
  defaultW: 460,
  defaultH: 320,
  color: "slate",
  fieldKey: "frame",
  // 排在最后：按类型分区时，框跟被它圈住的卡本来就不参与重排（见 lib/layout.ts runLayout）
  groupOrder: 18,
  defaultEnabled: false,
};
