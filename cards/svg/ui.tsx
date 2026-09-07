"use client";

/** SVG 卡的前端槽位。 */
import { SvgCard } from "@/components/cards/DiagramCard";
import { useT } from "@/lib/i18n/client";
import { SourceFace } from "@/components/cards/SourceFace";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

function Fields({ draft, patch, roomy }: EditorFieldsProps) {
  const t = useT();
  return (
    <>
      <span className="hint">{t("cards.svg.hint")}</span>
      <textarea
        data-field="diagram"
        className={roomy ? "fill mono-area" : "mono-area"}
        rows={roomy ? 16 : 6}
        placeholder='<svg viewBox="0 0 200 120">…</svg>'
        value={draft.diagram}
        onChange={(event) => patch({ diagram: event.target.value })}
      />
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    return (
      <SourceFace
        cardId={card.id}
        source={card.svg?.source || ""}
        toPatch={(text) => ({ svg: { source: text } })}
        hint="cards.svg.faceHint"
        placeholder="cards.svg.facePlaceholder"
      >
        <SvgCard source={card.svg?.source || ""} />
      </SourceFace>
    );
  },
  FullView({ card }) {
    return <SvgCard source={card.svg?.source || ""} />;
  },
  editor: {
    draftFrom(card) {
      return { diagram: card.svg?.source || "" };
    },
    buildPatch(_card, draft) {
      return { svg: { source: draft.diagram } };
    },
    Fields,
  },
  toolbar: {
    title: "SVG 卡：贴一段 SVG 源码就能当图看",
    group: 2,
    order: 40,
    onClick: (ctx) => ctx.add("svg"),
  },
};
