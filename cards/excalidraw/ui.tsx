"use client";

/** Excalidraw 卡的前端槽位（编辑走双击全屏弹窗；抽屉里的 JSON 只是兜底）。 */
import { ExcalidrawThumb } from "@/components/cards/DiagramCard";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

function Fields({ draft, patch, roomy }: EditorFieldsProps) {
  const t = useT();
  return (
    <>
      <span className="hint">{t("cards.excalidraw.hint")}</span>
      <textarea
        data-field="excalidraw.source"
        className={roomy ? "fill mono-area" : "mono-area"}
        rows={roomy ? 12 : 5}
        placeholder='{ "type": "excalidraw", "version": 2, "source": "https://excalidraw.com", "elements": [], "appState": {} }'
        value={draft.excalidrawSource}
        onChange={(event) => patch({ excalidrawSource: event.target.value })}
      />
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    return <ExcalidrawThumb source={card.excalidraw?.source || ""} cardId={card.id} />;
  },
  FullView({ card }) {
    // 阅读模式只是放大缩略图；要看真实 Excalidraw 编辑去双击卡面
    return <ExcalidrawThumb source={card.excalidraw?.source || ""} cardId={card.id} />;
  },
  editor: {
    draftFrom(card) {
      return { excalidrawSource: card.excalidraw?.source || "" };
    },
    buildPatch(card, draft) {
      return {
        excalidraw: {
          source: draft.excalidrawSource,
          thumbnail: card.excalidraw?.thumbnail,
          updatedAt: card.excalidraw?.updatedAt,
        },
      };
    },
    Fields,
  },
  toolbar: {
    title: "Excalidraw 卡：双击进全屏弹窗，直接在里面画，保存回写到卡面",
    group: 2,
    order: 50,
    onClick: (ctx) => ctx.add("excalidraw"),
  },
};
