"use client";

/** 图片卡的前端槽位（编辑器只有公共字段；新建走「上传」按钮，不进工具条）。 */
import { useT } from "@/lib/i18n/client";
import { useCardImage } from "@/lib/card-image-client";
import type { CardPackUi } from "@/lib/card-pack-client";

export const ui: CardPackUi = {
  CardFace({ card }) {
    const t = useT();
    // src 交给闸门发：屏幕外先不拉、同时最多 3 张在路上、切板即取消在途的那几张。
    // 卡面图动辄 2 MB，不限流就会把同源那 6 条连接占光，切板的 GET 只能排在后面
    // （慢网实测要等十几秒 —— 就是「图还在转、点别的画板没反应」那个 bug）
    const imgRef = useCardImage(card.file?.previewUrl);
    return (
      <div className="img-wrap">
        {card.file?.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img ref={imgRef} className="card-img" alt={card.title || ""} draggable={false} decoding="async" />
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
