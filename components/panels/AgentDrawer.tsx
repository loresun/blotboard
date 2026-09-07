"use client";

/**
 * Agent 抽屉：
 *  · Agent 指令 —— 内置模板 + 用户自定义指令（可增删改、可隐藏内置），派出后实时跟踪进展
 *  · 画板配置 JSON —— 画板即配置，直接编辑 / 应用 / 复制给 Agent 当上下文
 *
 * 「agent 改完页面直接刷新」的实现：派出任务即进入跟踪态，跟踪期间绕过写后防抖窗口
 * 每 2 秒强拉一次画板，画板 updatedAt 一变就换掉画布并提示（见 store.pollAgentRun）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import {
  commandNeedsInput,
  MAX_COMMAND_DESC,
  MAX_COMMAND_INPUT_HINT,
  MAX_COMMAND_PROMPT,
  MAX_COMMAND_TITLE,
  MAX_USER_INPUT,
  PLACEHOLDERS,
  renderPrompt,
  type AgentCommand,
  type AgentCommandContext,
} from "@/lib/agent-commands";
import { AGENT_ICON_NAMES, ICON_MD, ICON_SM, TYPE_ICON, UI, agentIcon } from "@/lib/icons";
import { typeLabelOf } from "@/lib/card-metas";
import { useCardLabel, useT, tr } from "@/lib/i18n/client";
import { t as translate } from "@/lib/i18n";
import { CONTEXT_MODE_LABEL, EDGE_KIND_META, STATUS_META } from "@/lib/constants";
import { boardOrigin, goalAgentOrigin } from "@/lib/origins";
import { useBoardStore } from "@/lib/store";
import { BOARD_CARD_TYPES, CONTEXT_MODES, type BoardDetail, type CardType, type ContextMode } from "@/lib/types";

type Tab = "agent" | "config";

interface Draft {
  id: string | null;
  icon: string;
  title: string;
  desc: string;
  prompt: string;
  inputHint: string;
  builtin: boolean;
}

const EMPTY_DRAFT: Draft = { id: null, icon: "sparkles", title: "", desc: "", prompt: "", inputHint: "", builtin: false };

/** 派出前现填的那句话：{ 指令 id, 正文 } */
interface Composing {
  commandId: string;
  text: string;
}

const OUTLINE_MAX_CARDS = 80;
const OUTLINE_MAX_EDGES = 80;

function oneLine(text: string, max: number): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 给 agent 的画板清单：一行一张卡（id + 类型 + 状态 + 标题摘要），够它定位到具体卡片，
 * 正文仍要它自己 GET——所以这里只摘要、不搬全文，长板也不会把提示词顶爆。
 */
/**
 * 给 agent 的清单**恒用中文**：它跟 skill 文档、API 说明是同一套词，
 * 不该因为看板子的人把界面切成英文就变一种说法。所以这里显式取 zh 那一份，不跟 locale 走。
 */
function agentZh(key: Parameters<typeof translate>[1]): string {
  return translate("zh", key);
}

function boardOutline(board: BoardDetail | null): string {
  if (!board || (!board.cards.length && !board.edges.length)) return "";
  const lines = [`共 ${board.cards.length} 张卡片、${board.edges.length} 条连线。`, ""];
  for (const card of board.cards.slice(0, OUTLINE_MAX_CARDS)) {
    const tags = [typeLabelOf(card.type)];
    if (card.type === "task" && card.task) tags.push(agentZh(STATUS_META[card.task.status]));
    if (card.createdBy === "agent") tags.push("agent 建的");
    if (card.agentPrompt) tags.push("有卡片级指令");
    const text =
      oneLine(card.title, 40) ||
      oneLine(card.type === "task" ? card.task?.goal || card.content : card.content, 40) ||
      oneLine(card.link?.url || card.file?.name || "", 40) ||
      "（空卡）";
    lines.push(`- \`${card.id}\` [${tags.join(" · ")}] ${text}`);
  }
  if (board.cards.length > OUTLINE_MAX_CARDS) {
    lines.push(`- …另有 ${board.cards.length - OUTLINE_MAX_CARDS} 张卡片，GET 全量拿`);
  }
  if (board.edges.length) {
    lines.push("", "连线：");
    for (const edge of board.edges.slice(0, OUTLINE_MAX_EDGES)) {
      const kind = EDGE_KIND_META[edge.kind]?.label || edge.kind;
      lines.push(`- \`${edge.from}\` →[${kind}${edge.label ? ` · ${oneLine(edge.label, 20)}` : ""}] \`${edge.to}\``);
    }
    if (board.edges.length > OUTLINE_MAX_EDGES) {
      lines.push(`- …另有 ${board.edges.length - OUTLINE_MAX_EDGES} 条连线`);
    }
  }
  return lines.join("\n");
}

