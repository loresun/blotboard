"use client";

/** 网页嵌入卡的前端槽位（沙箱 iframe 卡面 + 白名单预判的编辑器）。 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { hostAllowed, type EmbedRule } from "@/lib/embed-allow";
import { UI } from "@/lib/icons";
import { HtmlCard, HtmlEmbed } from "@/components/cards/HtmlCard";
import { tr, useT } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";
import type { HtmlEmbedMode } from "@/lib/types";

/** 网页卡的逻辑视口预设：PPT 基本都是 16:9，别让用户每次手敲两个数字 */
const FRAME_PRESETS: [number, number, DictKey][] = [
  [0, 0, "cards.html.frame.fill"],
  [1280, 720, "cards.html.frame.720p"],
  [960, 540, "cards.html.frame.540p"],
  [1920, 1080, "cards.html.frame.1080p"],
  [1024, 768, "cards.html.frame.xga"],
];

/**
 * 嵌入白名单：整个页面只拉一次，缓存在模块里。
 * 拉它是为了在输入框旁边当场说「这个地址嵌不了」——判断权仍在服务端（写入时还会再判一次），
 * 拉失败就不预判，让用户照常保存、由服务端回那句报错。
 */
let allowRulesPromise: Promise<EmbedRule[] | null> | null = null;
function loadAllowRules(): Promise<EmbedRule[] | null> {
  if (!allowRulesPromise) {
    allowRulesPromise = api
      .embedAllow()
      .then((data) => data.rules)
      .catch(() => null);
  }
  return allowRulesPromise;
}

/**
 * 这个地址现在能不能嵌。返回 null = 还判断不了（规则没拉到 / 地址还没填完），不打扰用户。
 * 判断出「不能嵌」时，自动保存会跳过这次——否则边打字边保存，
 * 「http://12」这种半截地址会连着弹好几个 400。
 */
function hostError(htmlUrl: string, allowRules: EmbedRule[] | null): string | null {
  const value = htmlUrl.trim();
  if (!value) return null;
  if (!/^https?:\/\/[^\s]{3,}$/i.test(value)) return tr("cards.html.badUrl");
  let host = "";
  try {
    host = new URL(value).host;
  } catch {
    return tr("cards.html.badUrl");
  }
  if (!allowRules) return null;
  return hostAllowed(host, allowRules) ? null : tr("cards.html.hostNotAllowed", { host });
}

function Fields({ draft, patch, setBlocked }: EditorFieldsProps) {
  const t = useT();
  const [allowRules, setAllowRules] = useState<EmbedRule[] | null>(null);
  const htmlUrl = draft.htmlUrl as string;
  const htmlMode = draft.htmlMode as HtmlEmbedMode;
  const htmlFrameW = draft.htmlFrameW as number;
  const htmlFrameH = draft.htmlFrameH as number;

  useEffect(() => {
    let alive = true;
    void loadAllowRules().then((rules) => {
      if (alive) setAllowRules(rules);
    });
    return () => {
      alive = false;
    };
  }, []);

  const htmlHostError = hostError(htmlUrl, allowRules);
  useEffect(() => {
    setBlocked(htmlHostError);
    return () => setBlocked(null);
  }, [htmlHostError, setBlocked]);

  return (
    <>
      <span className="hint">
        {t("cards.html.allowHintBefore")} <code>BLOTBOARD_HTML_ALLOW</code>{t("cards.html.allowHintAfter")}
      </span>
      <input
        type="text"
        data-field="html.url"
        placeholder="http://localhost:8000/slides/index.html"
        value={htmlUrl}
        onChange={(event) => patch({ htmlUrl: event.target.value })}
      />
      {htmlHostError ? <span className="hint danger">{htmlHostError}</span> : null}
      <div className="row">
        <span className="hint">{t("cards.html.frameLabel")}</span>
        <select
          data-field="html.frame"
          value={FRAME_PRESETS.some(([w, h]) => w === htmlFrameW && h === htmlFrameH) ? `${htmlFrameW}x${htmlFrameH}` : "custom"}
          onChange={(event) => {
            if (event.target.value === "custom") return;
            const [w, h] = event.target.value.split("x").map(Number);
            patch({ htmlFrameW: w, htmlFrameH: h });
          }}
        >
          {FRAME_PRESETS.map(([w, h, labelKey]) => (
            <option key={`${w}x${h}`} value={`${w}x${h}`}>
              {t(labelKey)}
            </option>
          ))}
          <option value="custom">{t("cards.html.frameCustom")}</option>
        </select>
      </div>
      {FRAME_PRESETS.some(([w, h]) => w === htmlFrameW && h === htmlFrameH) ? null : (
        <div className="row">
          <span className="hint">{t("cards.html.frameSize")}</span>
          <input
            type="number"
            className="num"
            min={100}
            max={4000}
            value={htmlFrameW}
            onChange={(event) => patch({ htmlFrameW: Number(event.target.value) || 0 })}
          />
          <input
            type="number"
            className="num"
            min={100}
            max={4000}
            value={htmlFrameH}
            onChange={(event) => patch({ htmlFrameH: Number(event.target.value) || 0 })}
          />
        </div>
      )}
      <div className="row">
        <span className="hint">{t("cards.html.modeLabel")}</span>
        <select
          data-field="html.mode"
          value={htmlMode}
          onChange={(event) => patch({ htmlMode: event.target.value as HtmlEmbedMode })}
        >
          <option value="auto">{t("cards.html.modeAuto")}</option>
          <option value="manual">{t("cards.html.modeManual")}</option>
        </select>
      </div>
      <span className="hint">
        {t("cards.html.readerHintBefore")} <UI.fit size={12} strokeWidth={2} /> {t("cards.html.readerHintAfter")}
      </span>
    </>
  );
}

export const ui: CardPackUi = {
  // 嵌入的外部页面：进可视区才挂 iframe，鼠标默认还给画布（细节见 HtmlCard.tsx）
  CardFace({ card }) {
    return <HtmlCard html={card.html} title={card.title} />;
  },
  FullView({ card }) {
    const t = useT();
    // 阅读模式是「把这页 PPT 摊开翻」的场合：一进来鼠标就能点。
    // 键盘先归阅读模式（←/→ 翻卡），按头上的「键盘」开关才交给这张页面——
    // 焦点一旦掉进 iframe 就再也回不来，所以这件事得是明着的（见 components/panels/ReaderModal.tsx）
    return card.html?.url ? (
      <div className="reader-embed">
        <HtmlEmbed html={card.html} title={card.title} variant="reader" />
      </div>
    ) : (
      <span className="placeholder">{t("cards.html.readerEmpty")}</span>
    );
  },
  editor: {
    draftFrom(card) {
      return {
        htmlUrl: card.html?.url || "",
        htmlMode: card.html?.mode || "auto",
        htmlFrameW: card.html?.frameW ?? 1280,
        htmlFrameH: card.html?.frameH ?? 720,
      };
    },
    buildPatch(_card, draft) {
      return {
        html: { url: draft.htmlUrl.trim(), mode: draft.htmlMode, frameW: draft.htmlFrameW, frameH: draft.htmlFrameH },
      };
    },
    Fields,
  },
  toolbar: {
    title: "网页卡：把外部 PPT / 网页嵌进画板（沙箱 iframe，只能嵌白名单里的地址）",
    group: 3,
    order: 40,
    onClick: (ctx) => ctx.add("html"),
  },
};
