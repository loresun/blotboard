"use client";

/**
 * 任务台的「Runner 设置」区（OPEN-SOURCE-PLAN §4.1）：ACP agent 注册表的管理面。
 *
 * 三块：
 *  1. **预设**——内置的本机 agent 清单（lib/acp/presets.ts）。「检测并添加」会用
 *     派单时的同一套握手真跑一次，探通了才落盘，落的是**这台机器上真能跑的那条命令**
 *     （首选二进制没装就落 npx 兜底）——省掉「手抄命令 → 派单才发现不对」那一圈；
 *  2. **已注册的 agent**——增删改（command + args + cwd + env）、默认 agent，
 *     每条都能单独「检测」；
 *  3. **权限档位**——ask = 权限请求等我批 / auto = 自动放行并记账。
 *
 * 后端形态：goal-agent / http 后端下派单仍由外部 Runner 接管（本机 ACP 派单尚未接通），
 * 但注册表与检测在任何后端下都可用——先把本机 agent 配好、验通，接通后即可直接派。
 *
 * env 的值永远拿不回来（服务端只回 key 名）：编辑时留空 = 保留原值，
 * 重新填写 = 整体替换——这是「密钥不回显」约束下能做的最诚实交互。
 */
import { useCallback, useEffect, useState } from "react";
import { api, type AcpProbeResult, type RunnerAgentInfo, type RunnerPresetInfo } from "@/lib/api-client";
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

/** 一格检测的状态。key 形如 `preset:kimi` / `agent:a_1234` */
type ProbeState = { busy: true } | { busy: false; result: AcpProbeResult };

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

function cmdLine(command: string, args: string[]): string {
  return args.length ? `${command} ${args.join(" ")}` : command;
}