function boardConfigJson(board: BoardDetail | null): string {
  if (!board) return "";
  const simplified = {
    name: board.name,
    viewport: board.viewport,
    cards: board.cards.map((card) => {
      const light: Record<string, unknown> = {
        id: card.id,
        type: card.type,
        title: card.title,
        content: card.content,
        x: card.x,
        y: card.y,
        w: card.w,
        h: card.h,
        z: card.z,
        color: card.color,
        createdBy: card.createdBy,
      };
      if (card.type === "task") light.task = card.task;
      if (card.type === "link") light.link = card.link;
      if (card.type === "quote") light.quote = card.quote;
      if (card.type === "image" || card.type === "pdf") light.file = card.file;
      return light;
    }),
    edges: board.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, label: edge.label })),
  };
  return JSON.stringify(simplified, null, 2);
}

function commandContext(board: BoardDetail, boardId: string, userInput: string): AgentCommandContext {
  return {
    boardId,
    boardName: board.name,
    userInput,
    boardOutline: boardOutline(board),
    // API base 用服务端配的（agent 在本机跑，回环最稳）；给用户的链接用他此刻访问的 origin
    boardBase: document.body.dataset.boardBase || boardOrigin(),
    boardLink: boardOrigin(),
    goalAgentWeb: goalAgentOrigin(),
  };
}

