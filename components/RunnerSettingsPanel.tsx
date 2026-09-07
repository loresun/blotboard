"use client";

/**
 * 任务台的「Runner 设置」区（OPEN-SOURCE-PLAN §4.1）：ACP agent 注册表的管理面。
 *
 * local 后端：agent 增删改（怎么拉起：command + args + cwd + env）、默认 agent、
 * 权限档位（ask = 权限请求等我批 / auto = 自动放行并记账）。
 * goal-agent / http 后端：派单与权限都发生在外部 Runner 那边，这里只说明
 * 「由外部 Runner 接管」——本地注册表仍可看，但不给编辑入口免得配了个寂寞。
 *
 * env 的值永远拿不回来（服务端只回 key 名）：编辑时留空 = 保留原值，
 * 重新填写 = 整体替换——这是「密钥不回显」约束下能做的最诚实交互。
 */
import { useCallback, useEffect, useState } from "react";
import { api, type RunnerAgentInfo } from "@/lib/api-client";
import type { TaskBackendKind } from "@/lib/features-client";
import { ICON_SM, UI } from "@/lib/icons";
import { useT } from "@/lib/i18n/client";

interface AgentDraft {
  /** null = 新建；否则是被编辑 agent 的 id */
  id: string | null;
  name: string;
  command: string;
  args: string;
  cwd: string;
  env: string;
  envKeys: string[];
}

const EMPTY_DRAFT: AgentDraft = { id: null, name: "", command: "", args: "", cwd: "", env: "", envKeys: [] };

/** 表单里的 args 输入按空白切（要带空格的参数用注册 API 直接给数组） */
function splitArgs(raw: string): string[] {
  return raw.trim() ? raw.trim().split(/\s+/) : [];
}

function parseEnv(raw: string): Record<string, string> | undefined {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return undefined; // 留空 = 不带 env 字段 = 服务端保留原值
  const env: Record<string, string> = {};
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return env;
}

/** 回传时不带 env 字段：服务端按「保留原值」处理（值本来就拿不到） */
function asPatchAgent(agent: RunnerAgentInfo): Record<string, unknown> {
  return { id: agent.id, name: agent.name, command: agent.command, args: agent.args, cwd: agent.cwd || "" };
}

