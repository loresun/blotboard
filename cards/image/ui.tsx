"use client";

/** 图片卡的前端槽位（编辑器只有公共字段；新建走「上传」按钮，不进工具条）。 */
import { useT } from "@/lib/i18n/client";
import type { CardPackUi } from "@/lib/card-pack-client";

export const ui: CardPackUi = {
  CardFace({ card }) {
    const t = useT();
    return (
      <div className="img-wrap">
        {card.file?.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="card-img" src={card.file.previewUrl} alt={card.title || ""} draggable={false} />
        ) : (
          <span className="placeholder">{t("cards.image.missing")}</span>
        )}
      </div>
    );
  },
  FullView({ card }) {
    // eslint-disable-next-line @next/next/no-img-element
    return card.file?.previewUrl ? <img className="reader-img" src={card.file.previewUrl} alt={card.title || ""} /> : null;
  },
};
