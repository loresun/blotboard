"use client";

/**
 * 任务抽屉：任务卡的「进展 + 产出」。
 *
 * 原来是右下角一个浮层，跟其它面板都不在一处，视觉上散；现在跟卡片编辑、Agent 指令
 * 共用右侧抽屉这一个位置。
 *
 * 这里也是「任务 → 结果」回到画板的那一步：Goal Agent 登记的产出列在下面，
 * 一键就能变成画板上的一张卡，并自动从任务卡连一条 produces 边。
 * 产出的真源仍在 Goal Agent，画板只存一份可读的快照。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { ISSUE_STATUS_LABEL, RUNNER_STATUS_LABEL, formatTime } from "@/lib/constants";
import { ICON_MD, ICON_SM, UI, typeIcon } from "@/lib/icons";
import { useCardLabel, useT, tr } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import { useFeatures } from "@/lib/features-client";
import { goalAgentOrigin } from "@/lib/origins";
import { relatedOf, useBoardStore } from "@/lib/store";
import type { BoardCard } from "@/lib/types";

interface LiveTask {
  status: string;
  summary: string;
  updatedAt: number | null;
  /** local 后端专属：发起任务时生成的完整 prompt（「复制 prompt」用） */
  prompt?: string;
}

interface Artifact {
  id: string;
  name?: string;
  kind?: string;
  location?: string;
  description?: string;
  status?: string;
  createdAt?: number;
}

