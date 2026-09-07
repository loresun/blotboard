"use client";

/** 思维导图卡的前端槽位（编辑走全屏弹窗 MindmapModal，抽屉里没有专属字段）。 */
import { MindmapView } from "@/components/mindmap/MindmapView";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi } from "@/lib/card-pack-client";

export const ui: CardPackUi = {
  CardFace({ card }) {
    const t = useT();
    const mind = card.mindmap;
    if (!mind?.root) return <span className="placeholder">{t("cards.mindmap.empty")}</span>;
    // 卡面只做缩略：等比缩到卡片里并居中，编辑走双击弹窗
    return <MindmapView root={mind.root} layout={mind.layout || "right"} theme={mind.theme || "classic"} fit />;
  },
  FullView({ card }) {
    if (!card.mindmap) return null;
    return <MindmapView root={card.mindmap.root} layout={card.mindmap.layout || "right"} theme={card.mindmap.theme || "classic"} />;
  },
  toolbar: {
    title: "思维导图卡片（双击进右侧抽屉编辑）",
    group: 2,
    order: 10,
    onClick: (ctx) => ctx.add("mindmap"),
  },
};
