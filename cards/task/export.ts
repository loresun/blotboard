/** 任务卡的排版导出（自 lib/export-html.ts 机械拆入）。 */
import { body, chip } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card) {
    const task = card.task;
    const chips = [
      chip(task ? { idea: "想法", issued: "已建 Issue", running: "执行中", done: "已完成" }[task.status] : "", "badge"),
      task?.priority && task.priority !== "none"
        ? chip(`优先级 ${{ urgent: "紧急", high: "高", medium: "中", low: "低" }[task.priority] || task.priority}`)
        : "",
      task?.issueNumber ? chip(task.issueNumber) : "",
    ]
      .filter(Boolean)
      .join("");
    return `${chips ? `<p class="meta">${chips}</p>` : ""}${body(card.content || task?.goal || "")}`;
  },
};
