"use client";

/** 规格卡（data）的前端槽位：卡面按规格 display 渲染，编辑器按规格出字段表。 */
import { useState } from "react";
import { DataCard } from "@/components/cards/DataCard";
import { DataFields, type FieldValues } from "@/components/cards/DataFields";
import { useBoardStore } from "@/lib/store";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

function Fields({ card, draft, patch, roomy }: EditorFieldsProps) {
  const t = useT();
  const [rawError, setRawError] = useState("");
  const specs = useBoardStore((state) => state.specs);
  const spec = card.data ? specs[card.data.specId] : undefined;
  if (!card.data) return null;

  return spec ? (
    <>
      <span className="hint">
        {t("cards.data.specHintBefore", { name: spec.name, version: spec.version })}<code>{spec.id}</code>{t("cards.data.specHintAfter")}
      </span>
      <DataFields spec={spec} values={draft.dataValues as FieldValues} onChange={(dataValues) => patch({ dataValues })} roomy={roomy} />
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          const state = useBoardStore.getState();
          state.setDrawer("specs");
        }}
      >
        {t("cards.data.viewSchema")}
      </button>
    </>
  ) : (
    <>
      <span className="hint">
        {t("cards.data.rawHintBefore")} <code>{card.data.specId}</code>{t("cards.data.rawHintAfter")}
      </span>
      <textarea
        data-field="data.raw"
        className={roomy ? "fill mono-area" : "mono-area"}
        rows={roomy ? 14 : 6}
        value={draft.rawJson}
        onChange={(event) => {
          patch({ rawJson: event.target.value });
          try {
            JSON.parse(event.target.value || "{}");
            setRawError("");
          } catch (err) {
            setRawError((err as Error).message);
          }
        }}
      />
      {rawError ? <span className="hint danger">{t("cards.data.jsonError", { error: rawError })}</span> : null}
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    return <DataCard card={card} />;
  },
  // 摊开看：同一份规格渲染，不截断（规格卡的正文全在 fields 里，
  //  走通用兜底的话 content 是空的，只会显示「这张卡还没有正文」）
  FullView({ card }) {
    return <DataCard card={card} full />;
  },
  editor: {
    draftFrom(card) {
      return {
        dataValues: card.data?.fields || {},
        rawJson: JSON.stringify(card.data?.fields || {}, null, 2),
      };
    },
    buildPatch(card, draft) {
      if (!card.data) return {};
      // 规格没装时走原始 JSON：解析失败就保持原样，不要把用户手打的一半内容吞掉
      const spec = useBoardStore.getState().specs[card.data.specId];
      let fields = draft.dataValues as FieldValues;
      if (!spec) {
        try {
          const parsed = JSON.parse(draft.rawJson || "{}");
          fields = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : card.data.fields;
        } catch {
          fields = card.data.fields;
        }
      }
      return { data: { specId: card.data.specId, fields } };
    },
    Fields,
  },
  toolbar: {
    label: "规格卡",
    title: "规格卡：按一份 JSON 规格记结构化信息（飞书消息 / 公众号文章 / 指标…）",
    group: 3,
    order: 10,
    onClick: () => useBoardStore.getState().setDrawer("specs"),
  },
};
