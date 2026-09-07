"use client";

/**
 * 编辑器共用小件（自 CardEditor.tsx 拆出）：
 * 正文 textarea + Markdown 预览开关，text / task / quote 三个包共用同一份。
 */
import { useState } from "react";
import { Markdown } from "./Markdown";
import { ICON_SM, UI } from "@/lib/icons";
import { useT } from "@/lib/i18n/client";

export function ContentSection({
  value,
  onChange,
  roomy,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  roomy: boolean;
  placeholder: string;
}) {
  const t = useT();
  /** 正文的 Markdown 预览开关；换一张卡时随 Fields 整体重挂（key=card.id），自动退回编辑态 */
  const [preview, setPreview] = useState(false);
  return (
    <>
      {/* 正文是按 Markdown 渲染的（卡面、阅读模式都是），所以写的时候得能当场看一眼排成什么样 */}
      <div className="row">
        <span className="hint">{t("cards.editor.markdownHint")}</span>
        <span className="row-gap" />
        <button
          type="button"
          className={`mini-btn${preview ? " primary" : ""}`}
          data-act="md-preview"
          title={preview ? t("cards.editor.backToEdit") : t("cards.editor.previewTitle")}
          onClick={() => setPreview((on) => !on)}
        >
          <UI.markdown {...ICON_SM} />
          {preview ? t("cards.editor.backToEdit") : t("cards.editor.preview")}
        </button>
      </div>
      {preview ? (
        <div className={`md-preview nowheel${roomy ? " fill" : ""}`}>
          {value.trim() ? <Markdown text={value} /> : <span className="placeholder">{t("cards.editor.noBody")}</span>}
        </div>
      ) : (
        <textarea
          data-field="content"
          className={roomy ? "fill" : undefined}
          rows={roomy ? 14 : 4}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </>
  );
}
