"use client";

/**
 * 一张卡片「摊开看」的样子：阅读模式弹窗用这一份——分派器。
 *
 * 各类型的摊开视图在 cards/&lt;type&gt;/ui.tsx 的 FullView 槽位；没有声明的
 * （text / task / quote / data，以及未知类型）走底下的通用文本渲染。
 *
 * 卡面（CardBody）不在这里：它是缩略版，要在 280px 里塞下要点，
 * 跟「摊开一整屏」是两套取舍。
 *
 * 导出也不在这里——它整个在服务端（lib/export-html.ts + cards/&lt;type&gt;/export.ts）。
 * 两边各写一份卡片渲染的代价与理由见 export-html 顶部注释。
 */
import { clientPack } from "@/lib/card-registry-client";
import { formatSize } from "@/lib/constants";
import { cardSnippet } from "@/lib/search-text";
import { cardLabel as cardTypeLabel } from "@/lib/i18n";
import { currentLocale, tr, useT } from "@/lib/i18n/client";
import { ReaderText } from "./CardText";
import { unknownCardFields } from "./CardBody";
import type { BoardCard } from "@/lib/types";

export { ReaderText };

/** 目录 / 翻页提示里的一行标题：有标题用标题，没标题退回正文开头，再不济说个类型 */
export function cardLabel(card: BoardCard): string {
  return cardSnippet(card, "", 18) || tr("cards.fallbackTitle", { label: cardTypeLabel(currentLocale(), card.type) });
}

export interface ReaderContentProps {
  card: BoardCard;
  /** mermaid 要往 DOM 里挂唯一 id；同一张卡可能同时在多处在场，前缀得分开 */
  idPrefix?: string;
}

export function ReaderContent({ card, idPrefix = "reader" }: ReaderContentProps) {
  const t = useT();
  const pack = clientPack(card.type);
  const FullView = pack?.ui?.FullView;
  if (FullView) return <FullView card={card} idPrefix={idPrefix} />;

  const body = card.content || card.task?.goal || "";
  const extras = pack ? [] : unknownCardFields(card);
  return (
    <div className="reader-text">
      {body ? <ReaderText body={body} /> : <span className="placeholder">{t("cards.readerNoBody")}</span>}
      {card.quote?.source ? <div className="quote-source">—— {card.quote.source}</div> : null}
      {card.file?.name ? (
        <div className="hint">
          {card.file.name} · {formatSize(card.file.size) || ""}
        </div>
      ) : null}
      {extras.length ? (
        // 未知类型：阅读模式同样降级——原始字段折叠着放在正文后面，内容不丢
        <details className="unknown-fields">
          <summary>{t("cards.unknown.readerRawFields", { type: card.type, count: extras.length })}</summary>
          <pre>{JSON.stringify(Object.fromEntries(extras), null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}
