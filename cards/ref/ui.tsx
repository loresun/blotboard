"use client";

/** 资料卡的前端槽位（入口双闸：包启用 且 阶段 A 的 search feature 配置了）。 */
import { ICON_SM, UI } from "@/lib/icons";
import { useFeatures } from "@/lib/features-client";
import { refPrimaryUrl } from "@/lib/aidocs-link";
import { useBoardStore } from "@/lib/store";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";
import type { RefItem } from "@/lib/types";

function Fields({ card, draft, patch }: EditorFieldsProps) {
  const t = useT();
  const features = useFeatures();
  const refItems = draft.refItems as RefItem[];
  return (
    <>
      <span className="hint">{t("cards.ref.hint", { query: card.ref?.query || "—" })}</span>
      <div className="ref-edit-list">
        {refItems.length ? (
          refItems.map((item) => (
            <div className="ref-edit-row" key={item.resourceId}>
              <span className="ref-edit-title" title={item.snippet || item.title}>
                {item.title}
              </span>
              {refPrimaryUrl(item) ? (
                <a href={refPrimaryUrl(item)} target="_blank" rel="noopener noreferrer" title={t("cards.ref.openInKb")}>
                  <UI.library {...ICON_SM} />
                </a>
              ) : null}
              {item.url ? (
                <a href={item.url} target="_blank" rel="noopener noreferrer" title={t("cards.ref.openSource")}>
                  <UI.external {...ICON_SM} />
                </a>
              ) : null}
              <button
                type="button"
                className="ac-icon-btn danger"
                title={t("cards.ref.remove")}
                onClick={() => patch({ refItems: refItems.filter((entry) => entry.resourceId !== item.resourceId) })}
              >
                <UI.remove {...ICON_SM} />
              </button>
            </div>
          ))
        ) : (
          <span className="hint">{t("cards.ref.noItems")}</span>
        )}
      </div>
      {features.search ? (
        <button
          type="button"
          className="mini-btn"
          onClick={() => {
            const state = useBoardStore.getState();
            state.setRefTarget(card.id);
            state.setDrawer("aidocs");
          }}
        >
          <UI.search {...ICON_SM} /> {t("cards.ref.searchMore")}
        </button>
      ) : null}
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    const t = useT();
    const ref = card.ref;
    if (!ref?.items.length) return <span className="placeholder">{t("cards.ref.empty")}</span>;
    return (
      <div className="card-stack">
        <div className="grow ref-list nowheel">
          {ref.items.map((item) => (
            <a
              key={item.resourceId}
              className="ref-item nodrag"
              href={refPrimaryUrl(item) || "#"}
              target={refPrimaryUrl(item) ? "_blank" : undefined}
              rel="noopener noreferrer"
              onClick={(event) => {
                if (!refPrimaryUrl(item)) event.preventDefault();
              }}
              title={`${t("cards.ref.openInKb")}${item.snippet ? `\n${item.snippet}` : ""}`}
            >
              <span className="ref-dot" />
              <span className="ref-title">{item.title}</span>
              {item.platform ? <span className="ref-plat">{item.platform}</span> : null}
            </a>
          ))}
        </div>
        <div className="task-foot nodrag">
          <span className="meta-chip" title={t("cards.ref.modeTitle", { mode: t(ref.mode === "vector" ? "cards.ref.mode.vector" : "cards.ref.mode.hybrid") })}>
            <UI.search {...ICON_SM} />
            {ref.query || t("cards.ref.kb")}
          </span>
          <span className="meta-chip mono">{ref.items.length}</span>
          <span className="foot-spacer" />
        </div>
      </div>
    );
  },
  FullView({ card }) {
    return (
      <div className="reader-text">
        {(card.ref?.items || []).map((item) => (
          <a className="reader-ref" key={item.resourceId} href={refPrimaryUrl(item)} target="_blank" rel="noopener noreferrer">
            <strong>{item.title}</strong>
            {item.platform ? <span className="meta-chip">{item.platform}</span> : null}
            {item.snippet ? <p>{item.snippet}</p> : null}
          </a>
        ))}
      </div>
    );
  },
  editor: {
    draftFrom(card) {
      return { refItems: card.ref?.items || [] };
    },
    buildPatch(card, draft) {
      return card.ref ? { ref: { ...card.ref, items: draft.refItems } } : {};
    },
    Fields,
  },
  toolbar: {
    title: "从知识库检索资料，勾中的攒成资料卡",
    feature: "search",
    group: 4,
    order: 10,
    onClick: () => {
      const state = useBoardStore.getState();
      // 正选中一张资料卡时，默认把这次捞到的追加进去（用户仍可改成新建）
      const selected = state.selection?.kind === "card" ? state.board?.cards.find((c) => c.id === state.selection!.id) : null;
      state.setRefTarget(selected?.type === "ref" ? selected.id : null);
      state.setDrawer("aidocs");
    },
  },
};
