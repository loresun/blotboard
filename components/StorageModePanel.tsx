"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { BundleFormatError, parseBoardBundleText } from "@/lib/board-bundle";
import { browserBoards, type BrowserWorkspaceSummary } from "@/lib/browser-board-repository";
import { exportBundle } from "@/lib/export";
import { browserStorageActive, browserWorkspace, normalizeWorkspace, persistStorageChoice, storageUrl } from "@/lib/storage-mode";
import { useBoardStore } from "@/lib/store";
import { tr, useT } from "@/lib/i18n/client";

/**
 * 「从备份恢复」按下去之前，先把这份文件**会改动什么**算清楚。
 *
 * 以前这里是一句 `window.confirm`，而且「取消」并不取消——它只是退回「合并恢复」，
 * 照样按 id 覆盖已有的板。用户问「为什么要替换、替换什么」问得很对：一个只有确定/取消的
 * 弹窗答不了这个问题，它连「取消到底是不取消还是换一种改法」都是含混的。
 * 换成三选一（取消 / 合并恢复 / 整库恢复）+ 一份影响摘要，每一项各自说清自己会动多少块板。
 */
interface RestorePlan {
  /** 文件原文：确认之后才真的走导入，取消就连解析结果一起丢掉 */
  text: string;
  filename: string;
  /** 备份里有多少块板 / 多少个附件带着字节 */
  boards: number;
  assets: number;
  /** 其中多少块会覆盖本机同 id 的板、多少块是新增 */
  overwrites: number;
  additions: number;
  /** 本机有、备份里没有的板（只有「整库恢复」会删掉它们） */
  removals: number;
}

