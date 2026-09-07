"use client";

/**
 * 连线工具条：点中一条线就出来的小面板。
 *
 * 之前只能改标签，颜色/线型只能通过「语义」间接拿到（EDGE_KIND_META 写死一套）。
 * 现在语义仍给默认外观，但每条线可以单独覆盖颜色 / 线型 / 粗细——
 * 「跟随语义」是显式的一档（存 null），所以改回默认不用记原来是哪种。
 *
 * **「外观」与「关系」是两个抽屉**，不是一个：
 * 外观（颜色 / 线型 / 粗细）改的是这条线画成什么样，关系（强弱 weight / 标签 tags）
 * 改的是这条线是什么意思。摆一起的话，把线调粗一点看着像顺手改了语义——
 * 而 weight 是会被布局算法与导出读走的东西，不能让人误改。
 */
import { useEffect, useRef, useState } from "react";
import {
  EDGE_COLORS,
  EDGE_KIND_HINT_KEY,
  EDGE_KIND_LABEL_KEY,
  EDGE_KIND_META,
  EDGE_STYLE_META,
  EDGE_WEIGHT_LABEL,
  EDGE_WIDTH_LABEL,
  MAX_EDGE_TAGS,
} from "@/lib/constants";
import { ICON_SM, UI } from "@/lib/icons";
import { useT } from "@/lib/i18n/client";
import { useBoardStore } from "@/lib/store";
import { CARD_COLORS, EDGE_KINDS, EDGE_STYLES, type BoardEdge, type CardColor, type EdgeStyle } from "@/lib/types";

