"use client";

import { useEffect, useState } from "react";
import { SiteNav } from "./SiteNav";
import { agentLinks, boardAgentPrompt, browserAgentPrompt, skillInstallCommand, skillInstallPrompt } from "@/lib/agent-onboarding";
import { copyText } from "@/lib/copy-text";
import { browserWorkspace, storageMode } from "@/lib/storage-mode";
import { useT } from "@/lib/i18n/client";
import styles from "./AgentOnboarding.module.css";

function CopyBlock({ label, text, rows = 6 }: { label: string; text: string; rows?: number }) {
  const t = useT();
  const [status, setStatus] = useState("");
  return <div className={styles.copyBlock}>
    <textarea aria-label={label} value={text} readOnly rows={rows} onFocus={(event) => event.currentTarget.select()} />
    <div className={styles.copyActions}>
      <button type="button" onClick={async () => setStatus(await copyText(text) ? t("common.copied") : t("pages.agent.copyFailed"))}>{label}</button>
      <span role="status">{status}</span>
    </div>
  </div>;
}

export function AgentOnboarding() {
  const t = useT();
  const [origin, setOrigin] = useState("");
  const [boardId, setBoardId] = useState("");
  const [client, setClient] = useState<'codex' | 'claude'>('codex');
  const [mode, setMode] = useState<'server' | 'browser'>('server');
  const [workspace, setWorkspace] = useState('default');
  useEffect(() => {
    setOrigin(window.location.origin);
    setBoardId(new URL(window.location.href).searchParams.get('board') || '');
    setMode(storageMode());
    setWorkspace(browserWorkspace());
  }, []);
  const links = origin ? agentLinks(origin, boardId) : null;
  const browser = mode === 'browser';
  const browserTarget = origin ? `${origin}/?storage=browser&workspace=${encodeURIComponent(workspace)}${boardId ? `&board=${encodeURIComponent(boardId)}` : ''}` : '';
  return <div className={styles.app}>
    <header className={`topbar ${styles.topbar}`}><span className="brand">{t("top.brand")}</span><SiteNav current="agent" boardId={boardId} /></header>
    <main className={styles.main}>
      <div className={styles.intro}>
        <p className={styles.eyebrow}>{browser ? 'BLOTBOARD × BROWSER CDP' : 'BLOTBOARD × SERVER AGENT'}</p>
        <h1>{browser ? t("pages.agent.browser.title") : t("pages.agent.server.title")}</h1>
        <p>{browser ? t("pages.agent.browser.lead") : t("pages.agent.server.lead")}</p>
        {origin && <p className={styles.address}>{browser ? <>{t("pages.agent.browser.workspace")}<code>{workspace}</code></> : <>{t("pages.agent.server.origin")}<code>{origin}</code></>}</p>}
      </div>
      {links && <>
        {browser ? <>
          <section className={`${styles.section} ${styles.browserSection}`}>
            <h2>{t("pages.agent.browser.step1")}</h2>
            <p>{t("pages.agent.browser.step1.text", { board: boardId ? t("pages.agent.browser.step1.board") : "" })}</p>
            <p>{t("pages.agent.browser.target")}<a href={browserTarget}>{browserTarget}</a></p>
            <CopyBlock label={t("pages.agent.browser.copy")} text={browserAgentPrompt(origin, workspace, boardId || undefined)} rows={16} />
          </section>
          <section className={styles.section}>
            <h2>{t("pages.agent.browser.step2")}</h2>
            <ol className={styles.steps}>
              <li>{t("pages.agent.browser.step2.a")}</li>
              <li>{t("pages.agent.browser.step2.b1")}<code>window.blotboardBrowser</code>{t("pages.agent.browser.step2.b2")}</li>
              <li>{t("pages.agent.browser.step2.c1")}<code>putBoard</code>{t("pages.agent.browser.step2.c2")}</li>
            </ol>
            <p>{t("pages.agent.browser.step2.note")}</p>
          </section>
          <section className={styles.section}>
            <h2>{t("pages.agent.browser.ws")}</h2>
            <p>{t("pages.agent.browser.ws.a")}<code>listWorkspaces()</code>{t("pages.agent.browser.ws.b")}<code>createWorkspace(name)</code>{t("pages.agent.browser.ws.c")}<code>exportBundle()</code>{t("pages.agent.browser.ws.d")}</p>
            <p className={styles.links}><a href="/start">{t("pages.agent.browser.ws.manage")}</a><a href="/docs?doc=browser-storage">{t("pages.agent.browser.ws.help")}</a></p>
          </section>
        </> : <>
        <section className={styles.section}>
          <h2>{t("pages.agent.server.step1")}</h2>
          <p>{t("pages.agent.server.step1.text")}</p>
          {boardId ? <>
            <p>{t("pages.agent.server.current")}<a href={links.board}>{boardId}</a></p>
            <CopyBlock label={t("pages.agent.server.copyBoard")} text={boardAgentPrompt(origin, boardId)} />
          </> : <p><a href="/">{t("pages.agent.server.noBoard1")}</a>{t("pages.agent.server.noBoard2")}</p>}
        </section>
        <section className={styles.section}>
          <h2>{t("pages.agent.server.step2")}</h2>
          <p>{t("pages.agent.server.step2.text")}</p>
          <CopyBlock label={t("pages.agent.server.copySkill")} text={skillInstallPrompt(origin)} />
          <details className={styles.details}>
            <summary>{t("pages.agent.server.manual")}</summary>
            <p>{t("pages.agent.server.manual.text")}</p>
            <label className={styles.select}>{t("pages.agent.server.client")}<select aria-label={t("pages.agent.server.clientAria")} value={client} onChange={(event) => setClient(event.target.value as 'codex' | 'claude')}>
              <option value="codex">Codex · ~/.agents/skills</option>
              <option value="claude">Claude Code · ~/.claude/skills</option>
            </select></label>
            <CopyBlock key={client} label={t("pages.agent.server.copyCommand")} text={skillInstallCommand(origin, client)} rows={10} />
          </details>
          <p className={styles.links}><a href={links.install} download="SKILL.md">{t("pages.agent.server.download")}</a><a href={links.quickstart} target="_blank" rel="noreferrer">{t("pages.agent.server.quickstart")}</a><a href={links.skill} target="_blank" rel="noreferrer">{t("pages.agent.server.fullGuide")}</a><a href={links.capabilities} target="_blank" rel="noreferrer">{t("pages.agent.server.capabilities")}</a></p>
        </section>
        <section className={styles.section}>
          <h2>{t("pages.agent.server.access")}</h2>
          <p>{t("pages.agent.server.access.text1")}</p>
          <p>{t("pages.agent.server.access.text2")}</p>
        </section>
        <section className={styles.section}>
          <h2>{t("pages.agent.server.mcp")}</h2>
          <p>{t("pages.agent.server.mcp.a")}<code>npm link</code>{t("pages.agent.server.mcp.b")}<code>blotboard mcp</code>{t("pages.agent.server.mcp.c")}<code>BLOTBOARD_URL</code>{t("pages.agent.server.mcp.d")}<a href="/docs?doc=agent">{t("pages.agent.server.mcp.link")}</a>{t("pages.agent.server.mcp.end")}</p>
          <p>{t("pages.agent.server.mcp.text2")}</p>
        </section>
        </>}
      </>}
    </main>
  </div>;
}