export function StorageModePanel() {
  const t = useT();
  const open = useBoardStore((state) => state.drawer === "storage");
  const [workspace, setWorkspace] = useState(() => browserWorkspace());
  const [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<BrowserWorkspaceSummary[]>([]);
  const [restorePlan, setRestorePlan] = useState<RestorePlan | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const importAs = useRef<HTMLInputElement | null>(null);
  const browser = browserStorageActive();
  useEffect(() => {
    if (!open) return;
    void browserBoards.listWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([]));
  }, [open]);
  if (!open) return null;

  async function switchMode(mode: "server" | "browser", targetWorkspace = workspace) {
    await useBoardStore.getState().flushPendingSave();
    if (mode === "browser") await browserBoards.createWorkspace(targetWorkspace);
    persistStorageChoice(mode, targetWorkspace);
    window.location.assign(storageUrl(mode, targetWorkspace));
  }

  async function revealServerData() {
    setBusy(true);
    try {
      const response = await fetch("/api/storage/reveal", { method: "POST", headers: { "x-board-web": "1" } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || tr("pages.storage.toast.revealFailed", { status: response.status }));
      useBoardStore.getState().showToast(tr("pages.storage.toast.revealed"));
    } catch (error) {
      useBoardStore.getState().showToast((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** 备份整库：两种存储模式同一个出口（服务端直接下文件，浏览器库就地攒一份） */
  async function backup() {
    setBusy(true);
    try {
      const result = await exportBundle({ all: true });
      // 分了卷就得说清楚下了几个文件：少存一个文件 = 少一批板，而那事得当场知道
      useBoardStore
        .getState()
        .showToast(
          result.files > 1
            ? tr("pages.storage.toast.backingUpVolumes", { files: result.files, boards: result.boards })
            : tr("pages.storage.toast.backingUp"),
        );
    } catch (error) {
      useBoardStore.getState().showToast((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 选了文件先**算账不动手**：解析出这份备份里有什么、会覆盖哪几块、会新增哪几块，
   * 摆出来让用户挑。这一步一个字节都不写；写不写、按哪一档，由下面的 runRestore 决定。
   */
  async function planRestore(file: File) {
    setBusy(true);
    try {
      const text = await file.text();
      const { bundle } = parseBoardBundleText(text);
      const existing = browser ? await browserBoards.listBoards() : await api.listBoards();
      const existingIds = new Set(existing.map((board) => board.id));
      const incomingIds = new Set(bundle.boards.map((board) => board.id).filter(Boolean));
      const overwrites = [...incomingIds].filter((id) => existingIds.has(id)).length;
      setRestorePlan({
        text,
        filename: file.name,
        boards: bundle.boards.length,
        assets: (bundle.assets || []).filter((asset) => asset.data).length,
        overwrites,
        additions: bundle.boards.length - overwrites,
        removals: [...existingIds].filter((id) => !incomingIds.has(id)).length,
      });
    } catch (error) {
      const message = error instanceof BundleFormatError ? error.message : (error as Error).message;
      useBoardStore.getState().showToast(tr("pages.storage.toast.restoreFailed", { message }));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 真正动手：merge = 同 id 覆盖、其余留着；replace = 回到备份那一刻，备份里没有的板一并删掉。
   * 「整库恢复」只有浏览器库给（服务端删板有快照兜底，整库推平没有）。
   */
  async function runRestore(plan: RestorePlan, mode: "merge" | "replace") {
    setBusy(true);
    try {
      if (browser) {
        const result = await browserBoards.importBundle(plan.text, mode);
        const note = result.notes.length ? `；${result.notes[0]}` : "";
        useBoardStore
          .getState()
          .showToast(tr("pages.storage.toast.restored", { imported: result.imported, total: result.total }) + note);
      } else {
        const result = await useBoardStore.getState().importBoardsText(plan.text, "restore");
        const note = result.notes.length ? `；${result.notes[0]}` : "";
        useBoardStore.getState().showToast(tr("pages.storage.toast.restoredServer", { imported: result.imported }) + note);
      }
      setRestorePlan(null);
      window.location.reload();
    } catch (error) {
      useBoardStore.getState().showToast(tr("pages.storage.toast.restoreFailed", { message: (error as Error).message }));
      setBusy(false);
    }
  }

  /** 导入别人发来的文件：一律当新画板收下，绝不动已有的板 */
  async function importAsNew(file: File) {
    setBusy(true);
    try {
      const result = await useBoardStore.getState().importBoardsFile(file, "copy");
      useBoardStore
        .getState()
        .showToast(tr("pages.storage.toast.imported", { count: result.imported, note: result.notes.length ? `；${result.notes[0]}` : "" }));
    } catch (error) {
      useBoardStore.getState().showToast(tr("pages.storage.toast.importFailed", { message: (error as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="storage-shade" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) useBoardStore.getState().setDrawer(null);
    }}>
      <section className="storage-panel" role="dialog" aria-modal="true" aria-label={t("pages.storage.title")}>
        <header>
          <div>
            <h2>{t("pages.storage.title")}</h2>
            <p>{t("pages.storage.subtitle")}</p>
          </div>
          <button className="drawer-close" onClick={() => useBoardStore.getState().setDrawer(null)} aria-label={t("common.close")}>×</button>
        </header>

        <div className="storage-options">
          <button className={!browser ? "selected" : ""} onClick={() => void switchMode("server")}>
            <strong>
              {t("pages.storage.server")}
              <em className="storage-recommended" title={t("pages.storage.recommended.title")}>{t("pages.storage.recommended")}</em>
            </strong>
            <span>{t("pages.storage.server.desc")}</span>
          </button>
          <button className={browser ? "selected" : ""} onClick={() => void switchMode("browser")}>
            <strong>{t("pages.storage.browser")}</strong>
            <span>{t("pages.storage.browser.desc")}</span>
          </button>
        </div>

        <label className="storage-workspace">
          <span>{t("pages.storage.workspace")}</span>
          <input value={workspace} onChange={(event) => setWorkspace(normalizeWorkspace(event.target.value))} maxLength={48} />
          <small>{t("pages.storage.workspace.hint")}</small>
        </label>

        {browser ? (
          <>
            {workspaces.length ? <div className="storage-workspace-list">
              <span>{t("pages.storage.workspace.existing")}</span>
              <div>{workspaces.map((item) => <button key={item.name} className={item.name === browserWorkspace() ? "active" : ""} onClick={() => {
                setWorkspace(item.name);
                void switchMode("browser", item.name);
              }}>
                <strong>{item.name}</strong><small>{t("pages.storage.workspace.boards", { count: item.boards })}</small>
              </button>)}</div>
            </div> : null}
            <div className="storage-warning">{t("pages.storage.warning")}</div>
          </>
        ) : <div className="storage-server-location">
          <strong>{t("pages.storage.location.title")}</strong>
          <p>{t("pages.storage.location.before")}<code>{t("pages.storage.location.dir")}</code>{t("pages.storage.location.after")}</p>
          <button disabled={busy} onClick={() => void revealServerData()}>{t("pages.storage.location.reveal")}</button>
        </div>}

        {/* 备份与迁移：两种存储模式同一套口径 —— 产物是同一种画板包，可以互相导 */}
        <div className="storage-transfer">
          <strong>{t("pages.storage.transfer.title")}</strong>
          <p>
            {t("pages.storage.transfer.before")}<b>{t("pages.storage.transfer.em")}</b>{t("pages.storage.transfer.after")}
          </p>
          <div className="storage-actions">
            <button disabled={busy} onClick={() => void backup()}>
              {browser ? t("pages.storage.transfer.backupBrowser") : t("pages.storage.transfer.backupServer")}
            </button>
            <button disabled={busy} onClick={() => importAs.current?.click()}>{t("pages.storage.transfer.import")}</button>
            <button disabled={busy} onClick={() => input.current?.click()}>{t("pages.storage.transfer.restore")}</button>
          </div>
          <small>{t("pages.storage.transfer.note")}</small>
          <input ref={input} className="storage-restore-input" type="file" accept=".json,.html,application/json,text/html" hidden onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) await planRestore(file);
          }} />
          <input ref={importAs} className="storage-import-input" type="file" accept=".json,.html,application/json,text/html" hidden onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) await importAsNew(file);
          }} />
        </div>

        {restorePlan ? (
          /* 恢复确认：三个出口各自写清自己会动多少块板。**「取消」就是取消**，一个字节都不写 */
          <div className="storage-restore-confirm" role="group" aria-label={t("pages.storage.restore.title")}>
            <strong>{t("pages.storage.restore.title")}</strong>
            <p className="storage-restore-file">{restorePlan.filename}</p>
            <ul className="storage-restore-summary">
              <li>{t("pages.storage.restore.summary.contains", { boards: restorePlan.boards, assets: restorePlan.assets })}</li>
              <li>{t("pages.storage.restore.summary.overwrite", { count: restorePlan.overwrites })}</li>
              <li>{t("pages.storage.restore.summary.add", { count: restorePlan.additions })}</li>
              {browser ? <li>{t("pages.storage.restore.summary.keepOrDrop", { count: restorePlan.removals })}</li> : null}
            </ul>
            <div className="storage-actions">
              <button disabled={busy} className="storage-restore-cancel" onClick={() => setRestorePlan(null)}>
                {t("pages.storage.restore.cancel")}
              </button>
              <button disabled={busy} className="storage-restore-merge" onClick={() => void runRestore(restorePlan, "merge")}>
                {t("pages.storage.restore.merge")}
              </button>
              {browser ? (
                <button disabled={busy} className="storage-restore-replace danger" onClick={() => void runRestore(restorePlan, "replace")}>
                  {t("pages.storage.restore.replace")}
                </button>
              ) : null}
            </div>
            <small>{browser ? t("pages.storage.restore.hint") : t("pages.storage.restore.hintServer")}</small>
          </div>
        ) : null}

        <div className="storage-agent-note">
          <strong>{t("pages.storage.agent.title")}</strong>
          {browser ? <>
            <p>{t("pages.storage.agent.before")}<code>window.blotboardBrowser</code>{t("pages.storage.agent.after")}</p>
            <p className="storage-agent-caveat">{t("pages.storage.agent.browser.caveat")}</p>
          </> : (
            <p>{t("pages.storage.agent.server.before")}<code>/api/skill</code>{t("pages.storage.agent.server.after")}</p>
          )}
        </div>
      </section>
    </div>
  );
}
