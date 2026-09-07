import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 任务卡：goal + 状态机（idea → issued → running → done），可接 Runner 转 Issue / 发起任务。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "task",
  label: "任务",
  fallbackTitle: "任务卡片",
  icon: "task",
  size: [320, 215],
  // 历史出入：落库默认高 210，与前端预估 215 差 5px——机械迁移保持原值
  defaultW: 320,
  defaultH: 210,
  color: "blue",
  fieldKey: "task",
  groupOrder: 6,
  envelope: true,
  defaultEnabled: true,
  searchParts: (card) => [card.task?.goal, card.task?.issueNumber, card.task?.taskId],
};