export function RunnerSettingsPanel({ backend, onChanged }: { backend: TaskBackendKind; onChanged?: () => void }) {
  const t = useT();
  const [agents, setAgents] = useState<RunnerAgentInfo[] | null>(null);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<"ask" | "auto">("ask");
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const payload = await api.runnerSettings();
      setAgents(payload.settings.agents);
      setDefaultAgentId(payload.settings.defaultAgentId);
      setPermissionMode(payload.settings.permissionMode);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(payload: Record<string, unknown>) {
    setBusy(true);
    try {
      const result = await api.patchRunnerSettings(payload);
      setAgents(result.settings.agents);
      setDefaultAgentId(result.settings.defaultAgentId);
      setPermissionMode(result.settings.permissionMode);
      setError("");
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (backend !== "local") {
    return (
      <div className="tk-detail-body tk-runner-settings">
        <h1 className="tk-title">{t("pages.runner.title")}</h1>
        <div className="config-hint tk-runner-takeover">
          {t("pages.runner.takeover.a")}<b>{backend}</b>{t("pages.runner.takeover.b")}<b>{t("pages.runner.takeover.c")}</b>
          {t("pages.runner.takeover.d")}
        </div>
      </div>
    );
  }

  function saveDraft() {
    if (!draft || !agents) return;
    if (!draft.command.trim()) {
      setError(t("pages.runner.error.command"));
      return;
    }
    const rest = agents.filter((agent) => agent.id !== draft.id).map(asPatchAgent);
    const edited: Record<string, unknown> = {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim() || draft.command.trim(),
      command: draft.command.trim(),
      args: splitArgs(draft.args),
      cwd: draft.cwd.trim(),
    };
    const env = parseEnv(draft.env);
    if (env !== undefined) edited.env = env;
    void patch({ agents: [...rest, edited] }).then(() => setDraft(null));
  }

  return (
    <div className="tk-detail-body tk-runner-settings">
      <h1 className="tk-title">{t("pages.runner.title")}</h1>
      <div className="config-hint">{t("pages.runner.hint")}</div>
      {error ? <div className="nav-error">{error}</div> : null}

      <div className="td-label">{t("pages.runner.permission")}</div>
      <div className="tk-actions">
        <button
          className={`mini-btn${permissionMode === "ask" ? " primary" : ""}`}
          disabled={busy}
          onClick={() => void patch({ permissionMode: "ask" })}
        >
          {t("pages.runner.permission.ask")}
        </button>
        <button
          className={`mini-btn${permissionMode === "auto" ? " primary" : ""}`}
          disabled={busy}
          onClick={() => void patch({ permissionMode: "auto" })}
        >
          {t("pages.runner.permission.auto")}
        </button>
      </div>

      <div className="td-label">{t("pages.runner.agents")}{agents?.length ? ` · ${agents.length}` : ""}</div>
      {agents === null ? (
        <div className="config-hint">{t("pages.runner.loading")}</div>
      ) : !agents.length ? (
        <div className="config-hint">{t("pages.runner.empty")}</div>
      ) : (
        <div className="tk-runs">
          {agents.map((agent) => (
            <div className="tk-run tk-agent-row" key={agent.id}>
              <div className="tk-run-head">
                <span className="tk-agent-name">{agent.name}</span>
                {defaultAgentId === agent.id ? <span className="tk-chip run-completed">{t("pages.runner.default")}</span> : null}
                <span className="foot-spacer" />
                {defaultAgentId !== agent.id ? (
                  <button className="mini-btn" disabled={busy} onClick={() => void patch({ defaultAgentId: agent.id })}>
                    {t("pages.runner.setDefault")}
                  </button>
                ) : null}
                <button
                  className="mini-btn"
                  disabled={busy}
                  onClick={() =>
                    setDraft({
                      id: agent.id,
                      name: agent.name,
                      command: agent.command,
                      args: agent.args.join(" "),
                      cwd: agent.cwd || "",
                      env: "",
                      envKeys: agent.envKeys,
                    })
                  }
                >
                  {t("pages.runner.edit")}
                </button>
                <button
                  className="mini-btn"
                  disabled={busy}
                  onClick={() => void patch({ agents: agents.filter((item) => item.id !== agent.id).map(asPatchAgent) })}
                >
                  {t("common.delete")}
                </button>
              </div>
              <div className="tk-agent-cmd mono">
                {agent.command}
                {agent.args.length ? ` ${agent.args.join(" ")}` : ""}
              </div>
              <div className="tk-agent-meta">
                {t("pages.runner.cwd")}{agent.cwd || t("pages.runner.cwd.default")}
                {agent.envKeys.length ? t("pages.runner.envKeys", { keys: agent.envKeys.join(", ") }) : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      {draft ? (
        <div className="tk-run tk-agent-form">
          <div className="td-label">{draft.id ? t("pages.runner.form.edit") : t("pages.runner.form.new")}</div>
          <label className="tk-field">
            {t("pages.runner.field.name")}
            <input value={draft.name} placeholder="Claude Code" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="tk-field">
            command
            <input
              value={draft.command}
              placeholder="claude-code-acp"
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
          </label>
          <label className="tk-field">
            {t("pages.runner.field.args")}
            <input value={draft.args} placeholder="--acp" onChange={(e) => setDraft({ ...draft, args: e.target.value })} />
          </label>
          <label className="tk-field">
            {t("pages.runner.field.cwd")}
            <input value={draft.cwd} placeholder="/path/to/your/repo" onChange={(e) => setDraft({ ...draft, cwd: e.target.value })} />
          </label>
          <label className="tk-field">
            {t("pages.runner.field.env", {
              note: draft.envKeys.length
                ? t("pages.runner.field.env.stored", { keys: draft.envKeys.join(", ") })
                : t("pages.runner.field.env.empty"),
            })}
            <textarea value={draft.env} rows={2} onChange={(e) => setDraft({ ...draft, env: e.target.value })} />
          </label>
          <div className="tk-actions">
            <button className="mini-btn primary" disabled={busy} onClick={saveDraft}>
              <UI.check {...ICON_SM} /> {t("common.save")}
            </button>
            <button className="mini-btn" disabled={busy} onClick={() => setDraft(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="tk-actions">
          <button className="mini-btn primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            <UI.add {...ICON_SM} /> {t("pages.runner.add")}
          </button>
        </div>
      )}
    </div>
  );
}
