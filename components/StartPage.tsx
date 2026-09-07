"use client";

import { useEffect, useMemo, useState } from "react";
import { SiteNav } from "./SiteNav";
import { browserBoards, type BrowserWorkspaceSummary } from "@/lib/browser-board-repository";
import { browserAgentPrompt, serverAgentPrompt } from "@/lib/agent-onboarding";
import { copyText } from "@/lib/copy-text";
import { normalizeWorkspace } from "@/lib/storage-mode";
import { useT } from "@/lib/i18n/client";
import styles from "./StartPage.module.css";

type CopyKind = "server" | "browser" | null;

export function StartPage() {
  const t = useT();
  const [origin, setOrigin] = useState("");
  const [workspaces, setWorkspaces] = useState<BrowserWorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState("default");
  const [draft, setDraft] = useState("");
  const [copyKind, setCopyKind] = useState<CopyKind>(null);
  const [message, setMessage] = useState("");

  async function refreshWorkspaces() {
    const items = await browserBoards.listWorkspaces().catch(() => []);
    setWorkspaces(items);
    return items;
  }

  useEffect(() => {
    setOrigin(window.location.origin);
    const saved = normalizeWorkspace(window.localStorage.getItem("blotboard.storage.workspace"));
    setWorkspace(saved);
    void refreshWorkspaces();
  }, []);

  const browserHref = `/?storage=browser&workspace=${encodeURIComponent(workspace)}`;
  const browserPrompt = useMemo(() => origin ? browserAgentPrompt(origin, workspace) : "", [origin, workspace]);
  const serverPrompt = useMemo(() => origin ? serverAgentPrompt(origin) : "", [origin]);

  async function copy(kind: Exclude<CopyKind, null>, text: string) {
    const ok = await copyText(text);
    setCopyKind(kind);
    setMessage(ok ? t("pages.start.toast.copied") : t("pages.start.toast.copyFailed"));
  }

  async function addWorkspace() {
    const name = normalizeWorkspace(draft);
    const created = await browserBoards.createWorkspace(name);
    setWorkspace(created.name);
    setDraft("");
    await refreshWorkspaces();
  }

  async function revealDataDir() {
    setCopyKind(null);
    const response = await fetch("/api/storage/reveal", { method: "POST", headers: { "x-board-web": "1" } });
    const data = await response.json().catch(() => ({}));
    setMessage(response.ok && data.ok !== false ? t("pages.start.toast.revealed") : data.error || t("pages.start.toast.revealFailed"));
  }

  return <div className={styles.page}>
    <header className={`topbar ${styles.topbar}`}>
      <span className="brand">{t("top.brand")}</span>
      <SiteNav current="start" />
      <span className={styles.headerNote}>{t("pages.start.headerNote")}</span>
    </header>

    <main className={styles.main}>
      <section className={styles.hero}>
        <p className={styles.kicker}>BLOTBOARD / LOCAL-FIRST BY CHOICE</p>
        <h1>{t("pages.start.heroTitle")}<br /><em>{t("pages.start.heroTitleEm")}</em></h1>
        <p className={styles.lead}>{t("pages.start.lead")}</p>
        <div className={styles.rule}><span>{t("pages.start.step1")}</span><span>{t("pages.start.step2")}</span><span>{t("pages.start.step3")}</span></div>
      </section>

      <section className={styles.worlds} aria-label={t("pages.start.worldsAria")}>
        <article className={`${styles.world} ${styles.server}`}>
          <div className={styles.worldNumber}>A</div>
          <div className={styles.worldHead}>
            <p>SERVER FILES</p>
            <h2>
              {t("pages.start.server.title")}
              <em className={styles.recommended} title={t("pages.storage.recommended.title")}>{t("pages.storage.recommended")}</em>
            </h2>
            <span>{t("pages.start.server.tags")}</span>
          </div>
          <p className={styles.worldText}>{t("pages.start.server.text")}</p>
          <ul>
            <li>{t("pages.start.server.point1")}</li>
            <li>{t("pages.start.server.point2")}</li>
            <li>{t("pages.start.server.point3")}</li>
          </ul>
          <div className={styles.actions}>
            <a className={styles.primary} href="/?storage=server">{t("pages.start.server.enter")}</a>
            <button onClick={() => void copy("server", serverPrompt)}>{t("pages.start.server.copyPrompt")}</button>
          </div>
          <button className={styles.pathLink} onClick={() => void revealDataDir()}>{t("pages.start.server.reveal")}</button>
        </article>

        <article className={`${styles.world} ${styles.browser}`}>
          <div className={styles.worldNumber}>B</div>
          <div className={styles.worldHead}>
            <p>BROWSER VAULT</p><h2>{t("pages.start.browser.title")}</h2>
            <span>{t("pages.start.browser.tags")}</span>
          </div>
          <p className={styles.worldText}>{t("pages.start.browser.text")}</p>

          <div className={styles.workspaceBox}>
            <div className={styles.workspaceLabel}><span>{t("pages.start.browser.pick")}</span><strong>{workspace}</strong></div>
            <div className={styles.workspaceList}>
              {workspaces.length ? workspaces.map((item) => <button key={item.name} className={item.name === workspace ? styles.active : ""} onClick={() => setWorkspace(item.name)}>
                <span>{item.name}</span><small>{t("pages.start.browser.boards", { count: item.boards })}</small>
              </button>) : <p>{t("pages.start.browser.empty")}</p>}
            </div>
            <div className={styles.newWorkspace}>
              <input aria-label={t("pages.start.browser.nameAria")} value={draft} placeholder={t("pages.start.browser.namePlaceholder")} onChange={(event) => setDraft(event.target.value)} />
              <button disabled={!draft.trim()} onClick={() => void addWorkspace()}>{t("common.new")}</button>
            </div>
          </div>

          <ul>
            <li>{t("pages.start.browser.point1")}</li>
            <li>{t("pages.start.browser.point2")}</li>
            <li>{t("pages.start.browser.point3")}</li>
          </ul>
          <div className={styles.actions}>
            <a className={styles.primary} href={browserHref}>{t("pages.start.browser.enter", { workspace })}</a>
            <button onClick={() => void copy("browser", browserPrompt)}>{t("pages.start.browser.copyPrompt")}</button>
          </div>
        </article>
      </section>

      <section className={styles.handoff}>
        <div><span>{t("pages.start.handoff.cap")}</span><h2>{t("pages.start.handoff.title")}</h2></div>
        <div className={styles.handoffGrid}>
          <p><b>{t("pages.start.handoff.serverLabel")}</b>{t("pages.start.handoff.serverText")}</p>
          <p><b>{t("pages.start.handoff.browserLabel")}</b>{t("pages.start.handoff.browserText")}</p>
        </div>
      </section>
    </main>

    {message ? <div className={styles.toast} role="status" onClick={() => setMessage("")}>{copyKind ? `${copyKind === "browser" ? "CDP" : t("pages.start.toast.serverTag")} · ` : ""}{message}</div> : null}
  </div>;
}
