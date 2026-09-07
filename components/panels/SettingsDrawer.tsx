"use client";

/**
 * 设置抽屉：把「跟这块板无关、但要改」的东西收在一处。
 *
 * 在此之前这些散落各处——语言没有入口，画布三个开关只在画布左上角的工具箱里，
 * 存储在顶栏的小胶囊上，而「这台部署到底开了什么」只能去打接口。三样东西的共同点是
 * **一次设定、长期不动**，跟顶栏其余按钮（对当前这块板做一次）完全是两类，所以单开一处。
 *
 * 这里刻意**不复制状态**：画布三个开关直接读写 store，与工具箱是同一份真源，
 * 改哪边另一边当场跟着变；存储那节只给一句话和一个跳转，真正的切换仍在存储面板里，
 * 那件事有数据归属的后果，不该在设置里被顺手点掉。
 */
import { ICON_MD, ICON_SM, UI } from "@/lib/icons";
import { SNAP_GRID } from "@/lib/constants";
import { useBoardStore } from "@/lib/store";
import { useFeatures } from "@/lib/features-client";
import { useLocale, useT } from "@/lib/i18n/client";
import { LOCALES, LOCALE_LABEL } from "@/lib/i18n";

/** 自描述接口：agent 探这台部署会什么，人也常要点进去看一眼。 */
const SELF_LINKS = ["/api/capabilities", "/api/skill?format=md", "/llms.txt"];

export function SettingsDrawer() {
  const open = useBoardStore((state) => state.drawer === "settings");
  const setDrawer = useBoardStore((state) => state.setDrawer);
  const snapGrid = useBoardStore((state) => state.snapGrid);
  const alignSnap = useBoardStore((state) => state.alignSnap);
  const nodeBar = useBoardStore((state) => state.nodeToolbar);
  const toggleSnapGrid = useBoardStore((state) => state.toggleSnapGrid);
  const toggleAlignSnap = useBoardStore((state) => state.toggleAlignSnap);
  const toggleNodeToolbar = useBoardStore((state) => state.toggleNodeToolbar);
  const features = useFeatures();
  const { locale, setLocale } = useLocale();
  const t = useT();

  const backendKey = features.taskBackend === "goal-agent"
    ? "settings.about.backend.goalAgent"
    : features.taskBackend === "http"
      ? "settings.about.backend.http"
      : "settings.about.backend.local";

  const integrations = [
    features.search ? t("settings.about.search") : null,
    features.library ? t("settings.about.library") : null,
  ].filter(Boolean) as string[];

  const toggles: { key: string; on: boolean; flip: () => void; label: string; desc: string }[] = [
    {
      key: "align",
      on: alignSnap,
      flip: toggleAlignSnap,
      label: t("settings.canvas.align"),
      desc: t("settings.canvas.align.desc"),
    },
    {
      key: "grid",
      on: snapGrid,
      flip: toggleSnapGrid,
      label: t("settings.canvas.grid"),
      desc: t("settings.canvas.grid.desc", { size: SNAP_GRID }),
    },
    {
      key: "nodebar",
      on: nodeBar,
      flip: toggleNodeToolbar,
      label: t("settings.canvas.nodebar"),
      desc: t("settings.canvas.nodebar.desc"),
    },
  ];

  return (
    <div className={`drawer settings-drawer${open ? " open" : ""}`}>
      <div className="drawer-head">
        <span className="cd-type">
          <UI.settings {...ICON_SM} />
        </span>
        <h2>{t("settings.title")}</h2>
        <button className="drawer-close" title={t("common.close")} onClick={() => setDrawer(null)}>
          <UI.close {...ICON_MD} />
        </button>
      </div>
      <div className="drawer-body">
        <section className="set-section">
          <h3>{t("settings.section.language")}</h3>
          <div className="set-lang" role="group" aria-label={t("common.language")}>
            {LOCALES.map((code) => (
              <button
                key={code}
                type="button"
                className={`set-lang-btn${locale === code ? " on" : ""}`}
                data-locale={code}
                aria-pressed={locale === code}
                onClick={() => setLocale(code)}
              >
                {LOCALE_LABEL[code]}
              </button>
            ))}
          </div>
          <p className="set-hint">{t("settings.language.hint")}</p>
        </section>

        <section className="set-section">
          <h3>{t("settings.section.canvas")}</h3>
          <p className="set-hint">{t("settings.canvas.hint")}</p>
          {toggles.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`set-row${item.on ? " on" : ""}`}
              data-toggle={item.key}
              aria-pressed={item.on}
              onClick={item.flip}
            >
              <span className="set-row-main">
                <span className="set-row-label">{item.label}</span>
                <span className="set-row-desc">{item.desc}</span>
              </span>
              <span className="set-switch" aria-hidden />
            </button>
          ))}
        </section>

        <section className="set-section">
          <h3>{t("settings.section.storage")}</h3>
          <p className="set-hint">
            {features.browserStorage ? t("settings.storage.browser") : t("settings.storage.server")}
          </p>
          <button type="button" className="mini-btn" onClick={() => setDrawer("storage")}>
            <UI.detail {...ICON_SM} /> {t("settings.storage.open")}
          </button>
        </section>

        <section className="set-section">
          <h3>{t("settings.section.about")}</h3>
          <dl className="set-facts">
            <dt>{t("settings.about.storage")}</dt>
            <dd>{features.browserStorage ? t("top.storage.browser", { workspace: "" }).trim() : t("top.storage.server")}</dd>
            <dt>{t("settings.about.taskBackend")}</dt>
            <dd>{t(backendKey as Parameters<typeof t>[0])}</dd>
            <dt>{t("settings.about.integrations")}</dt>
            <dd>{integrations.length ? integrations.join(" · ") : t("settings.about.integrations.none")}</dd>
          </dl>
          <p className="set-hint">{t("settings.about.links.hint")}</p>
          <div className="set-links">
            {SELF_LINKS.map((href) => (
              <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="mini-btn">
                <UI.code {...ICON_SM} /> {href}
              </a>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
