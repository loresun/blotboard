"use client";

/** 引用卡的前端槽位。 */
import { BodyText, ReaderText } from "@/components/cards/CardText";
import { ContentSection } from "@/components/cards/editor-bits";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

function Fields({ draft, patch, roomy }: EditorFieldsProps) {
  const t = useT();
  return (
    <>
      <ContentSection
        value={draft.content}
        onChange={(content) => patch({ content })}
        roomy={roomy}
        placeholder={t("cards.common.contentPlaceholder")}
      />
      <input
        type="text"
        data-field="quote.source"
        placeholder={t("cards.quote.sourcePlaceholder")}
        value={draft.source}
        onChange={(event) => patch({ source: event.target.value })}
      />
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    return (
      <div className="quote-block">
        <BodyText text={card.content} />
        {card.quote?.source ? <div className="quote-source">—— {card.quote.source}</div> : null}
      </div>
    );
  },
  // 摊开看：引用正文不截断，出处照旧压在下面
  FullView({ card }) {
    return (
      <div className="reader-text quote-reader">
        <ReaderText body={card.content || ""} />
        {card.quote?.source ? <div className="quote-source">—— {card.quote.source}</div> : null}
      </div>
    );
  },
  // 阅读模式：通用文本渲染本来就带出处行（残留的 quote.source 也显示），缺省即可
  editor: {
    draftFrom(card) {
      return { content: card.content || "", source: card.quote?.source || "" };
    },
    buildPatch(_card, draft) {
      return { content: draft.content.trim(), quote: { source: draft.source.trim() } };
    },
    Fields,
  },
  toolbar: {
    title: "引用卡片",
    group: 1,
    order: 40,
    onClick: (ctx) => ctx.add("quote"),
  },
};