export function AgentDrawer() {
  const open = useBoardStore((state) => state.drawer === "agent");
  const setDrawer = useBoardStore((state) => state.setDrawer);
  const board = useBoardStore((state) => state.board);
  const boardId = useBoardStore((state) => state.boardId);
  const agentRun = useBoardStore((state) => state.agentRun);
  const t = useT();
  const [tab, setTab] = useState<Tab>("agent");
  const [configText, setConfigText] = useState("");
  const [commands, setCommands] = useState<AgentCommand[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [composing, setComposing] = useState<Composing | null>(null);
  const [busy, setBusy] = useState(false);
  const dirtyRef = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);

  const loadCommands = useCallback(async () => {
    try {
      setCommands(await api.listAgentCommands());
    } catch (err) {
      useBoardStore.getState().showToast((err as Error).message);
      setCommands([]);
    }
  }, []);

  /** 以服务端为真源载入配置，避免把旧快照 whole 回去覆盖 taskId 等字段。 */
  const loadConfig = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    const state = useBoardStore.getState();
    if (!state.boardId) return;
    if (dirtyRef.current && !force) return;
    try {
      await state.refreshBoard();
    } catch {
      /* 拉取失败时退回本地快照 */
    }
    if (dirtyRef.current && !force) return;
    dirtyRef.current = false;
    setConfigText(boardConfigJson(useBoardStore.getState().board));
  }, []);

  useEffect(() => {
    dirtyRef.current = false;
    if (!open) return;
    if (tab === "config") void loadConfig({ force: true });
    if (tab === "agent" && !commands) void loadCommands();
  }, [open, tab, boardId, loadConfig, loadCommands, commands]);

  useEffect(() => {
    if (composing) composeRef.current?.focus();
  }, [composing?.commandId]);

  /** 换板 / 关抽屉都把没派出去的输入丢掉，免得那句话跟着落到别的板上。 */
  useEffect(() => {
    setComposing(null);
  }, [boardId, open]);

  /**
   * 派一条指令。带 {userInput} 的指令先展开输入框让用户补一句，
   * 补完再走这里——基础信息（{boardBrief} / {boardOutline} / 地址 / 鉴权）由占位符自动带上。
   */
  async function dispatch(command: AgentCommand, userInput = "") {
    const state = useBoardStore.getState();
    if (!state.boardId || !state.board) return;
    if (commandNeedsInput(command) && !userInput.trim()) {
      state.showToast(tr("panels.agent.needInput"));
      return;
    }
    // 派出前拉一次最新，避免把过期的卡片清单当上下文发给 agent
    try {
      await state.refreshBoard();
    } catch {
      /* 拉不到就用本地快照，不挡派发 */
    }
    const fresh = useBoardStore.getState();
    if (!fresh.boardId || !fresh.board) return;
    const prompt = renderPrompt(
      command.prompt,
      commandContext(fresh.board, fresh.boardId, userInput.slice(0, MAX_USER_INPUT)),
    );
    setBusy(true);
    try {
      const payload = await api.dispatchAgentTask(prompt);
      const taskId = payload?.task?.id || payload?.sessionId || payload?.id;
      if (taskId) {
        state.startAgentRun(String(taskId), command.title);
        state.showToast(tr("panels.agent.dispatched", { title: command.title }));
      } else {
        state.showToast(tr("panels.agent.dispatchedNoTask"));
      }
      setComposing(null);
    } catch (err) {
      state.showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!draft) return;
    const state = useBoardStore.getState();
    if (!draft.title.trim() || !draft.prompt.trim()) {
      state.showToast(tr("panels.agent.draftIncomplete"));
      return;
    }
    setBusy(true);
    try {
      const payload = {
        icon: draft.icon,
        title: draft.title,
        desc: draft.desc,
        prompt: draft.prompt,
        inputHint: draft.inputHint,
      };
      if (draft.id) await api.updateAgentCommand(draft.id, payload);
      else await api.createAgentCommand(payload);
      await loadCommands();
      setDraft(null);
      state.showToast(tr(draft.id ? "panels.agent.cmdSaved" : "panels.agent.cmdCreated"));
    } catch (err) {
      state.showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleHidden(command: AgentCommand) {
    try {
      await api.updateAgentCommand(command.id, { hidden: !command.hidden });
      await loadCommands();
    } catch (err) {
      useBoardStore.getState().showToast((err as Error).message);
    }
  }

  async function removeCommand(command: AgentCommand) {
    const label = tr(command.builtin ? "panels.agent.restore.confirm" : "panels.agent.remove.confirm", {
      title: command.title,
    });
    if (!window.confirm(label)) return;
    try {
      await api.deleteAgentCommand(command.id);
      await loadCommands();
      useBoardStore.getState().showToast(tr(command.builtin ? "panels.agent.restored" : "panels.agent.removed"));
    } catch (err) {
      useBoardStore.getState().showToast((err as Error).message);
    }
  }

  function insertPlaceholder(token: string) {
    const textarea = promptRef.current;
    if (!textarea || !draft) return;
    const start = textarea.selectionStart ?? draft.prompt.length;
    const end = textarea.selectionEnd ?? start;
    const next = `${draft.prompt.slice(0, start)}${token}${draft.prompt.slice(end)}`;
    setDraft({ ...draft, prompt: next });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function applyConfig() {
    const state = useBoardStore.getState();
    if (!state.boardId) return;
    let payload: unknown;
    try {
      payload = JSON.parse(configText);
    } catch (err) {
      state.showToast(tr("panels.agent.jsonFailed", { message: (err as Error).message }));
      return;
    }
    try {
      await api.replaceWhole(state.boardId, payload);
      state.showToast(tr("panels.agent.configApplied"));
      await state.openBoard(state.boardId);
      await loadConfig({ force: true });
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  const visible = (commands || []).filter((command) => showHidden || !command.hidden);
  const hiddenCount = (commands || []).filter((command) => command.hidden).length;

  return (
    <div className={`drawer agent${open ? " open" : ""}`}>
      <div className="drawer-head">
        <h2>{t("panels.agent.title")}</h2>
        <button className="drawer-close" title={t("common.close")} onClick={() => setDrawer(null)}>
          <UI.close {...ICON_MD} />
        </button>
      </div>
      <div className="drawer-tabs">
        <button className={tab === "agent" ? "active" : ""} onClick={() => setTab("agent")}>
          <UI.agent {...ICON_SM} /> {t("panels.agent.tab.commands")}
        </button>
        <button className={tab === "config" ? "active" : ""} onClick={() => setTab("config")}>
          <UI.blocks {...ICON_SM} /> {t("panels.agent.tab.config")}
        </button>
      </div>
      <div className="drawer-body">
        {tab === "agent" ? (
          <>
            {agentRun ? (
              <div className="agent-track">
                <div className="agent-track-head">
                  <span className={agentRun.status === "running" ? "spin" : ""}>
                    {agentRun.status === "running" ? <UI.refresh {...ICON_SM} /> : <UI.check {...ICON_SM} />}
                  </span>
                  {t("panels.agent.tracking", { title: agentRun.commandTitle })}
                </div>
                <div className="agent-track-meta mono">
                  {agentRun.taskId} · {agentRun.status}
                  {agentRun.boardTouched
                    ? ` · ${t("panels.agent.track.synced")}`
                    : ` · ${t("panels.agent.track.waiting")}`}
                </div>
                {agentRun.summary ? <div className="agent-track-summary">{agentRun.summary}</div> : null}
                <div className="agent-track-actions">
                  <button
                    className="mini-btn"
                    onClick={() => {
                      void useBoardStore.getState().refreshBoard();
                      useBoardStore.getState().showToast(tr("panels.agent.refreshed"));
                    }}
                  >
                    <UI.refresh {...ICON_SM} /> {t("panels.agent.refreshNow")}
                  </button>
                  <button className="mini-btn" onClick={() => useBoardStore.getState().stopAgentRun()}>
                    <UI.ban {...ICON_SM} /> {t("panels.agent.stopTracking")}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="config-hint">
              {t("panels.agent.note.a")}
              <b>{board?.name || t("panels.agent.noBoard")}</b>
              {t("panels.agent.note.b")} <code>{"{userInput}"}</code> {t("panels.agent.note.c")}{" "}
              <code>blotboard-8567</code>
              {t("panels.agent.note.d")}
            </div>

            <ContextPolicy />

            {draft ? (
              <div className="cmd-form">
                <label>{t("panels.agent.field.icon")}</label>
                <div className="cmd-icons">
                  {AGENT_ICON_NAMES.map((name) => {
                    const Icon = agentIcon(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        className={`cmd-icon-pick${draft.icon === name ? " active" : ""}`}
                        title={name}
                        onClick={() => setDraft({ ...draft, icon: name })}
                      >
                        <Icon {...ICON_MD} />
                      </button>
                    );
                  })}
                </div>
                <label>{t("panels.agent.field.title")}</label>
                <input
                  type="text"
                  maxLength={MAX_COMMAND_TITLE}
                  placeholder={t("panels.agent.field.title.placeholder")}
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
                <label>{t("panels.agent.field.desc")}</label>
                <input
                  type="text"
                  maxLength={MAX_COMMAND_DESC}
                  placeholder={t("panels.agent.field.desc.placeholder")}
                  value={draft.desc}
                  onChange={(event) => setDraft({ ...draft, desc: event.target.value })}
                />
                <label>{t("panels.agent.field.prompt")}</label>
                <textarea
                  ref={promptRef}
                  maxLength={MAX_COMMAND_PROMPT}
                  placeholder={t("panels.agent.field.prompt.placeholder")}
                  value={draft.prompt}
                  onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                />
                <div className="placeholder-list">
                  {Object.entries(PLACEHOLDERS).map(([token, desc]) => (
                    <button key={token} type="button" title={desc} onClick={() => insertPlaceholder(token)}>
                      {token}
                    </button>
                  ))}
                </div>
                {draft.prompt.includes("{userInput}") ? (
                  <>
                    <label>{t("panels.agent.field.inputHint")}</label>
                    <input
                      type="text"
                      maxLength={MAX_COMMAND_INPUT_HINT}
                      placeholder={t("panels.agent.field.inputHint.placeholder")}
                      value={draft.inputHint}
                      onChange={(event) => setDraft({ ...draft, inputHint: event.target.value })}
                    />
                  </>
                ) : null}
                <div className="cmd-form-actions">
                  <button className="mini-btn primary" disabled={busy} onClick={saveDraft}>
                    <UI.check {...ICON_SM} /> {t("common.save")}
                  </button>
                  <button className="mini-btn" onClick={() => setDraft(null)}>
                    {t("common.cancel")}
                  </button>
                  {draft.builtin ? (
                    <span className="config-hint" style={{ margin: 0 }}>
                      {t("panels.agent.builtinNote")}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="config-actions">
                <button className="mini-btn primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                  <UI.add {...ICON_SM} /> {t("panels.agent.newCommand")}
                </button>
                {hiddenCount ? (
                  <button className="mini-btn" onClick={() => setShowHidden((value) => !value)}>
                    {showHidden ? t("panels.agent.hideDisabled") : t("panels.agent.showDisabled", { count: hiddenCount })}
                  </button>
                ) : null}
              </div>
            )}

            {commands === null ? (
              <div className="config-hint">{t("panels.agent.loading")}</div>
            ) : (
              visible.map((command) => {
                const Icon = agentIcon(command.icon);
                const needsInput = commandNeedsInput(command);
                const composingHere = composing?.commandId === command.id;
                return (
                  <div className={`agent-card${command.hidden ? " hidden-cmd" : ""}${composingHere ? " composing" : ""}`} key={command.id}>
                    <h4>
                      <span className="ac-icon">
                        <Icon {...ICON_MD} />
                      </span>
                      <span className="ac-title">{command.title}</span>
                      {needsInput ? <span className="builtin-tag input-tag">{t("panels.agent.needsInputTag")}</span> : null}
                      {command.builtin ? <span className="builtin-tag">{t("panels.agent.builtinTag")}</span> : null}
                    </h4>
                    {command.desc ? <p>{command.desc}</p> : null}
                    <div className="ac-actions">
                      <button
                        className="mini-btn primary"
                        disabled={busy || !boardId || command.hidden}
                        onClick={() => {
                          if (!needsInput) return void dispatch(command);
                          setComposing(composingHere ? null : { commandId: command.id, text: "" });
                        }}
                      >
                        {needsInput ? <UI.edit {...ICON_SM} /> : <UI.send {...ICON_SM} />}
                        {needsInput
                          ? composingHere
                            ? t("panels.agent.collapse")
                            : t("panels.agent.writeAndSend")
                          : t("panels.agent.run")}
                      </button>
                      <button
                        className="ac-icon-btn"
                        title={t("panels.agent.editCommand")}
                        onClick={() =>
                          setDraft({
                            id: command.id,
                            icon: command.icon,
                            title: command.title,
                            desc: command.desc,
                            prompt: command.prompt,
                            inputHint: command.inputHint || "",
                            builtin: command.builtin,
                          })
                        }
                      >
                        <UI.edit {...ICON_SM} />
                      </button>
                      <button
                        className="ac-icon-btn"
                        title={t(command.hidden ? "panels.agent.enable" : "panels.agent.disable")}
                        onClick={() => toggleHidden(command)}
                      >
                        {command.hidden ? <UI.check {...ICON_SM} /> : <UI.ban {...ICON_SM} />}
                      </button>
                      <button
                        className="ac-icon-btn danger"
                        title={t(command.builtin ? "panels.agent.restoreDefault" : "panels.agent.removeCommand")}
                        onClick={() => removeCommand(command)}
                      >
                        {command.builtin ? <UI.undo {...ICON_SM} /> : <UI.remove {...ICON_SM} />}
                      </button>
                    </div>
                    {composingHere && composing ? (
                      <div className="ac-compose">
                        <textarea
                          ref={composeRef}
                          maxLength={MAX_USER_INPUT}
                          placeholder={command.inputHint || t("panels.agent.compose.placeholder")}
                          value={composing.text}
                          onChange={(event) => setComposing({ commandId: command.id, text: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault();
                              void dispatch(command, composing.text);
                            }
                            if (event.key === "Escape") setComposing(null);
                          }}
                        />
                        <div className="ac-compose-foot">
                          <span>
                            {t("panels.agent.compose.note", { count: board?.cards.length ?? 0 })}
                            <br />
                            {t("panels.agent.compose.keys")}
                          </span>
                          <button
                            className="mini-btn primary"
                            disabled={busy || !composing.text.trim()}
                            onClick={() => dispatch(command, composing.text)}
                          >
                            <UI.send {...ICON_SM} /> {t("panels.agent.send")}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </>
        ) : (
          <>
            <div className="config-hint">{t("panels.agent.config.note")}</div>
            <textarea
              className="config-textarea"
              spellCheck={false}
              value={configText}
              onChange={(event) => {
                dirtyRef.current = true;
                setConfigText(event.target.value);
              }}
            />
            <div className="config-actions">
              <button className="mini-btn primary" onClick={applyConfig}>
                <UI.check {...ICON_SM} /> {t("panels.agent.applyReload")}
              </button>
              <button
                className="mini-btn"
                onClick={async () => {
                  await loadConfig({ force: true });
                  useBoardStore.getState().showToast(tr("panels.agent.configReloaded"));
                }}
              >
                <UI.refresh {...ICON_SM} /> {t("panels.agent.reload")}
              </button>
              <button
                className="mini-btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(configText);
                  useBoardStore.getState().showToast(tr("panels.agent.configCopied"));
                }}
              >
                <UI.copy {...ICON_SM} /> {t("common.copy")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


/**
 * 转 Issue 的上下文策略（画板级默认值）。
 * 原来「沿连线一跳的上下游」是写死的，现在可以按需要收窄或放宽。
 */
function ContextPolicy() {
  const board = useBoardStore((state) => state.board);
  const boardId = useBoardStore((state) => state.boardId);
  const [open, setOpen] = useState(false);
  const t = useT();
  const cardLabelOf = useCardLabel();
  const policy = board?.settings?.issueContext || { mode: "neighbors" as ContextMode, types: [] as CardType[] };
  const autoSync = (board?.settings?.issueSync || "auto") === "auto";

  async function save(next: { mode?: ContextMode; types?: CardType[] }) {
    const state = useBoardStore.getState();
    if (!boardId || !board) return;
    const merged = { mode: next.mode ?? policy.mode, types: next.types ?? policy.types };
    try {
      const updated = await api.patchBoardSettings(boardId, { issueContext: merged });
      useBoardStore.setState({ board: { ...board, settings: updated.settings } });
      state.showToast(tr("panels.agent.policySaved"));
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  /** 转过 Issue 的卡片改了之后，要不要自动把最新内容推回 Goal Agent。 */
  async function saveSyncMode(next: boolean) {
    const state = useBoardStore.getState();
    if (!boardId || !board) return;
    try {
      const updated = await api.patchBoardSettings(boardId, { issueSync: next ? "auto" : "off" });
      useBoardStore.setState({ board: { ...board, settings: updated.settings } });
      state.showToast(tr(next ? "panels.agent.sync.on" : "panels.agent.sync.off"));
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  return (
    <div className="policy-box">
      <button className="policy-head" onClick={() => setOpen((value) => !value)}>
        <UI.relations {...ICON_SM} />
        <span className="policy-title">{t("panels.agent.policy.title")}</span>
        {/* 自动同步是默认开着的，只在被关掉时标一下——收起来也知道这块板不自动推 */}
        <span className="policy-current">
          {t(CONTEXT_MODE_LABEL[policy.mode])}
          {autoSync ? "" : ` · ${t("panels.agent.policy.syncOff")}`}
        </span>
        <span className={`card-group-caret${open ? "" : " folded"}`}>
          <UI.chevron size={13} strokeWidth={1.9} />
        </span>
      </button>
      {open ? (
        <div className="policy-body">
          {CONTEXT_MODES.map((mode) => (
            <label key={mode} className="policy-row">
              <input
                type="radio"
                name="issue-context"
                checked={policy.mode === mode}
                onChange={() => save({ mode })}
              />
              {t(CONTEXT_MODE_LABEL[mode])}
            </label>
          ))}
          {policy.mode !== "none" ? (
            <>
              <div className="policy-sub">{t("panels.agent.policy.types")}</div>
              <div className="type-chips">
                {BOARD_CARD_TYPES.map((type: CardType) => {
                  const Icon = TYPE_ICON[type];
                  const on = policy.types.includes(type);
                  return (
                    <button
                      key={type}
                      className={`type-chip${on ? " on" : ""}`}
                      onClick={() =>
                        save({ types: on ? policy.types.filter((item) => item !== type) : [...policy.types, type] })
                      }
                    >
                      <Icon size={13} strokeWidth={1.9} />
                      {cardLabelOf(type)}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
          <div className="policy-sub">{t("panels.agent.policy.after")}</div>
          <label className="policy-row" title={t("panels.agent.policy.autoSync.title")}>
            <input type="checkbox" checked={autoSync} onChange={(event) => void saveSyncMode(event.target.checked)} />
            {t("panels.agent.policy.autoSync")}
          </label>
        </div>
      ) : null}
    </div>
  );
}
