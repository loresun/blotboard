"use client";

/** 代码卡的前端槽位。 */
import { CodeBlock, CodeCardFace, CopyCodeButton } from "@/components/cards/CodeCard";
import { SourceFace } from "@/components/cards/SourceFace";
import { COMMON_LANGUAGES } from "./languages";
import { useT } from "@/lib/i18n/client";
import type { ReactNode } from "react";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

function Fields({ draft, patch, roomy }: EditorFieldsProps) {
  const t = useT();
  return (
    <>
      <div className="row">
        {/* language 是自由值：datalist 只是提示，输 zig / hcl 照样存得下（见 languages.ts） */}
        <input
          type="text"
          data-field="code.language"
          className="mono"
          list="code-language-options"
          placeholder={t("cards.code.languagePlaceholder")}
          maxLength={20}
          value={draft.codeLanguage}
          onChange={(event) => patch({ codeLanguage: event.target.value })}
        />
        <datalist id="code-language-options">
          {COMMON_LANGUAGES.map((language) => (
            <option key={language} value={language} />
          ))}
        </datalist>
        <input
          type="text"
          data-field="code.filename"
          className="mono"
          placeholder={t("cards.code.filenamePlaceholder")}
          maxLength={200}
          value={draft.codeFilename}
          onChange={(event) => patch({ codeFilename: event.target.value })}
        />
      </div>
      <span className="hint">{t("cards.code.hint")}</span>
      <textarea
        data-field="code.source"
        className={roomy ? "fill mono-area" : "mono-area"}
        rows={roomy ? 18 : 8}
        placeholder={t("cards.code.sourcePlaceholder")}
        value={draft.codeSource}
        onChange={(event) => patch({ codeSource: event.target.value })}
      />
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    const source = card.code?.source || "";
    const face = (action?: ReactNode) => (
      <CodeCardFace source={source} language={card.code?.language || ""} filename={card.code?.filename} action={action} />
    );
    return (
      <SourceFace
        cardId={card.id}
        source={source}
        /* code 走合并语义（cards/code/schema.ts）：只补 source，语言 / 文件名不受影响 */
        toPatch={(text) => ({ code: { source: text } })}
        hint="cards.code.faceHint"
        placeholder="cards.code.facePlaceholder"
      >
        {/* 空卡面只有一句占位、没有页脚，那时按钮交给 SourceFace 自带的那行 */}
        {source ? (action: ReactNode) => face(action) : face()}
      </SourceFace>
    );
  },
  FullView({ card }) {
    const t = useT();
    const source = card.code?.source || "";
    if (!source) return <span className="placeholder">{t("cards.code.readerEmpty")}</span>;
    return (
      <div className="reader-code">
        <div className="reader-code-head">
          <span className="meta-chip mono">{card.code?.language || t("cards.code.plaintext")}</span>
          {card.code?.filename ? <span className="code-file mono">{card.code.filename}</span> : null}
          <span className="foot-spacer" />
          <CopyCodeButton source={source} />
        </div>
        {/* 阅读模式给行号：摊开一整屏正是「第 37 行那句」有意义的场合 */}
        <CodeBlock source={source} language={card.code?.language || ""} lineNumbers className="reader-code-body" />
      </div>
    );
  },
  editor: {
    draftFrom(card) {
      return {
        codeSource: card.code?.source || "",
        codeLanguage: card.code?.language || "",
        codeFilename: card.code?.filename || "",
      };
    },
    buildPatch(_card, draft) {
      return {
        code: {
          source: draft.codeSource,
          language: draft.codeLanguage.trim().toLowerCase(),
          filename: draft.codeFilename.trim(),
        },
      };
    },
    Fields,
  },
  toolbar: {
    title: "代码卡（等宽 + 语法高亮，一键复制）",
    group: 2,
    order: 70,
    onClick: (ctx) => ctx.add("code"),
  },
};
