"use client";

/** PDF 卡的前端槽位（编辑器只有公共字段；新建走「上传」按钮，不进工具条）。 */
import { ICON_SM, UI } from "@/lib/icons";
import { formatSize } from "@/lib/constants";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi } from "@/lib/card-pack-client";

export const ui: CardPackUi = {
  CardFace({ card }) {
    const t = useT();
    return (
      <a className="file-chip nodrag" href={card.file?.url || "#"} target="_blank" rel="noopener noreferrer">
        <span className="file-chip-icon">
          <UI.detail size={18} strokeWidth={1.7} />
        </span>
        <span className="file-chip-text">
          <span className="fc-name">{card.file?.name || card.title || t("cards.pdf.document")}</span>
          <span className="fc-size">{t("cards.pdf.sizeOpen", { size: formatSize(card.file?.size) || "PDF" })}</span>
        </span>
        <UI.external {...ICON_SM} />
      </a>
    );
  },
  FullView({ card }) {
    return <iframe className="reader-frame" src={card.file?.url || ""} title={card.file?.name || "PDF"} />;
  },
};
