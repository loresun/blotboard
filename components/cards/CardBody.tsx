"use client";

/**
 * 卡片正文（只读态）——分派器。
 *
 * 各类型的卡面在 cards/&lt;type&gt;/ui.tsx（经 lib/card-registry-client.ts），
 * 这里只做两件事：按 card.type 找包渲染；找不到包（数据里有、代码里没有的类型）
 * 走 **Tier 0 兜底**：正文 + 「类型未启用」灰标 + 折叠的原始字段表。
 * 数据本身在服务端按透传铁律原样保存，兜底只是让它在画布上仍然「看得见、不丢」。
 */
import { clientPack } from "@/lib/card-registry-client";
import { useT } from "@/lib/i18n/client";
import type { CardAction, CardFaceProps } from "@/lib/card-pack-client";
import { BodyText } from "./CardText";
import type { BoardCard } from "@/lib/types";

export type { CardAction };

/** BoardCard 公共字段：Tier 0 字段表只列这些之外的（专属字段）。 */
const COMMON_CARD_KEYS = new Set([
  "id", "type", "createdAt", "updatedAt", "createdBy", "x", "y", "w", "h", "z",
  "color", "title", "content", "agentPrompt", "frameId",
]);

export function unknownCardFields(card: BoardCard): [string, unknown][] {
  return Object.entries(card as unknown as Record<string, unknown>).filter(([key]) => !COMMON_CARD_KEYS.has(key));
}

/** Tier 0 兜底卡面：未知类型也要看得见、不丢数据。 */
function UnknownCardBody({ card }: { card: BoardCard }) {
  const t = useT();
  const extras = unknownCardFields(card);
  return (
    <div className="card-stack unknown-card">
      {card.content ? <BodyText text={card.content} className="grow" /> : null}
      <div className="task-foot nodrag">
        <span className="meta-chip unknown-chip" title={t("cards.unknown.chipTitle", { type: card.type })}>
          {t("cards.unknown.chip", { type: card.type })}
        </span>
        <span className="foot-spacer" />
      </div>
      {extras.length ? (
        <details className="unknown-fields nodrag nowheel">
          <summary>{t("cards.unknown.rawFields", { count: extras.length })}</summary>
          <pre>{JSON.stringify(Object.fromEntries(extras), null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function CardBody({ card, live, related, onAction }: CardFaceProps) {
  const Face = clientPack(card.type)?.ui?.CardFace;
  if (Face) return <Face card={card} live={live} related={related} onAction={onAction} />;
  return <UnknownCardBody card={card} />;
}
