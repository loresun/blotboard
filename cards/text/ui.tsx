"use client";

/** 文本卡的前端槽位（卡面 / 编辑器 / 工具条入口；自 CardBody / CardEditor / Toolbar 机械拆入）。 */
import { BodyText } from "@/components/cards/CardText";
import { ContentSection } from "@/components/cards/editor-bits";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

function Fields({ draft, patch, roomy }: EditorFieldsProps) {
  const t = useT();
  return (
    <ContentSection
      value={draft.content}
      onChange={(content) => patch({ content })}
      roomy={roomy}
      placeholder={t("cards.common.contentPlaceholder")}
    />
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    const t = useT();
    return card.content ? <BodyText text={card.content} /> : <span className="placeholder">{t("cards.text.empty")}</span>;
  },
  // 阅读模式走通用文本渲染（缺省 FullView）
  editor: {
    draftFrom(card) {
      return { content: card.content || "" };
    },
    buildPatch(_card, draft) {
      return { content: draft.content.trim() };
    },
    Fields,
  },
  toolbar: {
    title: "文本卡片",
    group: 1,
    order: 10,
    onClick: (ctx) => ctx.add("text"),
  },
};
