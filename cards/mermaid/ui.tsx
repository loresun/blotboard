"use client";

/** Mermaid 卡的前端槽位。 */
import { MermaidCard } from "@/components/cards/DiagramCard";
import { useT } from "@/lib/i18n/client";
import { SourceFace } from "@/components/cards/SourceFace";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

function Fields({ draft, patch, roomy }: EditorFieldsProps) {
  const t = useT();
  return (
    <>
      <span className="hint">{t("cards.mermaid.hint")}</span>
      <textarea
        data-field="diagram"
        className={roomy ? "fill mono-area" : "mono-area"}
        rows={roomy ? 16 : 6}
        placeholder={t("cards.mermaid.placeholder")}
        value={draft.diagram}
        onChange={(event) => patch({ diagram: event.target.value })}
      />
    </>
  );
}

export const ui: CardPackUi = {
  // 卡面页脚多一个「编辑文本」：图表卡改的多半就是那几行源码，不必每次都进抽屉
  CardFace({ card }) {
    return (
      <SourceFace
        cardId={card.id}
        source={card.mermaid?.source || ""}
        toPatch={(text) => ({ mermaid: { source: text } })}
        hint="cards.mermaid.faceHint"
        placeholder="cards.mermaid.facePlaceholder"
      >
        <MermaidCard source={card.mermaid?.source || ""} cardId={card.id} />
      </SourceFace>
    );
  },
  FullView({ card, idPrefix }) {
    return <MermaidCard source={card.mermaid?.source || ""} cardId={`${idPrefix}-${card.id}`} />;
  },
  editor: {
    draftFrom(card) {
      return { diagram: card.mermaid?.source || "" };
    },
    buildPatch(_card, draft) {
      return { mermaid: { source: draft.diagram } };
    },
    Fields,
  },
  toolbar: {
    title: "Mermaid 图表卡（流程图 / 时序图 / 甘特…）",
    group: 2,
    order: 20,
    onClick: (ctx) => ctx.add("mermaid"),
  },
};
