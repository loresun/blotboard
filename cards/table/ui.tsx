"use client";

/** 表格卡的前端槽位。 */
import { TableCardFace, TableFullView } from "@/components/cards/TableCard";
import { SourceFace } from "@/components/cards/SourceFace";
import { tableToMarkdown } from "./parse";
import { useT } from "@/lib/i18n/client";
import type { ReactNode } from "react";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

/**
 * 编辑器就是**一段 Markdown 表格**。
 *
 * 不做「表格编辑器」（加行 / 加列 / 拖列宽）是有意的：那是电子表格的活，
 * 做半吊子只会两头不讨好。而 Markdown 表格所有人都会写、能整段粘贴、
 * 也正是 agent 手上最常见的形态——回填与导出用的还是同一个 tableToMarkdown，
 * 于是「编辑器里看到的」和「导出出去的」永远是同一种写法。
 */
function Fields({ draft, patch, roomy }: EditorFieldsProps) {
  const t = useT();
  return (
    <>
      <input
        type="text"
        data-field="table.caption"
        placeholder={t("cards.table.captionPlaceholder")}
        maxLength={300}
        value={draft.tableCaption}
        onChange={(event) => patch({ tableCaption: event.target.value })}
      />
      <span className="hint">{t("cards.table.hint")}</span>
      <textarea
        data-field="table.markdown"
        className={roomy ? "fill mono-area" : "mono-area"}
        rows={roomy ? 16 : 7}
        placeholder={t("cards.table.markdownPlaceholder")}
        value={draft.tableMarkdown}
        onChange={(event) => patch({ tableMarkdown: event.target.value })}
      />
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    const filled = Boolean(card.table?.columns?.length);
    const face = (action?: ReactNode) => <TableCardFace table={card.table} action={action} />;
    return (
      <SourceFace
        cardId={card.id}
        source={tableToMarkdown(card.table)}
        /* 与抽屉编辑器同一套：清空文本 = 清空表格（走结构化空表，见那边 buildPatch 的注释） */
        toPatch={(text) => {
          const markdown = text.trim();
          const caption = card.table?.caption || "";
          return markdown ? { table: { markdown, caption } } : { table: { columns: [], rows: [], caption } };
        }}
        hint="cards.table.faceHint"
        placeholder="cards.table.facePlaceholder"
      >
        {filled ? (action: ReactNode) => face(action) : face()}
      </SourceFace>
    );
  },
  FullView({ card }) {
    return <TableFullView table={card.table} />;
  },
  editor: {
    draftFrom(card) {
      return { tableMarkdown: tableToMarkdown(card.table), tableCaption: card.table?.caption || "" };
    },
    buildPatch(_card, draft) {
      const markdown = String(draft.tableMarkdown || "").trim();
      const caption = String(draft.tableCaption || "").trim();
      // 清空文本框 = 把表格清掉。走结构化空表而不是「不传」，
      // 否则「不传就保留上一版」的合并语义会让用户删不掉内容
      if (!markdown) return { table: { columns: [], rows: [], caption } };
      return { table: { markdown, caption } };
    },
    Fields,
  },
  toolbar: {
    title: "表格卡（可直接粘 Markdown 表格 / CSV）",
    group: 2,
    order: 60,
    onClick: (ctx) => ctx.add("table"),
  },
};