export function TaskDrawer() {
  const open = useBoardStore((state) => state.drawer === "task");
  const cardId = useBoardStore((state) => state.taskCardId);
  const card = useBoardStore((state) =>
    cardId ? state.board?.cards.find((item) => item.id === cardId) || null : null,
  );

  const t = useT();
  const typeLabel = useCardLabel();
  const [live, setLive] = useState<LiveTask | null>(null);
  const [issue, setIssue] = useState<any>(null);
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [seq, setSeq] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const taskId = card?.task?.taskId || null;
  const issueId = card?.task?.issueId || null;
  // local 后端：Issue 与 run 都在本地，抽屉里补「复制 prompt / 打开任务台」两个口
  const local = useFeatures().taskBackend === "local";

  const reload = useCallback(() => setSeq((value) => value + 1), []);

  useEffect(() => {
    if (!open || !card) return;
    let cancelled = false;
    setError(null);
    setLive(null);
    setArtifacts(null);
    setIssue(null);

    if (issueId) {
      api
        .runnerIssue(issueId)
        .then((payload) => !cancelled && setIssue(payload.issue || payload))
        .catch(() => undefined);
    }
    if (taskId) {
      api
        .runnerTask(taskId)
        .then((payload) => {
          if (cancelled) return;
          const task = payload.task || payload;
          setLive({
            status: task.status || "unknown",
            summary: task.summary || "",
            updatedAt: task.updatedAt || null,
            prompt: typeof task.prompt === "string" ? task.prompt : undefined,
          });
        })
        .catch((err: Error) => !cancelled && setError(err.message));
      api
        .taskArtifacts(taskId)
        .then((payload) => !cancelled && setArtifacts(payload.artifacts || payload.items || []))
        .catch(() => !cancelled && setArtifacts([]));
    }
    return () => {
      cancelled = true;
    };
  }, [open, card, taskId, issueId, seq]);

  /**
   * 手动把卡片正文推给 Goal Agent。
   *
   * 平时不用点：编辑保存后服务端会自动推一次（画板设置里可以关）。
   * 这颗按钮是给「刚才 Runner 不通推失败了」「画板设置关了自动同步」这两种情况的，
   * 所以是 force —— 点了就真发一次，不看指纹。
   */
  async function pushIssue() {
    const state = useBoardStore.getState();
    if (!card || !state.boardId) return;
    setSyncing(true);
    try {
      const result = await api.syncCardIssue(state.boardId, card.id, true);
      state.absorbCard(result.card, result);
      state.showToast(tr(local ? "panels.task.pushed.local" : "panels.task.pushed.remote"));
      reload();
    } catch (err) {
      state.showToast((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function saveLabels(next: string[]) {
    if (!issueId) return;
    setBusy(true);
    try {
      const payload = await api.patchRunnerIssue(issueId, { labels: next });
      setIssue(payload.issue || payload);
    } catch (err) {
      useBoardStore.getState().showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** 产出 → 画板卡片：url/飞书文档变链接卡，文本类抓一段预览变文本卡，并连上 produces */
  async function toCard(artifact: Artifact) {
    const state = useBoardStore.getState();
    if (!card) return;
    setBusy(true);
    try {
      const isLink = artifact.kind === "url" || artifact.kind === "feishu_doc" || /^https?:\/\//i.test(artifact.location || "");
      let created: BoardCard;
      if (isLink) {
        created = await state.createCard({
          type: "link",
          title: artifact.name || "任务产出",
          content: artifact.description || "",
          color: "green",
          link: { url: artifact.location },
          x: card.x + (card.w || 320) + 120,
          y: card.y,
        });
      } else {
        let body = artifact.description || "";
        try {
          const preview = await api.artifactPreview(artifact.id);
          body = String(preview.text || preview.preview?.text || body || "");
        } catch {
          /* 预览拿不到就只留路径，卡片仍然建出来 */
        }
        created = await state.createCard({
          type: "text",
          title: artifact.name || "任务产出",
          content: [body, artifact.location ? `\n\n路径：${artifact.location}` : ""].filter(Boolean).join(""),
          color: "green",
          x: card.x + (card.w || 320) + 120,
          y: card.y,
        });
      }
      await state.addEdge(card.id, created.id, "产出");
      await state.patchEdgeStyle(
        (useBoardStore.getState().board?.edges || []).find((edge) => edge.from === card.id && edge.to === created.id)?.id || "",
        { kind: "produces" },
      ).catch(() => undefined);
      state.showToast(tr("panels.task.artifactToCard", { name: created.title || created.id }));
    } catch (err) {
      state.showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const related = card ? relatedOf(card.id) : { up: [], down: [] };

  return (
    <div className={`drawer task-drawer${open ? " open" : ""}`}>
      <div className="drawer-head">
        <UI.detail {...ICON_MD} />
        <h2>{card?.title || t("panels.task.untitled")}</h2>
        <span className="foot-spacer" />
        <button className="drawer-close" title={t("panels.refresh")} onClick={reload}>
          <UI.refresh {...ICON_MD} />
        </button>
        <button className="drawer-close" title={t("common.close")} onClick={() => useBoardStore.getState().openTaskDetail(null)}>
          <UI.close {...ICON_MD} />
        </button>
      </div>
      <div className="drawer-body">
        {!card ? (
          <div className="config-hint">{t("panels.task.empty")}</div>
        ) : (
          <>
            <section className="td-block">
              <div className="td-label">Issue</div>
              {issue ? (
                <>
                  <div className="td-issue">
                    <span className="meta-chip mono">{issue.identifier || issue.number || issueId}</span>
                    <span className="meta-chip">{ISSUE_STATUS_LABEL[issue.status] ? t(ISSUE_STATUS_LABEL[issue.status]) : issue.status}</span>
                    {/* 只配了 Runner、没配主界面地址（GOAL_AGENT_WEB_URL）时没有可跳的页面 */}
                    {goalAgentOrigin() ? (
                      <a
                        href={`${goalAgentOrigin()}/?issue=${encodeURIComponent(issue.id || issueId || "")}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mini-btn"
                      >
                        <UI.external {...ICON_SM} /> {t("panels.task.openInAgent")}
                      </a>
                    ) : null}
                    {local ? (
                      <a
                        href={`/tasks?issue=${encodeURIComponent(issue.id || issueId || "")}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mini-btn"
                      >
                        <UI.external {...ICON_SM} /> {t("panels.task.openInTasks")}
                      </a>
                    ) : null}
                  </div>
                  <div className="td-issue">
                    {card.task?.issueSyncError ? (
                      <span className="meta-chip bad" title={card.task.issueSyncError}>
                        {t("panels.task.syncError", { message: card.task.issueSyncError })}
                      </span>
                    ) : card.task?.issueSyncedAt ? (
                      <span className="meta-chip ok">
                        {t("panels.task.synced", { time: formatTime(card.task.issueSyncedAt) })}
                      </span>
                    ) : (
                      <span className="meta-chip">{t("panels.task.neverSynced")}</span>
                    )}
                    <button className="mini-btn" disabled={syncing} onClick={() => void pushIssue()}>
                      <UI.refresh {...ICON_SM} /> {syncing ? t("panels.task.syncing") : t("panels.task.sync")}
                    </button>
                  </div>
                  <div className="td-label">{t(local ? "panels.task.labels.local" : "panels.task.labels.remote")}</div>
                  <div className="td-labels">
                    {(issue.labels || []).map((label: string) => (
                      <span key={label} className="issue-label">
                        {label}
                        <button
                          title={t("panels.task.labelRemove")}
                          disabled={busy}
                          onClick={() => void saveLabels((issue.labels || []).filter((item: string) => item !== label))}
                        >
                          <UI.close size={10} strokeWidth={2.4} />
                        </button>
                      </span>
                    ))}
                    <input
                      className="issue-label-add"
                      placeholder={t("panels.task.labelAdd")}
                      maxLength={32}
                      value={labelDraft}
                      onChange={(event) => setLabelDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        const text = labelDraft.trim();
                        if (!text) return;
                        setLabelDraft("");
                        void saveLabels([...new Set([...(issue.labels || []), text])]);
                      }}
                    />
                  </div>
                </>
              ) : (
                <div className="config-hint">{t(issueId ? "panels.task.issueLoading" : "panels.task.noIssue")}</div>
              )}
            </section>

            <section className="td-block">
              <div className="td-label">{t("panels.task.progress")}</div>
              {!taskId ? (
                <div className="config-hint">
                  {t(local ? "panels.task.noRun.local" : "panels.task.noRun.remote")}
                </div>
              ) : error ? (
                <div className="config-hint">{t("panels.task.queryFailed", { message: error })}</div>
              ) : !live ? (
                <div className="config-hint">{t("panels.task.querying")}</div>
              ) : (
                <>
                  <div className="td-issue">
                    <span className={`status-chip st-${live.status === "completed" ? "done" : "running"}`}>
                      {RUNNER_STATUS_LABEL[live.status] ? t(RUNNER_STATUS_LABEL[live.status]) : live.status}
                    </span>
                    {live.updatedAt ? <span className="meta-chip">{formatTime(live.updatedAt)}</span> : null}
                    <span className="meta-chip mono">{taskId}</span>
                  </div>
                  <div className="td-summary">{live.summary || t("panels.task.noSummary")}</div>
                  <div className="config-actions">
                    {local && live.prompt ? (
                      <button
                        className="mini-btn primary"
                        onClick={async () => {
                          await navigator.clipboard.writeText(live.prompt!);
                          useBoardStore.getState().showToast(tr("panels.task.promptCopied"));
                        }}
                      >
                        <UI.copy {...ICON_SM} /> {t("panels.task.copyPrompt")}
                      </button>
                    ) : null}
                    {goalAgentOrigin() ? (
                      <button
                        className="mini-btn"
                        onClick={() => window.open(`${goalAgentOrigin()}/?task=${encodeURIComponent(taskId)}`, "_blank", "noopener")}
                      >
                        <UI.external {...ICON_SM} /> {t("panels.task.viewInAgent")}
                      </button>
                    ) : null}
                    <button
                      className="mini-btn"
                      onClick={async () => {
                        await navigator.clipboard.writeText(taskId);
                        useBoardStore.getState().showToast(tr("panels.task.idCopied"));
                      }}
                    >
                      <UI.copy {...ICON_SM} /> {t("panels.task.copyId")}
                    </button>
                  </div>
                </>
              )}
            </section>

            {taskId ? (
              <section className="td-block">
                <div className="td-label">{t("panels.task.artifacts")}{artifacts?.length ? ` · ${artifacts.length}` : ""}</div>
                {artifacts === null ? (
                  <div className="config-hint">{t("panels.task.artifactsLoading")}</div>
                ) : !artifacts.length ? (
                  <div className="config-hint">{t("panels.task.artifacts.empty")}</div>
                ) : (
                  artifacts.map((artifact) => (
                    <div className="artifact-row" key={artifact.id}>
                      <span className="artifact-kind">{artifact.kind || "file"}</span>
                      <span className="artifact-main">
                        <span className="artifact-name">{artifact.name || artifact.location || artifact.id}</span>
                        {artifact.location ? <span className="artifact-loc mono">{artifact.location}</span> : null}
                      </span>
                      {/^https?:\/\//i.test(artifact.location || "") ? (
                        <a href={artifact.location} target="_blank" rel="noopener noreferrer" title={t("panels.task.open")}>
                          <UI.external {...ICON_SM} />
                        </a>
                      ) : null}
                      <button className="mini-btn" disabled={busy} title={t("panels.task.toCard.title")} onClick={() => void toCard(artifact)}>
                        <UI.add {...ICON_SM} /> {t("panels.task.toCard")}
                      </button>
                    </div>
                  ))
                )}
              </section>
            ) : null}

            {related.up.length || related.down.length ? (
              <section className="td-block">
                <div className="td-label">{t("panels.task.related")}</div>
                {[
                  ...related.up.map((item) => ["panels.task.upstream" as DictKey, item] as const),
                  ...related.down.map((item) => ["panels.task.downstream" as DictKey, item] as const),
                ].map(
                  ([dir, item]) => {
                    const Icon = typeIcon(item.type);
                    return (
                      <button
                        key={`${dir}-${item.id}`}
                        className="rel-row"
                        onClick={() => useBoardStore.getState().requestFocus(item.id)}
                        title={t("panels.task.locate")}
                      >
                        <span className="rel-dir">{t(dir)}</span>
                        <Icon {...ICON_SM} />
                        {item.title || typeLabel(item.type)}
                      </button>
                    );
                  },
                )}
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