export function EdgeToolbar({
  edge,
  left,
  top,
  onClose,
}: {
  edge: BoardEdge;
  left: number;
  top: number;
  onClose: () => void;
}) {
  const t = useT();
  const [label, setLabel] = useState(edge.label || "");
  const [openLook, setOpenLook] = useState(false);
  const [openRel, setOpenRel] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLabel(edge.label || "");
  }, [edge.id, edge.label]);

  // 换一条线就把没提交的标签草稿丢掉：它属于上一条线，跟过来会误加到这条上
  useEffect(() => {
    setTagDraft("");
  }, [edge.id]);

  const patch = (next: Parameters<ReturnType<typeof useBoardStore.getState>["patchEdgeStyle"]>[1]) => {
    useBoardStore
      .getState()
      .patchEdgeStyle(edge.id, next)
      .catch((err: Error) => useBoardStore.getState().showToast(err.message));
  };

  function commitLabel() {
    if ((edge.label || "") === label.trim()) return;
    patch({ label: label.trim() });
  }

  const kindMeta = EDGE_KIND_META[edge.kind] || EDGE_KIND_META.rel;
  const effectiveStyle: EdgeStyle = edge.style || (kindMeta.dashed ? "dashed" : "solid");
  const tags = edge.tags || [];

  function addTag() {
    const tag = tagDraft.trim().slice(0, 20);
    // 已经有了就不重复加（服务端也会去重，这里先给个不闪的反馈）
    if (!tag || tags.includes(tag) || tags.length >= MAX_EDGE_TAGS) {
      setTagDraft("");
      return;
    }
    setTagDraft("");
    patch({ tags: [...tags, tag] });
  }

  return (
    <div className="edge-toolbar" ref={ref} style={{ left, top }}>
      <div className="et-row">
        <input
          value={label}
          placeholder={t("pages.edge.label")}
          maxLength={60}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={commitLabel}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            if (event.key === "Escape") onClose();
          }}
        />
        <button
          className={openLook ? "active" : ""}
          title={t("pages.edge.look.title")}
          onClick={() => {
            setOpenLook((value) => !value);
            setOpenRel(false);
          }}
        >
          <span className="et-swatch" style={{ background: edge.color ? EDGE_COLORS[edge.color] : kindMeta.color }} />
          {t("pages.edge.look")}
        </button>
        <button
          className={openRel ? "active" : ""}
          data-act="edge-relation"
          title={t("pages.edge.rel.title")}
          onClick={() => {
            setOpenRel((value) => !value);
            setOpenLook(false);
          }}
        >
          <UI.weight size={13} strokeWidth={1.9} />
          {t("pages.edge.rel")}
          {edge.weight || tags.length ? <span className="et-badge">{edge.weight ? `${edge.weight}` : `${tags.length}`}</span> : null}
        </button>
        <button
          title={t("pages.edge.delete.title")}
          onClick={() => {
            void useBoardStore.getState().deleteEdgeWithUndo(edge.id);
            onClose();
          }}
        >
          <UI.remove size={13} strokeWidth={1.9} /> {t("common.delete")}
        </button>
      </div>

      {openLook ? (
        <div className="et-look">
          <div className="et-look-row">
            <span className="et-look-label">{t("pages.edge.color")}</span>
            <button
              className={`et-chip${edge.color ? "" : " on"}`}
              title={t("pages.edge.color.follow.title")}
              onClick={() => patch({ color: null })}
            >
              {t("pages.edge.color.follow")}
            </button>
            {CARD_COLORS.map((color: CardColor) => (
              <button
                key={color}
                className={`et-dot${edge.color === color ? " on" : ""}`}
                style={{ background: EDGE_COLORS[color] }}
                title={color}
                onClick={() => patch({ color })}
              />
            ))}
          </div>

          <div className="et-look-row">
            <span className="et-look-label">{t("pages.edge.style")}</span>
            {EDGE_STYLES.map((style) => (
              <button
                key={style}
                className={`et-chip${effectiveStyle === style ? " on" : ""}`}
                onClick={() => patch({ style: edge.style === style ? null : style })}
              >
                <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden>
                  <line
                    x1="1"
                    y1="4"
                    x2="25"
                    y2="4"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeDasharray={EDGE_STYLE_META[style].dash}
                  />
                </svg>
                {t(EDGE_STYLE_META[style].label)}
              </button>
            ))}
          </div>

          <div className="et-look-row">
            <span className="et-look-label">{t("pages.edge.width")}</span>
            {[1, 2, 3].map((width) => (
              <button
                key={width}
                className={`et-chip${(edge.width || 2) === width ? " on" : ""}`}
                onClick={() => patch({ width })}
              >
                {t(EDGE_WIDTH_LABEL[width - 1])}
              </button>
            ))}
          </div>

          <div className="et-look-row">
            <span className="et-look-label">{t("pages.edge.kind")}</span>
            {EDGE_KINDS.map((kind) => (
              <button
                key={kind}
                className={`et-chip${edge.kind === kind ? " on" : ""}`}
                title={t(EDGE_KIND_HINT_KEY[kind])}
                onClick={() => patch({ kind })}
              >
                <span className="et-dot mini" style={{ background: EDGE_KIND_META[kind].color }} />
                {t(EDGE_KIND_LABEL_KEY[kind])}
              </button>
            ))}
          </div>

          <div className="et-look-foot">
            <UI.relations {...ICON_SM} />
            {t("pages.edge.look.foot")}
          </div>
        </div>
      ) : null}

      {openRel ? (
        <div className="et-look et-rel">
          <div className="et-look-row">
            <span className="et-look-label">{t("pages.edge.weight")}</span>
            <button
              className={`et-chip${edge.weight ? "" : " on"}`}
              title={t("pages.edge.weight.none.title")}
              data-weight="none"
              onClick={() => patch({ weight: null })}
            >
              {t("pages.edge.weight.none")}
            </button>
            {[1, 2, 3, 4, 5].map((weight) => (
              <button
                key={weight}
                className={`et-chip${edge.weight === weight ? " on" : ""}`}
                data-weight={weight}
                title={t("pages.edge.weight.title", { label: t(EDGE_WEIGHT_LABEL[weight - 1]), weight })}
                // 再点一次同一档 = 取消标注：不用先去找「未标」那颗
                onClick={() => patch({ weight: edge.weight === weight ? null : weight })}
              >
                {weight}
              </button>
            ))}
          </div>

          <div className="et-look-row et-tags">
            <span className="et-look-label">{t("pages.edge.tags")}</span>
            {tags.map((tag) => (
              <button
                key={tag}
                className="et-chip on"
                title={t("pages.edge.tag.remove", { tag })}
                onClick={() => patch({ tags: tags.filter((item) => item !== tag) })}
              >
                #{tag}
                <UI.close size={11} strokeWidth={2.1} />
              </button>
            ))}
            {tags.length < MAX_EDGE_TAGS ? (
              <input
                className="et-tag-input"
                data-field="edge.tag"
                value={tagDraft}
                placeholder={t("pages.edge.tag.add")}
                maxLength={20}
                onChange={(event) => setTagDraft(event.target.value)}
                onBlur={addTag}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addTag();
                  }
                  if (event.key === "Escape") setTagDraft("");
                }}
              />
            ) : (
              <span className="et-look-label">{t("pages.edge.tag.full", { max: MAX_EDGE_TAGS })}</span>
            )}
          </div>

          <div className="et-look-foot">
            <UI.tags {...ICON_SM} />
            {t("pages.edge.rel.foot")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
