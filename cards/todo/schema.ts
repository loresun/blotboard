/** 待办卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import crypto from "node:crypto";
import type { TodoField, TodoItem } from "@/lib/types";
import { cleanText } from "@/lib/normalize-base";
import type { CardPackSchema } from "@/lib/card-pack-types";

export const MAX_TODO_ITEMS = 200;

/** 待办清单：条目上限挡住畸形输入，勾选时间只在「刚勾上」时记 */
export function normalizeTodoField(todo: Partial<TodoField> = {}): TodoField {
  const raw = Array.isArray(todo.items) ? todo.items : [];
  const items: TodoItem[] = [];
  for (const entry of raw as Partial<TodoItem>[]) {
    const text = cleanText(entry?.text, 500);
    if (!text) continue;
    const done = entry?.done === true;
    items.push({
      id: /^t_[a-z0-9]+$/.test(String(entry?.id || "")) ? String(entry!.id) : `t_${crypto.randomBytes(5).toString("hex")}`,
      text,
      done,
      doneAt: done ? (Number.isFinite(Number(entry?.doneAt)) ? Number(entry?.doneAt) : Date.now()) : null,
    });
    if (items.length >= MAX_TODO_ITEMS) break;
  }
  return { items };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.todo = normalizeTodoField(input.todo);
  },
  onConvert(card, patch) {
    card.todo = normalizeTodoField(patch.todo || card.todo || {});
  },
  onPatch(card, patch) {
    if (patch.todo !== undefined) card.todo = normalizeTodoField(patch.todo);
  },
  markdownLines(card) {
    if (!card.todo?.items.length) return [];
    return ["", ...card.todo.items.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`)];
  },
};
