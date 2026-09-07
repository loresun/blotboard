"use client";

/**
 * 对比模式：把 2-4 张卡并排摊开，各栏独立滚动。
 *
 * 用在「改稿前后」「方案 A/B」这类场景——在画布上它们是两张挨着的卡，
 * 可真要逐段比对时，得来回点开两个阅读弹窗，看完第二张就忘了第一张写的什么。
 *
 * **每一栏就是一张卡的阅读视图**：正文渲染直接复用 `ReaderContent`
 * （阅读模式用的同一份分派器），所以 21 种卡片包在这里全都自动能看，
 * 将来加卡片包也不用回来改这个文件。这里只负责分栏、滚动与差异高亮。
 *
 * 差异高亮只在「两张、且都取得到正文文本」时出现：三栏以上没有「左右」可言，
 * 图形卡（svg / mermaid / 图片）也没有可比的行。算法是自写的行级 LCS
 * （lib/text-diff.ts），不引依赖。
 */
import { useEffect, useMemo, useState } from "react";
import { ReaderContent, cardLabel } from "../cards/CardFullView";
import { COLORS } from "@/lib/constants";
import { useCardLabel, useT } from "@/lib/i18n/client";
import { ICON_MD, ICON_SM, UI, typeIcon } from "@/lib/icons";
import { diffLines, type DiffLine } from "@/lib/text-diff";
import { useBoardStore } from "@/lib/store";
import type { BoardCard } from "@/lib/types";

/**
 * 一张卡「有没有可以逐行比的正文」。
 *
 * 只认真正以文字为内容的类型：文本 / 引用 / 任务 / 代码。
 * 规格卡的内容在 data.fields 里（是结构化字段不是行），图形卡没有行——
 * 硬把它们的某个字段拼成文本再比，比出来的差异是假的。
 */
export function comparableText(card: BoardCard): string | null {
  if (card.type === "code") return card.code?.source ?? null;
  if (card.type === "text" || card.type === "quote") return card.content || "";
  if (card.type === "task") return card.content || card.task?.goal || "";
  return null;
}

export function CompareModal() {
  const ids = useBoardStore((state) => state.compareIds);
  const cards = useBoardStore((state) => state.board?.cards);
  const [diffOn, setDiffOn] = useState(false);
  const t = useT();
  const typeLabel = useCardLabel();

  const list = useMemo(
    () => ids.map((id) => (cards || []).find((card) => card.id === id)).filter((card): card is BoardCard => Boolean(card)),
    [ids, cards],
  );

  /** 差异开关只在「两张 + 都是文本类」时才出现（见抬头） */
  const texts = list.length === 2 ? list.map(comparableText) : [];
  const diffable = texts.length === 2 && texts[0] != null && texts[1] != null;
  const diff = useMemo(
    () => (diffable && diffOn ? diffLines(texts[0] as string, texts[1] as string) : null),
    // texts 每次渲染都是新数组，用内容本身当依赖，别让它每帧重算一遍 LCS
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diffable, diffOn, texts[0], texts[1]],
  );

  const close = () => useBoardStore.getState().openCompare([]);

  useEffect(() => {
    if (!ids.length) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ids.length]);

  /* 卡片被删了 / 换了板：栏数不够两张就自己收摊，别留一个空壳挡着画布 */
  useEffect(() => {
    if (ids.length && list.length < 2) useBoardStore.getState().openCompare([]);
  }, [ids.length, list.length]);

  /* 关掉再打开时差异开关回到默认关：上一次比的是另外两张卡 */
  useEffect(() => {
    if (!ids.length) setDiffOn(false);
  }, [ids.length]);

  if (!ids.length || list.length < 2) return null;

  return (
    <div className="modal-backdrop" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <div className="modal compare-modal" role="dialog" aria-modal="true" aria-label={t("panels.compare.title")}>
        <div className="modal-head">
          <h2>
            <UI.compare size={17} strokeWidth={1.8} />
            {t("panels.compare.heading", { count: list.length })}
          </h2>
          <span className="foot-spacer" />
          {diffable ? (
            <button
              className={`ro-toggle${diffOn ? " on" : ""}`}
              data-act="compare-diff"
              title={t("panels.compare.diff.title")}
              aria-pressed={diffOn}
              onClick={() => setDiffOn((value) => !value)}
            >
              <UI.filter {...ICON_SM} /> {t("panels.compare.diff")}
              {diff ? <span className="cmp-diff-count">{diff.changed}</span> : null}
            </button>
          ) : null}
          <span className="hint">{t("panels.compare.hint")}</span>
          <button className="drawer-close" data-act="compare-close" title={t("panels.closeEsc")} onClick={close}>
            <UI.close {...ICON_MD} />
          </button>
        </div>

        <div className="compare-main" data-cols={list.length}>
          {list.map((card, at) => {
            const Icon = typeIcon(card.type);
            const lines = diff ? (at === 0 ? diff.left : diff.right) : null;
            return (
              <section
                key={card.id}
                className="cmp-col"
                data-card-id={card.id}
                style={{ ["--card-accent" as string]: COLORS[card.color] }}
              >
                <header className="cmp-col-head">
                  <Icon size={13} strokeWidth={1.8} />
                  <span className="cmp-col-title" title={cardLabel(card)}>
                    {card.title || cardLabel(card)}
                  </span>
                  <span className="cmp-col-type">{typeLabel(card.type)}</span>
                </header>
                {/* 每栏自己滚：并排的意义就是「左边翻到哪，右边可以停在别处」 */}
                <div className="cmp-col-body">
                  {lines ? <DiffColumn lines={lines} /> : <ReaderContent card={card} idPrefix={`cmp-${at}`} />}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DiffColumn({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="cmp-diff">
      {lines.map((line, at) => (
        <div key={at} className={`cmp-line ${line.kind}`}>
          {/* 空行也要占一行高：不然增删的位置对不上原文的段落 */}
          {line.text || " "}
        </div>
      ))}
    </div>
  );
}
