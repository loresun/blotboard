"use client";

/** 链接卡的前端槽位。 */
import { ICON_SM, UI } from "@/lib/icons";
import { BodyText, ReaderText } from "@/components/cards/CardText";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

function Fields({ draft, patch, roomy }: EditorFieldsProps) {
  const t = useT();
  return (
    <>
      <input
        type="text"
        data-field="link.url"
        placeholder={t("cards.link.urlPlaceholder")}
        value={draft.linkUrl}
        onChange={(event) => patch({ linkUrl: event.target.value })}
      />
      <input
        type="text"
        data-field="link.title"
        placeholder={t("cards.link.titlePlaceholder")}
        value={draft.linkTitle}
        onChange={(event) => patch({ linkTitle: event.target.value })}
      />
      <textarea
        data-field="content"
        className={roomy ? "fill" : undefined}
        rows={roomy ? 8 : 2}
        placeholder={t("cards.link.notePlaceholder")}
        value={draft.content}
        onChange={(event) => patch({ content: event.target.value })}
      />
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    const t = useT();
    const url = card.link?.url || "";
    return (
      <div className="card-stack">
        <div className="grow link-body">
          {card.link?.title ? <div className="link-title">{card.link.title}</div> : null}
          {card.content ? <BodyText text={card.content} /> : null}
        </div>
        <a className="link-foot nodrag" href={url || "#"} target="_blank" rel="noopener noreferrer">
          <span className="host-chip">{card.link?.host || url || t("cards.link.noUrl")}</span>
          <UI.external {...ICON_SM} />
        </a>
      </div>
    );
  },
  FullView({ card }) {
    return (
      <div className="reader-text">
        <a href={card.link?.url} target="_blank" rel="noopener noreferrer">
          {card.link?.title || card.link?.url}
        </a>
        {card.content ? <ReaderText body={card.content} /> : null}
      </div>
    );
  },
  editor: {
    draftFrom(card) {
      return { linkUrl: card.link?.url || "", linkTitle: card.link?.title || "", content: card.content || "" };
    },
    buildPatch(_card, draft) {
      return { content: draft.content.trim(), link: { url: draft.linkUrl.trim(), title: draft.linkTitle.trim() } };
    },
    Fields,
  },
  toolbar: {
    title: "链接卡片",
    group: 1,
    order: 50,
    onClick: (ctx) => ctx.add("link"),
  },
};
