"use client";

/**
 * 音视频卡的前端槽位（编辑器只有公共字段；新建走「上传」按钮 / 拖文件进画布，不进工具条）。
 *
 * 三件按住的事：
 *  · `nodrag nopan`：播放器的进度条要能拖，不加这两个类，拖进度条会变成拖卡片 / 平移画布；
 *  · `preload="metadata"`：只取头部拿时长与首帧，一块板上十张视频卡不会同时开始下载正片；
 *  · **不自动播放**：画布上多张卡同时出声是灾难；`playsInline` 只是让 iOS 别强行全屏。
 */
import { ICON_SM, UI } from "@/lib/icons";
import { formatSize } from "@/lib/constants";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi } from "@/lib/card-pack-client";
import type { BoardCard } from "@/lib/types";

const isVideo = (card: BoardCard) => card.file?.kind === "video";
const subtitle = (card: BoardCard) =>
  [card.file?.mediaType || "", formatSize(card.file?.size)].filter(Boolean).join(" · ");

/** 音频卡面 / 摊开视图共用的一块：图标 + 文件名 + 播放器。 */
function AudioBlock({ card, className }: { card: BoardCard; className: string }) {
  const t = useT();
  return (
    <div className={className}>
      <div className="media-audio-head">
        <span className="file-chip-icon">
          <UI.audio {...ICON_SM} />
        </span>
        <span className="file-chip-text">
          <span className="fc-name">{card.file?.name || card.title || t("cards.media.audio")}</span>
          <span className="fc-size">{subtitle(card)}</span>
        </span>
      </div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio className="media-audio nodrag nopan" src={card.file?.url || ""} controls preload="metadata" />
    </div>
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    const t = useT();
    if (!card.file?.url) return <span className="placeholder">{t("cards.media.missing")}</span>;
    if (!isVideo(card)) return <AudioBlock card={card} className="media-wrap audio" />;
    return (
      <div className="media-wrap">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video className="media-video nodrag nopan" src={card.file.url} controls preload="metadata" playsInline />
      </div>
    );
  },
  FullView({ card }) {
    const t = useT();
    if (!card.file?.url) return <span className="placeholder">{t("cards.media.missing")}</span>;
    if (!isVideo(card)) return <AudioBlock card={card} className="reader-audio" />;
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video className="reader-media" src={card.file.url} controls preload="metadata" playsInline />
    );
  },
};
