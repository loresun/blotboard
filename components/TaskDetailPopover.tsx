"use client";

/** 画板内任务详情浮层：不离开画板就能看执行进展（数据现查 Runner，不落库）。 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { RUNNER_STATUS_LABEL, formatTime } from "@/lib/constants";
import { ICON_SM, UI, typeIcon } from "@/lib/icons";
import { useCardLabel, useT } from "@/lib/i18n/client";
import { goalAgentOrigin } from "@/lib/origins";
import { relatedOf, useBoardStore } from "@/lib/store";
import type { BoardCard } from "@/lib/types";

export interface TaskDetailTarget {
  card: BoardCard;
  seq: number;
}

export function TaskDetailPopover({ target, onClose }: { target: TaskDetailTarget | null; onClose: () => void }) {
  const t = useT();
  const cardLabel = useCardLabel();
  const [live, setLive] = useState<{ status: string; summary: string; updatedAt: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);
  const showToast = useBoardStore((state) => state.showToast);

  const card = target?.card;
  const taskId = card?.task?.taskId || null;

  useEffect(() => {
    if (!card) return;
    setLive(null);
    setError(null);
    if (!taskId) return;
    let cancelled = false;
    setLoading(true);
    api
      .runnerTask(taskId)
      .then((payload) => {
        if (cancelled) return;
        const task = payload.task || payload;
        setLive({ status: task.status || "unknown", summary: task.summary || "", updatedAt: task.updatedAt || null });
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [card, taskId, reloadSeq]);

  if (!card) return null;
  const related = relatedOf(card.id);
  const issueRef = card.task?.issueNumber
    ? `${card.task.issueNumber} · ${card.task.issueId || ""}`
    : card.task?.issueId || t("pages.taskDetail.noIssue");

  return (
    <div className="task-detail-float" style={{ right: 24, bottom: 24 }}>
      <div className="tdf-head">
        <UI.detail size={16} strokeWidth={1.8} />
        {card.title || t("pages.taskDetail.fallbackTitle")}
        <span style={{ flex: 1 }} />
        <button className="mini-btn" onClick={onClose}>
          <UI.close {...ICON_SM} /> {t("common.close")}
        </button>
      </div>
      <div className="td-label">Issue</div>
      <div>{issueRef}</div>
      <div className="td-label">{t("pages.taskDetail.taskId")}</div>
      <div className="mono">{taskId || t("pages.taskDetail.noTask")}</div>
      {related.up.length ? (
        <>
          <div className="td-label">{t("pages.taskDetail.upstream")}</div>
          <div>
            {related.up.map((item) => {
              const Icon = typeIcon(item.type);
              return (
                <div key={item.id} className="rel-row">
                  <Icon {...ICON_SM} /> {item.title || cardLabel(item.type)}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      {related.down.length ? (
        <>
          <div className="td-label">{t("pages.taskDetail.downstream")}</div>
          <div>
            {related.down.map((item) => {
              const Icon = typeIcon(item.type);
              return (
                <div key={item.id} className="rel-row">
                  <Icon {...ICON_SM} /> {item.title || cardLabel(item.type)}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      <div style={{ marginTop: 8, color: "var(--text-dim)" }}>
        {!taskId ? (
          t("pages.taskDetail.hintNoTask")
        ) : loading ? (
          t("pages.taskDetail.loading")
        ) : error ? (
          t("pages.taskDetail.failed", { message: error })
        ) : live ? (
          <>
            <div className="td-label">
              {t("pages.taskDetail.latest", { status: RUNNER_STATUS_LABEL[live.status] ? t(RUNNER_STATUS_LABEL[live.status]) : live.status })}
              {live.updatedAt ? ` · ${formatTime(live.updatedAt)}` : ""}
            </div>
            <div className="td-summary">{live.summary || t("pages.taskDetail.noSummary")}</div>
            <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
              <button
                className="mini-btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(taskId);
                  showToast(t("pages.taskDetail.copied"));
                }}
              >
                <UI.copy {...ICON_SM} /> {t("pages.taskDetail.copyTaskId")}
              </button>
              <button className="mini-btn" onClick={() => setReloadSeq((value) => value + 1)}>
                <UI.refresh {...ICON_SM} /> {t("top.zoom.refresh")}
              </button>
              {/* 没配 GOAL_AGENT_WEB_URL 就没有可跳的主界面 */}
              {goalAgentWebUrl() ? (
                <button
                  className="mini-btn"
                  onClick={() => {
                    window.open(`${goalAgentWebUrl()}/?task=${encodeURIComponent(taskId)}`, "_blank", "noopener");
                  }}
                >
                  <UI.external {...ICON_SM} /> {t("pages.taskDetail.openMain")}
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Goal Agent 主界面地址由服务端注入 <body data-goal-agent-web>，避免把配置写死在前端。 */
function goalAgentWebUrl(): string {
  return goalAgentOrigin();
}
