"use client";

/** 待办卡（收集箱）的前端槽位。 */
import { useRef, useState } from "react";
import { ICON_SM, UI } from "@/lib/icons";
import { useBoardStore } from "@/lib/store";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";
import type { BoardCard } from "@/lib/types";

function newTodoId(): string {
  return `t_${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 待办清单（收集箱）。
 *
 * 刻意做成「卡面上直接勾、直接加」：收集箱的价值在于随手记，
 * 每记一条都要双击进抽屉的话就没人用了。深度整理（改文字、排序、清理）才进抽屉。
 */
function TodoList({ card }: { card: BoardCard }) {
  const t = useT();
  const items = card.todo?.items || [];
  const [draft, setDraft] = useState("");
  const writeChain = useRef<Promise<unknown>>(Promise.resolve());
  const done = items.filter((item) => item.done).length;

  /**
   * 写操作排队串行。
   * 收集箱是「连着敲回车往里扔」的用法，两条挨得很近时，第二次拿到的还是上一次
   * 落库前的旧列表——前一条就被覆盖掉了。所以每次写都排在上一次之后，
   * 并且到点了再从 store 取最新列表，而不是用渲染时闭包里的那份。
   */
  function write(update: (current: typeof items) => typeof items) {
    writeChain.current = writeChain.current
      .catch(() => undefined)
      .then(() => {
        const state = useBoardStore.getState();
        const current = state.board?.cards.find((item) => item.id === card.id)?.todo?.items || [];
        return state.patchCard(card.id, { todo: { items: update(current) } });
      })
      .catch((err: Error) => useBoardStore.getState().showToast(err.message));
  }

  function toggle(id: string) {
    write((current) =>
      current.map((item) => (item.id === id ? { ...item, done: !item.done, doneAt: item.done ? null : Date.now() } : item)),
    );
  }

  function add() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    write((current) => [...current, { id: newTodoId(), text, done: false }]);
  }

  return (
    <div className="card-stack">
      <div className="grow todo-list nowheel">
        {items.length ? (
          items.map((item) => (
            <div className={`todo-item${item.done ? " done" : ""}`} key={item.id}>
              <button
                className="todo-check nodrag"
                title={item.done ? t("cards.todo.markUndone") : t("cards.todo.markDone")}
                onClick={() => toggle(item.id)}
              >
                {item.done ? <UI.check size={11} strokeWidth={3} /> : null}
              </button>
              <span className="todo-text">{item.text}</span>
            </div>
          ))
        ) : (
          <span className="placeholder">{t("cards.todo.empty")}</span>
        )}
      </div>
      <div className="todo-foot nodrag">
        <span className="todo-add">
          <UI.add size={13} strokeWidth={2} />
          <input
            value={draft}
            placeholder={t("cards.todo.addPlaceholder")}
            maxLength={500}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add();
              if (event.key === "Escape") setDraft("");
            }}
            onBlur={add}
          />
        </span>
        {items.length ? (
          <span className="meta-chip mono" title={t("cards.todo.countTitle")}>
            {done}/{items.length}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Fields({ draft, patch }: EditorFieldsProps) {
  const t = useT();
  const todoItems = draft.todoItems as { id: string; text: string; done: boolean; doneAt?: number | null }[];
  const [todoDraft, setTodoDraft] = useState("");
  const setItems = (updater: (prev: typeof todoItems) => typeof todoItems) => patch({ todoItems: updater(todoItems) });

  const append = () => {
    const text = todoDraft.trim();
    if (!text) return;
    setTodoDraft("");
    setItems((prev) => [...prev, { id: newTodoId(), text, done: false }]);
  };

  return (
    <>
      <span className="hint">{t("cards.todo.editHint")}</span>
      <div className="todo-edit">
        {todoItems.length ? (
          todoItems.map((item, index) => (
            <div className={`todo-edit-row${item.done ? " done" : ""}`} key={item.id}>
              <button
                type="button"
                className={`todo-check${item.done ? " on" : ""}`}
                title={item.done ? t("cards.todo.markUndone") : t("cards.todo.markDone")}
                onClick={() =>
                  setItems((prev) =>
                    prev.map((entry) =>
                      entry.id === item.id ? { ...entry, done: !entry.done, doneAt: entry.done ? null : Date.now() } : entry,
                    ),
                  )
                }
              >
                {item.done ? <UI.check size={11} strokeWidth={3} /> : null}
              </button>
              <input
                type="text"
                value={item.text}
                maxLength={500}
                onChange={(event) =>
                  setItems((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, text: event.target.value } : entry)))
                }
              />
              <button
                type="button"
                className="ac-icon-btn"
                title={t("cards.todo.moveUp")}
                disabled={index === 0}
                onClick={() =>
                  setItems((prev) => {
                    const next = [...prev];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    return next;
                  })
                }
              >
                <UI.chevron size={13} strokeWidth={2} style={{ transform: "rotate(180deg)" }} />
              </button>
              <button
                type="button"
                className="ac-icon-btn danger"
                title={t("cards.todo.delete")}
                onClick={() => setItems((prev) => prev.filter((entry) => entry.id !== item.id))}
              >
                <UI.remove {...ICON_SM} />
              </button>
            </div>
          ))
        ) : (
          <span className="hint">{t("cards.todo.noneYet")}</span>
        )}
      </div>
      <div className="todo-edit-add">
        <UI.add size={13} strokeWidth={2} />
        <input
          type="text"
          placeholder={t("cards.todo.addPlaceholderEnter")}
          maxLength={500}
          value={todoDraft}
          onChange={(event) => setTodoDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            append();
          }}
          onBlur={append}
        />
      </div>
      {todoItems.some((item) => item.done) ? (
        <button type="button" className="mini-btn" onClick={() => setItems((prev) => prev.filter((item) => !item.done))}>
          <UI.remove {...ICON_SM} /> {t("cards.todo.clearDone", { count: todoItems.filter((item) => item.done).length })}
        </button>
      ) : null}
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    return <TodoList card={card} />;
  },
  FullView({ card }) {
    return (
      <div className="reader-text">
        {(card.todo?.items || []).map((item) => (
          <div className={`reader-todo${item.done ? " done" : ""}`} key={item.id}>
            <span className="todo-check">{item.done ? <UI.check size={11} strokeWidth={3} /> : null}</span>
            {item.text}
          </div>
        ))}
      </div>
    );
  },
  editor: {
    draftFrom(card) {
      return { todoItems: card.todo?.items || [] };
    },
    buildPatch(_card, draft) {
      return { todo: { items: draft.todoItems } };
    },
    Fields,
  },
  toolbar: {
    title: "待办清单（收集箱：卡面上直接勾、直接加）",
    group: 1,
    order: 30,
    onClick: (ctx) => ctx.add("todo"),
  },
};