export function RunnerSettingsPanel({ backend, onChanged }: { backend: TaskBackendKind; onChanged?: () => void }) {
  const t = useT();
  const [agents, setAgents] = useState<RunnerAgentInfo[] | null>(null);
  const [presets, setPresets] = useState<RunnerPresetInfo[]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<"ask" | "auto">("ask");
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const payload = await api.runnerSettings();
      setAgents(payload.settings.agents);
      setPresets(payload.presets || []);
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

  /** 探一格。返回结果给「检测并添加」接着用；失败也返回 null 而不抛（这是诊断动作） */
  async function probe(key: string, payload: Parameters<typeof api.probeAcpAgent>[0]): Promise<AcpProbeResult | null> {
    setProbes((prev) => ({ ...prev, [key]: { busy: true } }));
    setNotice("");
    try {
      const result = await api.probeAcpAgent(payload);
      setProbes((prev) => ({ ...prev, [key]: { busy: false, result } }));
      return result;
    } catch (err) {
      setError((err as Error).message);
      setProbes((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return null;
    }
  }

  /**
   * 「检测并添加」：先真握手，**探通了才落盘**，落的是探通的那条命令
   * （首选二进制没装时就是 npx 兜底那条）。只差登录（needsAuth）也照样落——
   * 命令是对的，缺的是人去登录，拦着不给存反而帮倒忙。
   */
  async function probeAndAdd(preset: RunnerPresetInfo) {
    const result = await probe(`preset:${preset.key}`, { presetKey: preset.key });
    if (!result || (!result.ok && !result.needsAuth)) return;
    if (!agents) return;
    const existing = agents.find((agent) => agent.id === preset.key);
    const entry = {
      id: preset.key,
      name: preset.name,
      command: result.command,
      args: result.args,
      cwd: existing?.cwd || "",
    };
    const rest = agents.filter((agent) => agent.id !== preset.key).map(asPatchAgent);
    await patch({
      agents: [...rest, entry],
      // 头一个探通的顺手设成默认：不然「加完了还得再点一次设默认」
      ...(defaultAgentId ? {} : { defaultAgentId: preset.key }),
    });
    setNotice(t("pages.runner.probe.added", { name: preset.name, command: cmdLine(result.command, result.args) }));
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

  /** 一格检测结果的呈现（连通 / 只差登录 / 没通，附排障尾巴） */
  function ProbeLine({ state }: { state: ProbeState | undefined }) {
    if (!state) return null;
    if (state.busy) return <div className="tk-probe running">{t("pages.runner.probe.running")}</div>;
    const { result } = state;
    const stageLabel = t(`pages.runner.probe.stage.${result.stage}` as never);
    if (result.ok) {
      return (
        <div className="tk-probe ok">
          <UI.check {...ICON_SM} />{" "}
          {t("pages.runner.probe.ok", {
            ms: `${(result.ms / 1000).toFixed(1)}s`,
            version: String(result.protocolVersion ?? "?"),
          })}
          {result.via === "fallback" ? t("pages.runner.probe.via.fallback") : ""}
          {result.authMethods.length ? (
            <div className="tk-probe-note">
              {t("pages.runner.probe.authHint", { methods: result.authMethods.join(" / ") })}
            </div>
          ) : null}
        </div>
      );
    }
    return (
      <div className={`tk-probe ${result.needsAuth ? "warn" : "bad"}`}>
        {result.needsAuth ? t("pages.runner.probe.needsAuth") : t("pages.runner.probe.failed", { stage: stageLabel })}
        {result.error ? <div className="tk-probe-note">{result.error}</div> : null}
        {result.stderrTail ? (
          <details className="tk-probe-detail">
            <summary>{t("pages.runner.probe.detail")}</summary>
            <pre className="mono">{result.stderrTail}</pre>
          </details>
        ) : null}
      </div>
    );
  }

  const registeredIds = new Set((agents || []).map((agent) => agent.id));

  return (
    <div className="tk-detail-body tk-runner-settings">
      <h1 className="tk-title">{t("pages.runner.title")}</h1>
      <div className="config-hint">{t("pages.runner.hint")}</div>
      {backend !== "local" ? (
        <div className="config-hint tk-runner-takeover">
          {t("pages.runner.takeover.a")}<b>{backend}</b>{t("pages.runner.takeover.b")}<b>{t("pages.runner.takeover.c")}</b>
          {t("pages.runner.takeover.d")}
        </div>
      ) : null}
      {error ? <div className="nav-error">{error}</div> : null}
      {notice ? <div className="config-hint tk-probe ok">{notice}</div> : null}

      <div className="td-label">{t("pages.runner.presets")}</div>
      <div className="config-hint">{t("pages.runner.presets.hint")}</div>
      <div className="tk-runs">
        {presets.map((preset) => {
          const key = `preset:${preset.key}`;
          const state = probes[key];
          return (
            <div className="tk-run tk-preset-row" key={preset.key}>
              <div className="tk-run-head">
                <span className="tk-agent-name">{preset.name}</span>
                {registeredIds.has(preset.key) ? (
                  <span className="tk-chip run-completed">{t("pages.runner.presets.added")}</span>
                ) : null}
                <span className="foot-spacer" />
                <button className="mini-btn" disabled={busy || state?.busy} onClick={() => void probe(key, { presetKey: preset.key })}>
                  {t("pages.runner.presets.probeOnly")}
                </button>
                <button
                  className="mini-btn primary"
                  disabled={busy || state?.busy || agents === null}
                  onClick={() => void probeAndAdd(preset)}
                >
                  <UI.add {...ICON_SM} /> {t("pages.runner.presets.probeAdd")}
                </button>
              </div>
              <div className="tk-agent-cmd mono">
                {cmdLine(preset.command, preset.args)}
                {preset.fallback ? t("pages.runner.presets.fallbackNote") : ""}
              </div>
              <div className="tk-agent-meta">
                {preset.auth}
                {preset.note ? ` · ${preset.note}` : ""}
              </div>
              <ProbeLine state={state} />
            </div>
          );
        })}
      </div>

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
                <button
                  className="mini-btn"
                  disabled={busy || probes[`agent:${agent.id}`]?.busy}
                  onClick={() => void probe(`agent:${agent.id}`, { agentId: agent.id })}
                >
                  {t("pages.runner.presets.probeOnly")}
                </button>
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
              <div className="tk-agent-cmd mono">{cmdLine(agent.command, agent.args)}</div>
              <div className="tk-agent-meta">
                {t("pages.runner.cwd")}{agent.cwd || t("pages.runner.cwd.default")}
                {agent.envKeys.length ? t("pages.runner.envKeys", { keys: agent.envKeys.join(", ") }) : ""}
              </div>
              <ProbeLine state={probes[`agent:${agent.id}`]} />
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
              placeholder="claude-agent-acp"
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
          </label>
          <label className="tk-field">
            {t("pages.runner.field.args")}
            <input value={draft.args} placeholder="acp" onChange={(e) => setDraft({ ...draft, args: e.target.value })} />
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
            <button
              className="mini-btn"
              disabled={busy || probes["draft"]?.busy}
              onClick={() =>
                void probe("draft", { command: draft.command.trim(), args: splitArgs(draft.args), cwd: draft.cwd.trim() })
              }
            >
              {t("pages.runner.presets.probeOnly")}
            </button>
            <button className="mini-btn" disabled={busy} onClick={() => setDraft(null)}>
              {t("common.cancel")}
            </button>
          </div>
          <ProbeLine state={probes["draft"]} />
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
