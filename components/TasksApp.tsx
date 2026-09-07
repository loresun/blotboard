"use client";

/**
 * 任务台子页（`/tasks`，OPEN-SOURCE-PLAN §4.1）：工作项在画板之外的家。
 *
 * 三栏：左 = 镜头（待派 / 进行中 / 等我处理 / 已完成 / 已中止，各带计数）+ 画板收窄；
 * 中 = Issue 列表（按最近活动排）；右 = 详情。沿 `/nav` 的先例：独立页、新标签、可深链
 * （`/tasks?issue=i_xxx` 选中定位、`/tasks?board=b_xxx` 预过滤）。
 *
 * 形态随任务后端（body dataset 的 task-backend）分两种：
 *  - **local**：数据就在本地（/api/issues）。详情里能复制完整 prompt、改状态、
 *    看 runs 时间线与日志；孤儿 Issue（板 / 卡已删）只有这里能看到。
 *  - **goal-agent / http**：聚合镜像——数据来自跨画板任务聚合（/api/boards/tasks）
 *    + Runner 实时状态。Issue 真源在外部 Runner，这里做列表、状态与跳转，
 *    **外加一条本机执行路**：任意一条都能派给本机注册的 ACP agent 跑
 *    （lib/integrations/acp-lane.ts）。那种 run 的 id 以 `r_` 开头，列表行打「本机 ACP」标记、
 *    左栏多一个「本机执行」镜头、详情里多一块流式 transcript + 权限确认 + 中止——
 *    最后这块是外部 Runner 那条路给不了的，也正是两条路值得分开呈现的原因。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, type LocalIssueItem, type LocalIssueRunInfo, type RunnerAgentInfo } from "@/lib/api-client";
import { RunnerSettingsPanel } from "@/components/RunnerSettingsPanel";
import { SiteNav } from "@/components/SiteNav";
import {
  ISSUE_STATUS_LABEL,
  PRIORITIES,
  RUNNER_STATUS_LABEL,
  STATUS_DOT,
  STATUS_META,
  TASK_COLUMNS,
  formatTime,
  isLocalRunId,
} from "@/lib/constants";
import { type TaskBackendKind } from "@/lib/features-client";
import { ICON_MD, ICON_SM, STATUS_ICON, UI } from "@/lib/icons";
import { tr, useT } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import { goalAgentOrigin } from "@/lib/origins";
import { Markdown } from "@/components/cards/Markdown";
import type { BoardListItem, TaskIndexItem, TaskStatus } from "@/lib/types";

/* ── 镜头定义 ─────────────────────────────────────── */

/** 文案要跟着语言走，所以取文案的函数由组件把 `t` 传进来 */
type Translate = (key: DictKey, vars?: Record<string, string | number>) => string;

/** local 后端的五个镜头（桶的判定在服务端 lib/issue-store.ts lensOf） */
const LOCAL_LENSES = [
  { key: "all", labelKey: "pages.tasks.lens.all" },
  { key: "pending", labelKey: "pages.tasks.lens.pending" },
  { key: "in_progress", labelKey: "pages.tasks.lens.in_progress" },
  { key: "attention", labelKey: "pages.tasks.lens.attention" },
  { key: "done", labelKey: "pages.tasks.lens.done" },
  { key: "aborted", labelKey: "pages.tasks.lens.aborted" },
] as const satisfies readonly { key: string; labelKey: DictKey }[];

/**
 * 远程形态下选中任务的实时状态。前四个字段两条执行路都有；后四个只有**本机 ACP run**
 * 才填得出来（`/api/runner/tasks/:id` 命中本机 run 时由 acp-lane 就地服务）——
 * 详情页据此多渲染一块流式 transcript / 权限确认，那正是外部 Runner 给不了的部分。
 */
interface LiveTaskInfo {
  status: string;
  summary: string;
  updatedAt: number | null;
  kind: string;
  agentName: string | null;
  /** 本机执行台账的 Issue id（transcript / 权限确认的路径前缀） */
  ledgerIssueId: string | null;
  mode: string | null;
}

/** 远程形态多出来的横切镜头：按「谁在执行」筛，而不是按任务状态 */
const LOCAL_RUN_LENS = "local_acp";

/** Issue 状态的小圆点颜色（镜头行与状态 chip 共用） */
const LENS_DOT: Record<string, string> = {
  all: "#a6abaf",
  pending: "#c9ccd1",
  in_progress: "#e8a33d",
  attention: "#e5484d",
  done: "#3da169",
  aborted: "#8b9099",
};

function relTime(ms: number, t: Translate): string {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff) || diff < 0) return formatTime(ms);
  if (diff < 60_000) return t("pages.time.justNow");
  if (diff < 3_600_000) return t("pages.time.minutes", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("pages.time.hours", { n: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t("pages.time.days", { n: Math.floor(diff / 86_400_000) });
  return formatTime(ms);
}

function issueStatusLabel(status: string, t: Translate): string {
  const key = ISSUE_STATUS_LABEL[status];
  return key ? t(key) : status;
}

/** 执行态：认得的走字典，认不得的原样显示（跟任务卡页脚同一条规矩） */
function runnerStatusLabel(status: string, t: Translate): string {
  const key = RUNNER_STATUS_LABEL[status];
  return key ? t(key) : status;
}

/** 优先级同理：local 后端的 issue.priority 是自由字符串，认不得就照原样摆出来 */
function priorityLabel(priority: string, t: Translate): string {
  const key = PRIORITIES[priority as keyof typeof PRIORITIES];
  return key ? t(key) : priority;
}

export function TasksApp() {
  const t = useT();
  /**
   * 后端种类从 body dataset 读，且只在挂载后读一次：SSR 期没有 document，
   * 先渲染骨架，effect 里定型——避免两种形态在水合时打架。
   */
  const [backend, setBackend] = useState<TaskBackendKind | null>(null);
  const [boards, setBoards] = useState<BoardListItem[]>([]);
  const [boardFilter, setBoardFilter] = useState<string>("");
  const [lens, setLens] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [keyword, setKeyword] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const wantIssueRef = useRef<string | null>(null);

  useEffect(() => {
    const raw = document.body.dataset.taskBackend;
    setBackend(raw === "goal-agent" || raw === "http" ? raw : "local");
    const params = new URLSearchParams(window.location.search);
    if (params.get("board")) setBoardFilter(params.get("board")!);
    if (params.get("q")) {
      setQuery(params.get("q")!);
      setKeyword(params.get("q")!);
    }
    // ?issue= 深链：数据到位后再选中（两种模式的 id 语义不同，各自 resolve）
    wantIssueRef.current = params.get("issue");
    void api.listBoards().then(setBoards).catch(() => undefined);
  }, []);

  /* 搜索防抖 */
  useEffect(() => {
    const timer = setTimeout(() => setKeyword(query.trim()), 260);
    return () => clearTimeout(timer);
  }, [query]);

  /* 选中 / 过滤写回地址栏：这一页要能被收藏、被 agent 回报链接指到 */
  useEffect(() => {
    if (!backend) return;
    const params = new URLSearchParams();
    if (boardFilter) params.set("board", boardFilter);
    if (keyword) params.set("q", keyword);
    if (selectedId) params.set("issue", selectedId);
    const search = params.toString();
    window.history.replaceState(null, "", search ? `/tasks?${search}` : "/tasks");
  }, [backend, boardFilter, keyword, selectedId]);

  const showToast = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast(""), 2600);
  }, []);

  /* ── local 模式的数据 ─────────────────────────── */
  const [issues, setIssues] = useState<LocalIssueItem[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [detail, setDetail] = useState<{ issue: LocalIssueItem; prompt: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /* ACP agent 注册表：两种形态的详情里都有「交给本机 agent 执行」下拉
     （本机派单与任务后端正交，见 lib/integrations/acp-lane.ts） */
  const [runnerAgents, setRunnerAgents] = useState<RunnerAgentInfo[]>([]);
  const [runnerDefault, setRunnerDefault] = useState<string | null>(null);
  const loadRunner = useCallback(() => {
    if (!backend) return;
    api
      .runnerSettings()
      .then((payload) => {
        setRunnerAgents(payload.settings.agents);
        setRunnerDefault(payload.settings.defaultAgentId);
      })
      .catch(() => undefined);
  }, [backend]);
  useEffect(() => {
    loadRunner();
  }, [loadRunner]);

  const loadLocal = useCallback(async () => {
    try {
      const result = await api.listIssues({ board: boardFilter || null, status: lens, q: keyword });
      setIssues(result.issues);
      setCounts(result.counts);
      setError("");
      return result.issues;
    } catch (err) {
      setError((err as Error).message);
      return [];
    }
  }, [boardFilter, lens, keyword]);

  useEffect(() => {
    if (backend !== "local") return;
    void loadLocal().then((list) => {
      // 深链选中：只认一次，之后跟着用户点
      const want = wantIssueRef.current;
      if (want && list.some((item) => item.id === want)) setSelectedId(want);
      wantIssueRef.current = null;
    });
  }, [backend, loadLocal]);

  /* 轻量轮询：agent 回写状态要能不动手就看到 */
  useEffect(() => {
    if (backend !== "local") return;
    const timer = setInterval(() => void loadLocal(), 15_000);
    return () => clearInterval(timer);
  }, [backend, loadLocal]);

  useEffect(() => {
    if (backend !== "local" || !selectedId) {
      setDetail(null);
      return;
    }
    let alive = true;
    api
      .getIssue(selectedId)
      .then((payload) => alive && setDetail(payload))
      .catch((err: Error) => alive && showToast(err.message));
    return () => {
      alive = false;
    };
  }, [backend, selectedId, issues, showToast]);

  async function patchStatus(issueId: string, status: string, doneKey: DictKey) {
    setBusy(true);
    try {
      await api.patchLocalIssue(issueId, { status });
      showToast(t(doneKey));
      await loadLocal();
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyPrompt(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t("pages.tasks.toast.copied"));
    } catch {
      showToast(t("pages.tasks.toast.copyFailed"));
    }
  }

  /* ── goal-agent / http 模式的数据（聚合镜像） ────── */
  const [tasks, setTasks] = useState<TaskIndexItem[] | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskIndexItem | null>(null);
  const [liveTask, setLiveTask] = useState<LiveTaskInfo | null>(null);
  const [liveIssue, setLiveIssue] = useState<any>(null);

  const loadTasks = useCallback(async () => {
    try {
      const list = await api.taskIndex();
      setTasks(list);
      setError("");
      return list;
    } catch (err) {
      setError((err as Error).message);
      return [];
    }
  }, []);

  useEffect(() => {
    if (backend === "local" || !backend) return;
    void loadTasks().then((list) => {
      const want = wantIssueRef.current;
      if (want) {
        // 深链兼收三种写法：issueId（agent 回报链接）、cardId、boardId:cardId（本页自己写回地址栏的形状）
        const hit = list.find(
          (item) => `${item.boardId}:${item.card.id}` === want || item.card.task?.issueId === want || item.card.id === want,
        );
        if (hit) setSelectedId(`${hit.boardId}:${hit.card.id}`);
      }
      wantIssueRef.current = null;
    });
  }, [backend, loadTasks]);

  const remoteVisible = useMemo(() => {
    if (backend === "local") return [];
    const key = keyword.toLowerCase();
    return (tasks || [])
      .filter((item) => {
        if (boardFilter && item.boardId !== boardFilter) return false;
        // 「本机执行」是一个横切镜头（按执行者筛），不是任务状态里的第五档
        if (lens === LOCAL_RUN_LENS) {
          if (!isLocalRunId(item.card.task?.taskId)) return false;
        } else if (lens !== "all" && (item.card.task?.status || "idea") !== lens) return false;
        if (!key) return true;
        return [item.card.title, item.card.content, item.card.task?.goal, item.card.task?.issueNumber, item.boardName]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(key);
      })
      .sort((a, b) => (b.card.updatedAt || 0) - (a.card.updatedAt || 0));
  }, [backend, tasks, boardFilter, lens, keyword]);

  /** 远程模式的镜头计数（board + 关键词收窄之后、状态筛选之前——与 local 的口径一致） */
  const remoteCounts = useMemo(() => {
    if (backend === "local") return {} as Record<string, number>;
    const key = keyword.toLowerCase();
    const pool = (tasks || []).filter((item) => {
      if (boardFilter && item.boardId !== boardFilter) return false;
      if (!key) return true;
      return [item.card.title, item.card.content, item.card.task?.goal, item.card.task?.issueNumber, item.boardName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(key);
    });
    const result: Record<string, number> = { all: pool.length, idea: 0, issued: 0, running: 0, done: 0, [LOCAL_RUN_LENS]: 0 };
    for (const item of pool) {
      result[item.card.task?.status || "idea"] += 1;
      if (isLocalRunId(item.card.task?.taskId)) result[LOCAL_RUN_LENS] += 1;
    }
    return result;
  }, [backend, tasks, boardFilter, keyword]);

  useEffect(() => {
    if (backend === "local" || !selectedId) {
      setSelectedTask(null);
      return;
    }
    const [boardId, cardId] = selectedId.split(":");
    setSelectedTask((tasks || []).find((item) => item.boardId === boardId && item.card.id === cardId) || null);
  }, [backend, selectedId, tasks]);

  useEffect(() => {
    setLiveTask(null);
    setLiveIssue(null);
    if (backend === "local" || !selectedTask) return;
    let alive = true;
    const taskId = selectedTask.card.task?.taskId;
    const issueId = selectedTask.card.task?.issueId;
    if (taskId) {
      api
        .runnerTask(taskId)
        .then((payload) => {
          if (!alive) return;
          const task = payload.task || payload;
          setLiveTask({
            status: task.status || "unknown",
            summary: task.summary || "",
            updatedAt: task.updatedAt || null,
            // 本机 ACP run 才有这几样：kind=acp、执行台账的 issueId、agent 名字
            kind: task.kind || "prompt",
            agentName: task.agentName || null,
            ledgerIssueId: task.issueId || null,
            mode: task.mode || null,
          });
        })
        .catch(() => undefined);
    }
    if (issueId) {
      api
        .runnerIssue(issueId)
        .then((payload) => alive && setLiveIssue(payload.issue || payload))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [backend, selectedTask]);

  /* ── 渲染 ─────────────────────────────────────── */

  const local = backend === "local";
  const lenses: { key: string; label: string; count: number }[] = local
    ? LOCAL_LENSES.map((item) => ({ key: item.key, label: t(item.labelKey), count: counts[item.key] ?? 0 }))
    : [
        { key: "all", label: t("pages.tasks.lens.all"), count: remoteCounts.all ?? 0 },
        ...TASK_COLUMNS.map((status) => ({ key: status, label: t(STATUS_META[status]), count: remoteCounts[status] ?? 0 })),
        // 按「谁在执行」切一刀：跑在本机的那些，进展与权限确认都在这一页里，值得单独一眼
        { key: LOCAL_RUN_LENS, label: t("pages.tasks.lens.localAcp"), count: remoteCounts[LOCAL_RUN_LENS] ?? 0 },
      ];

  const listEmptyText = keyword || boardFilter ? t("pages.tasks.emptyFiltered") : t("pages.tasks.empty");

  return (
    <div className="app nav-app tasks-app">
      <header className="topbar">
        <Link className="top-btn icon-only" href="/" title={t("pages.nav.back")} aria-label={t("pages.nav.back")}>
          <UI.back {...ICON_MD} />
        </Link>
        <div className="brand">
          {t("pages.tasks.brand")}
          <span className="beta">{local ? t("pages.tasks.mode.local") : t("pages.tasks.mode.mirror")}</span>
        </div>
        {/* 五个页面同一副导航（真源 components/SiteNav.tsx） */}
        <SiteNav current="tasks" />
        <div className={`nav-search${query ? " active" : ""}`}>
          <UI.search size={14} strokeWidth={1.9} />
          <input
            value={query}
            placeholder={local ? t("pages.tasks.search.local") : t("pages.tasks.search.remote")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                (event.target as HTMLInputElement).blur();
              }
            }}
          />
          {query ? (
            <button className="nav-search-clear" title={t("pages.tasks.search.clear")} onClick={() => setQuery("")}>
              <UI.close size={12} strokeWidth={2} />
            </button>
          ) : null}
        </div>
        <div className="spacer" />
        {!local ? (
          <span className="tk-mirror-hint" title={t("pages.tasks.mirrorHint.title")}>
            {t("pages.tasks.mirrorHint")}
          </span>
        ) : null}
        <button
          className={`top-btn${showSettings ? " active" : ""}`}
          title={t("pages.tasks.settings.title")}
          onClick={() => setShowSettings((value) => !value)}
        >
          <UI.settings {...ICON_MD} /> {t("pages.tasks.settings")}
        </button>
        <button
          className="top-btn icon-only"
          title={t("pages.tasks.refresh.title")}
          aria-label={t("pages.tasks.refresh")}
          onClick={() => void (local ? loadLocal() : loadTasks())}
        >
          <UI.refresh {...ICON_MD} />
        </button>
      </header>

      <div className="main nav-main">
        {/* ── 左栏：镜头 + 画板收窄 ── */}
        <aside className="nav-side tk-side">
          <div className="nav-side-head">{t("pages.tasks.lenses")}</div>
          <div className="nav-side-list">
            {lenses.map((item) => (
              <button
                key={item.key}
                className={`nav-scope tk-lens${lens === item.key ? " active" : ""}`}
                onClick={() => setLens(item.key)}
              >
                <span className="ns-line">
                  <i className="tk-dot" style={{ background: LENS_DOT[item.key] || STATUS_DOT[item.key as TaskStatus] || "#a6abaf" }} />
                  <span className="ns-name">{item.label}</span>
                  <span className="aside-count">{item.count}</span>
                </span>
              </button>
            ))}
            <div className="nav-side-head">{t("pages.tasks.boards")}</div>
            <select
              className="tk-board-select"
              value={boardFilter}
              onChange={(event) => setBoardFilter(event.target.value)}
              title={t("pages.tasks.boards.title")}
            >
              <option value="">{t("pages.tasks.boards.all")}</option>
              {boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.name}
                </option>
              ))}
            </select>
            {local ? (
              <div className="tk-side-note">{t("pages.tasks.note.local")}</div>
            ) : (
              <div className="tk-side-note">{t("pages.tasks.note.mirror")}</div>
            )}
          </div>
        </aside>

        {/* ── 中栏：Issue / 任务列表 ── */}
        <section className="tk-list">
          {error ? <div className="nav-error">{error}</div> : null}
          {!backend || (local ? issues === null : tasks === null) ? (
            <div className="nav-empty big">{t("pages.tasks.loading")}</div>
          ) : local ? (
            issues!.length ? (
              issues!.map((issue) => (
                <button
                  key={issue.id}
                  className={`tk-row${selectedId === issue.id ? " active" : ""}`}
                  onClick={() => setSelectedId(issue.id)}
                >
                  <div className="tk-row-head">
                    <span className="tk-number mono">{issue.number}</span>
                    <span className={`tk-chip st-${issue.lens}`}>
                      <i className="tk-dot" style={{ background: LENS_DOT[issue.lens] }} />
                      {issueStatusLabel(issue.status, t)}
                    </span>
                    {issue.orphan ? <span className="tk-chip orphan">{t("pages.tasks.orphanChip")}</span> : null}
                    <span className="tk-time">{relTime(issue.updatedAt, t)}</span>
                  </div>
                  <div className="tk-row-title">{issue.title}</div>
                  <div className="tk-row-meta">
                    {issue.boardName ? `${issue.boardName}${issue.cardTitle ? ` · ${issue.cardTitle}` : ""}` : t("pages.tasks.noSourceCard")}
                    {issue.runCount ? t("pages.tasks.runCount", { count: issue.runCount }) : ""}
                  </div>
                </button>
              ))
            ) : (
              <div className="nav-empty big">{listEmptyText}</div>
            )
          ) : remoteVisible.length ? (
            remoteVisible.map((item) => {
              const key = `${item.boardId}:${item.card.id}`;
              const status = (item.card.task?.status || "idea") as TaskStatus;
              const Icon = STATUS_ICON[status];
              return (
                <button key={key} className={`tk-row${selectedId === key ? " active" : ""}`} onClick={() => setSelectedId(key)}>
                  <div className="tk-row-head">
                    {item.card.task?.issueNumber ? (
                      <span className="tk-number mono">{item.card.task.issueNumber}</span>
                    ) : null}
                    <span className={`tk-chip st-${status}`}>
                      <Icon size={11} strokeWidth={2} style={{ color: STATUS_DOT[status] }} />
                      {t(STATUS_META[status])}
                    </span>
                    <span className="tk-time">{relTime(item.card.updatedAt || item.card.createdAt, t)}</span>
                  </div>
                  <div className="tk-row-title">{item.card.title || t("pages.tasks.untitled")}</div>
                  <div className="tk-row-meta">
                    {item.boardName}
                    {isLocalRunId(item.card.task?.taskId) ? (
                      <span className="tk-chip acp">{t("pages.tasks.localAcp.chip")}</span>
                    ) : null}
                  </div>
                </button>
              );
            })
          ) : (
            <div className="nav-empty big">{listEmptyText}</div>
          )}
        </section>

        {/* ── 右栏：详情 / Runner 设置 ── */}
        <section className="tk-detail">
          {showSettings && backend ? (
            <RunnerSettingsPanel backend={backend} onChanged={loadRunner} />
          ) : local ? (
            detail ? (
              <LocalDetail
                detail={detail}
                busy={busy}
                agents={runnerAgents}
                defaultAgentId={runnerDefault}
                onCopyPrompt={copyPrompt}
                onPatchStatus={patchStatus}
                onRefresh={() => void loadLocal()}
                showToast={showToast}
              />
            ) : (
              <div className="nav-empty big">{t("pages.tasks.pickIssue")}</div>
            )
          ) : selectedTask ? (
            <RemoteDetail
              item={selectedTask}
              live={liveTask}
              issue={liveIssue}
              agents={runnerAgents}
              defaultAgentId={runnerDefault}
              onRefresh={loadTasks}
              showToast={showToast}
            />
          ) : (
            <div className="nav-empty big">{t("pages.tasks.pickTask")}</div>
          )}
        </section>
      </div>
      {toast ? <div className="toast show">{toast}</div> : null}
    </div>
  );
}

/* ── local 详情 ───────────────────────────────────── */

function LocalDetail({
  detail,
  busy,
  agents,
  defaultAgentId,
  onCopyPrompt,
  onPatchStatus,
  onRefresh,
  showToast,
}: {
  detail: { issue: LocalIssueItem; prompt: string };
  busy: boolean;
  agents: RunnerAgentInfo[];
  defaultAgentId: string | null;
  onCopyPrompt: (text: string) => void;
  onPatchStatus: (issueId: string, status: string, doneKey: DictKey) => void;
  onRefresh: () => void;
  showToast: (text: string) => void;
}) {
  const t = useT();
  const { issue, prompt } = detail;
  const [showLog, setShowLog] = useState(false);
  const [agentPick, setAgentPick] = useState("");
  const [launching, setLaunching] = useState(false);
  const closed = issue.status === "done" || issue.status === "aborted" || issue.status === "parked";
  // 有 run 还在跑 / 等人：并发闸在服务端（409），这里先把按钮收起来别引人撞墙
  const hasActiveRun = issue.runs.some((run) => run.status === "running" || run.status === "waiting");
  const pickedAgent = agentPick || defaultAgentId || agents[0]?.id || "";

  /** ACP 派单：把这条 Issue 交给注册的 agent 真跑一轮 */
  async function launchWithAgent() {
    if (!pickedAgent) return;
    setLaunching(true);
    try {
      await api.launchIssue(issue.id, { mode: "implement", agentId: pickedAgent });
      showToast(t("pages.tasks.toast.launched"));
      onRefresh();
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setLaunching(false);
    }
  }
  return (
    <div className="tk-detail-body">
      <div className="tk-detail-head">
        <span className="tk-number mono">{issue.number}</span>
        <span className={`tk-chip st-${issue.lens}`}>
          <i className="tk-dot" style={{ background: LENS_DOT[issue.lens] }} />
          {issueStatusLabel(issue.status, t)}
        </span>
        {issue.priority && issue.priority !== "none" ? (
          <span className="tk-chip">{t("pages.tasks.priority", { label: priorityLabel(issue.priority, t) })}</span>
        ) : null}
        {issue.orphan ? <span className="tk-chip orphan">{t("pages.tasks.orphanChip.detail")}</span> : null}
      </div>
      <h1 className="tk-title">{issue.title}</h1>
      {issue.labels.length ? (
        <div className="tk-labels">
          {issue.labels.map((label) => (
            <span key={label} className="issue-label">
              {label}
            </span>
          ))}
        </div>
      ) : null}

      <div className="tk-actions">
        <button className="mini-btn primary" onClick={() => onCopyPrompt(prompt)}>
          <UI.copy {...ICON_SM} /> {t("pages.tasks.copyPrompt")}
        </button>
        {!closed ? (
          <>
            <button className="mini-btn" disabled={busy} onClick={() => onPatchStatus(issue.id, "done", "pages.tasks.toast.markedDone")}>
              <UI.check {...ICON_SM} /> {t("pages.tasks.markDone")}
            </button>
            <button className="mini-btn" disabled={busy} onClick={() => onPatchStatus(issue.id, "aborted", "pages.tasks.toast.aborted")}>
              <UI.ban {...ICON_SM} /> {t("pages.tasks.abort")}
            </button>
          </>
        ) : (
          <button className="mini-btn" disabled={busy} onClick={() => onPatchStatus(issue.id, "pending", "pages.tasks.toast.reopened")}>
            <UI.undo {...ICON_SM} /> {t("pages.tasks.reopen")}
          </button>
        )}
        {issue.boardId && !issue.orphan ? (
          <a
            className="mini-btn"
            href={`/?board=${encodeURIComponent(issue.boardId)}${issue.cardId ? `&card=${encodeURIComponent(issue.cardId)}` : ""}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <UI.external {...ICON_SM} /> {t("pages.tasks.backToCard")}
          </a>
        ) : null}
      </div>

      {/* ACP 派单：注册过 agent 才出现（没配走上面的复制 prompt，一个字不变） */}
      {agents.length && !closed ? (
        <div className="tk-actions tk-acp-launch">
          <select
            className="tk-agent-select"
            value={pickedAgent}
            onChange={(event) => setAgentPick(event.target.value)}
            title={t("pages.tasks.agentSelect.title")}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <button
            className="mini-btn primary"
            disabled={launching || hasActiveRun || !pickedAgent}
            title={hasActiveRun ? t("pages.tasks.launch.busy.title") : t("pages.tasks.launch.title")}
            onClick={() => void launchWithAgent()}
          >
            <UI.run {...ICON_SM} /> {launching ? t("pages.tasks.launching") : hasActiveRun ? t("pages.tasks.runActive") : t("pages.tasks.launch")}
          </button>
        </div>
      ) : null}

      <div className="td-label">{t("pages.tasks.description")}</div>
      <div className="tk-desc">
        <Markdown text={issue.description || t("pages.tasks.description.empty")} />
      </div>

      <div className="td-label">{t("pages.tasks.runs")}{issue.runs.length ? ` · ${issue.runs.length}` : ""}</div>
      {issue.runs.length ? (
        <div className="tk-runs">
          {[...issue.runs].reverse().map((run) => (
            <div className="tk-run" key={run.id}>
              <div className="tk-run-head">
                <span className={`tk-chip run-${run.status}`}>{runnerStatusLabel(run.status, t)}</span>
                {run.kind === "acp" ? <span className="tk-chip acp">ACP · {run.agentName || run.agentId}</span> : null}
                <span className="tk-run-mode mono">{run.mode}</span>
                <span className="tk-time">{formatTime(run.updatedAt)}</span>
                {run.kind === "acp" && (run.status === "running" || run.status === "waiting") ? (
                  <button
                    className="mini-btn"
                    disabled={busy}
                    title={t("pages.tasks.run.abort.title")}
                    onClick={async () => {
                      try {
                        await api.patchLocalRun(issue.id, run.id, { status: "aborted" });
                        showToast(t("pages.tasks.toast.aborted"));
                        onRefresh();
                      } catch (err) {
                        showToast((err as Error).message);
                      }
                    }}
                  >
                    <UI.ban {...ICON_SM} /> {t("pages.tasks.abort")}
                  </button>
                ) : null}
                {run.prompt ? (
                  <button className="mini-btn" onClick={() => onCopyPrompt(run.prompt!)}>
                    <UI.copy {...ICON_SM} /> {t("pages.tasks.run.copyPrompt")}
                  </button>
                ) : null}
              </div>
              {run.note ? <div className="tk-run-note">{run.note}</div> : null}
              {run.kind === "acp" ? (
                <AcpRunView issueId={issue.id} run={run} onRefresh={onRefresh} showToast={showToast} />
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="config-hint">{t("pages.tasks.runs.empty")}</div>
      )}

      <button className="tk-log-toggle" onClick={() => setShowLog((value) => !value)}>
        <UI.chevron size={13} strokeWidth={2} style={{ transform: showLog ? "rotate(180deg)" : undefined }} />
        {t("pages.tasks.log", { count: issue.log.length })}
      </button>
      {showLog ? (
        <div className="tk-log">
          {[...issue.log].reverse().map((entry, index) => (
            <div className="tk-log-row" key={index}>
              <span className="tk-time">{formatTime(entry.at)}</span>
              <span className="mono">{entry.event}</span>
              {entry.detail ? <span className="tk-log-detail">{entry.detail}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── ACP run：流式 transcript + 权限确认（local 专属） ── */

/** transcript 条目 → 可读块（连续的消息 / 思考块合并成一段，别一行一行碎着） */
function transcriptBlocks(entries: { at: number; type: string; [key: string]: unknown }[], t: Translate) {
  const blocks: { key: number; kind: string; label: string | null; text: string }[] = [];
  let seq = 0;
  const push = (kind: string, label: string | null, text: string) => {
    const last = blocks[blocks.length - 1];
    if (last && (kind === "message" || kind === "thought") && last.kind === kind) {
      last.text += text;
      return;
    }
    blocks.push({ key: seq++, kind, label, text });
  };
  for (const entry of entries as any[]) {
    if (entry.type === "update") {
      const update = entry.update || {};
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          push("message", null, String(update.content?.text ?? ""));
          break;
        case "agent_thought_chunk":
          push("thought", t("pages.tasks.tr.thought"), String(update.content?.text ?? ""));
          break;
        case "plan":
          push(
            "meta",
            t("pages.tasks.tr.plan"),
            (Array.isArray(update.entries) ? update.entries : [])
              .map((item: any) => `${item.status === "completed" ? "✓" : item.status === "in_progress" ? "▸" : "·"} ${item.content}`)
              .join("　"),
          );
          break;
        case "tool_call":
        case "tool_call_update":
          push("meta", t("pages.tasks.tr.tool"), `${update.title || update.toolCallId || ""}${update.status ? `（${update.status}）` : ""}`);
          break;
        default:
          if (update.sessionUpdate) push("meta", null, String(update.sessionUpdate));
      }
    } else if (entry.type === "status") {
      push("meta", null, `· ${entry.status}${entry.detail ? ` — ${entry.detail}` : ""}`);
    } else if (entry.type === "permission_request") {
      push("meta", t("pages.tasks.tr.permission"), t("pages.tasks.tr.permissionRequest", { title: entry.title }));
    } else if (entry.type === "permission_decision") {
      push(
        "meta",
        t("pages.tasks.tr.permission"),
        `${t("pages.tasks.tr.decided", { option: entry.optionId ?? t("common.cancel") })}${entry.auto ? t("pages.tasks.tr.auto") : ""}`,
      );
    } else if (entry.type === "stderr") {
      push("meta", "stderr", String(entry.text ?? ""));
    }
  }
  return blocks;
}

function AcpRunView({
  issueId,
  run,
  onRefresh,
  showToast,
}: {
  issueId: string;
  run: LocalIssueRunInfo;
  onRefresh: () => void;
  showToast: (text: string) => void;
}) {
  const t = useT();
  const runActive = run.status === "running" || run.status === "waiting";
  const [expanded, setExpanded] = useState(runActive);
  const [entries, setEntries] = useState<{ at: number; type: string; [key: string]: unknown }[]>([]);
  const [live, setLive] = useState<LocalIssueRunInfo["permissionRequest"] | null>(run.permissionRequest || null);
  const [deciding, setDeciding] = useState(false);
  const offsetRef = useRef(0);
  const statusRef = useRef(run.status);

  /* 选中别的 Issue 时组件会被复用：换 run 就清空重来 */
  useEffect(() => {
    setEntries([]);
    offsetRef.current = 0;
    setLive(null);
    statusRef.current = "";
    setExpanded(runActive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  /* 展开时轮询增量 transcript（沿现有轮询节奏，不上 SSE）；run 到终态后停 */
  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const page = await api.runTranscript(issueId, run.id, offsetRef.current);
        if (!alive) return;
        if (page.entries.length) setEntries((prev) => [...prev, ...page.entries]);
        offsetRef.current = page.offset;
        setLive(page.run.permissionRequest || null);
        if (statusRef.current && page.run.status !== statusRef.current) onRefresh();
        statusRef.current = page.run.status;
        const stillActive = page.run.status === "running" || page.run.status === "waiting";
        if (!stillActive && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch {
        /* 网络抖动：下一轮再来 */
      }
    };
    void tick();
    timer = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, issueId, run.id]);

  async function decide(optionId: string, name: string) {
    setDeciding(true);
    try {
      await api.resolveRunPermission(issueId, run.id, optionId);
      showToast(t("pages.tasks.toast.decided", { name }));
      setLive(null);
      onRefresh();
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setDeciding(false);
    }
  }

  const permission = live || run.permissionRequest || null;
  const blocks = transcriptBlocks(entries, t);

  return (
    <div className="tk-acp">
      {permission && run.status === "waiting" ? (
        <div className="tk-permission">
          <div className="tk-permission-title">{t("pages.tasks.permission.waiting", { title: permission.title })}</div>
          <div className="tk-actions">
            {permission.options.map((option) => (
              <button
                key={option.optionId}
                className={`mini-btn${option.kind.startsWith("allow") ? " primary" : ""}`}
                disabled={deciding}
                onClick={() => void decide(option.optionId, option.name)}
              >
                {option.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <button className="tk-log-toggle" onClick={() => setExpanded((value) => !value)}>
        <UI.chevron size={13} strokeWidth={2} style={{ transform: expanded ? "rotate(180deg)" : undefined }} />
        {t("pages.tasks.transcript")}{entries.length ? t("pages.tasks.transcript.count", { count: entries.length }) : ""}
      </button>
      {expanded ? (
        <div className="tk-transcript">
          {blocks.length ? (
            blocks.map((block) => (
              <div key={block.key} className={`tk-tr tk-tr-${block.kind}`}>
                {block.label ? <span className="tk-tr-label">{block.label}</span> : null}
                <span className="tk-tr-text">{block.text}</span>
              </div>
            ))
          ) : (
            <div className="config-hint">{runActive ? t("pages.tasks.transcript.waiting") : t("pages.tasks.transcript.empty")}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ── goal-agent / http 详情（聚合镜像） ─────────────── */

function RemoteDetail({
  item,
  live,
  issue,
  agents,
  defaultAgentId,
  onRefresh,
  showToast,
}: {
  item: TaskIndexItem;
  live: LiveTaskInfo | null;
  issue: any;
  agents: RunnerAgentInfo[];
  defaultAgentId: string | null;
  onRefresh: () => void;
  showToast: (text: string) => void;
}) {
  const t = useT();
  const card = item.card;
  const status = (card.task?.status || "idea") as TaskStatus;
  const Icon = STATUS_ICON[status];
  const taskId = card.task?.taskId || null;
  const issueId = card.task?.issueId || null;
  const [agentPick, setAgentPick] = useState("");
  const [launching, setLaunching] = useState(false);
  const pickedAgent = agentPick || defaultAgentId || agents[0]?.id || "";
  // 本机 run 的身份只有轮询回来的 live 说得准（taskId 前缀先筛一道，省一次无谓渲染）
  const localRun = isLocalRunId(taskId) && live?.kind === "acp" ? live : null;
  const localBusy = localRun ? localRun.status === "running" || localRun.status === "waiting" : false;

  /** 派给本机注册的 ACP agent 跑一轮（Issue 真源仍在对端，见 lib/integrations/acp-lane.ts） */
  async function launchLocal() {
    if (!pickedAgent) return;
    setLaunching(true);
    try {
      await api.launchCard(item.boardId, card.id, "implement", pickedAgent);
      showToast(t("pages.tasks.toast.launched"));
      onRefresh();
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setLaunching(false);
    }
  }
  return (
    <div className="tk-detail-body">
      <div className="tk-detail-head">
        {card.task?.issueNumber ? <span className="tk-number mono">{card.task.issueNumber}</span> : null}
        <span className={`tk-chip st-${status}`}>
          <Icon size={11} strokeWidth={2} style={{ color: STATUS_DOT[status] }} />
          {t(STATUS_META[status])}
        </span>
        {card.task?.priority && card.task.priority !== "none" ? (
          <span className="tk-chip">{t("pages.tasks.priority", { label: t(PRIORITIES[card.task.priority]) })}</span>
        ) : null}
      </div>
      <h1 className="tk-title">{card.title || t("pages.tasks.untitled")}</h1>
      <div className="tk-row-meta">{t("pages.tasks.source", { name: item.boardName })}</div>

      <div className="tk-actions">
        <a
          className="mini-btn primary"
          href={`/?board=${encodeURIComponent(item.boardId)}&card=${encodeURIComponent(card.id)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <UI.external {...ICON_SM} /> {t("pages.tasks.backToCard")}
        </a>
        {goalAgentOrigin() && issueId ? (
          <a
            className="mini-btn"
            href={`${goalAgentOrigin()}/?issue=${encodeURIComponent(issueId)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <UI.external {...ICON_SM} /> {t("pages.tasks.openMain")}
          </a>
        ) : null}
      </div>

      {card.content || card.task?.goal ? (
        <>
          <div className="td-label">{t("pages.tasks.content")}</div>
          <div className="tk-desc">
            <Markdown text={card.content || card.task?.goal || ""} />
          </div>
        </>
      ) : null}

      <div className="td-label">{t("pages.tasks.issueState")}</div>
      <div className="tk-runs">
        {issue ? (
          <div className="tk-run">
            <div className="tk-run-head">
              <span className="tk-chip">{t("pages.tasks.issueChip", { status: issueStatusLabel(issue.status, t) })}</span>
              {(issue.labels || []).map((label: string) => (
                <span key={label} className="issue-label">
                  {label}
                </span>
              ))}
            </div>
          </div>
        ) : issueId ? (
          <div className="config-hint">{t("pages.tasks.issue.loading")}</div>
        ) : (
          <div className="config-hint">{t("pages.tasks.issue.none")}</div>
        )}
        {live ? (
          <div className="tk-run">
            <div className="tk-run-head">
              <span className={`tk-chip run-${live.status}`}>{runnerStatusLabel(live.status, t)}</span>
              {localRun ? (
                <span className="tk-chip acp">{t("pages.tasks.localAcp.by", { agent: localRun.agentName || "ACP" })}</span>
              ) : null}
              {live.updatedAt ? <span className="tk-time">{formatTime(live.updatedAt)}</span> : null}
              <span className="mono tk-run-mode">{taskId}</span>
            </div>
            {live.summary ? <div className="tk-run-note">{live.summary}</div> : null}
          </div>
        ) : taskId ? (
          <div className="config-hint">{t("pages.tasks.task.loading")}</div>
        ) : (
          <div className="config-hint">{t("pages.tasks.task.none")}</div>
        )}
      </div>

      {/* 本机执行：与上面的「外部 Runner 执行状态」并列的第二条路。
          流式 transcript / 权限确认 / 中止都只在这一块里——那是外部 Runner 给不了的部分。 */}
      <div className="td-label">{t("pages.tasks.localAcp")}</div>
      <div className="config-hint">{t("pages.tasks.localAcp.hint")}</div>
      {!issueId ? (
        <div className="config-hint">{t("pages.tasks.localAcp.needIssue")}</div>
      ) : !agents.length ? (
        <div className="config-hint">{t("pages.tasks.localAcp.noAgent")}</div>
      ) : (
        <div className="tk-actions">
          <select
            className="tk-select"
            value={pickedAgent}
            onChange={(event) => setAgentPick(event.target.value)}
            title={t("pages.tasks.agentSelect.title")}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <button
            className="mini-btn primary"
            disabled={launching || localBusy || !pickedAgent}
            title={localBusy ? t("pages.tasks.localAcp.busy.title") : t("pages.tasks.localAcp.hint")}
            onClick={() => void launchLocal()}
          >
            <UI.run {...ICON_SM} />{" "}
            {launching
              ? t("pages.tasks.localAcp.launching")
              : localBusy
                ? t("pages.tasks.localAcp.busy")
                : t("pages.tasks.localAcp.launch")}
          </button>
        </div>
      )}
      {localRun && localRun.ledgerIssueId && taskId ? (
        <div className="tk-runs">
          <div className="tk-run">
            <div className="tk-run-head">
              <span className={`tk-chip run-${localRun.status}`}>{runnerStatusLabel(localRun.status, t)}</span>
              <span className="tk-chip acp">{t("pages.tasks.localAcp.by", { agent: localRun.agentName || "ACP" })}</span>
              {localRun.mode ? <span className="tk-run-mode mono">{localRun.mode}</span> : null}
              {localRun.updatedAt ? <span className="tk-time">{formatTime(localRun.updatedAt)}</span> : null}
              {localBusy ? (
                <button
                  className="mini-btn"
                  title={t("pages.tasks.run.abort.title")}
                  onClick={async () => {
                    try {
                      await api.patchLocalRun(localRun.ledgerIssueId!, taskId, { status: "aborted" });
                      showToast(t("pages.tasks.toast.aborted"));
                      onRefresh();
                    } catch (err) {
                      showToast((err as Error).message);
                    }
                  }}
                >
                  <UI.ban {...ICON_SM} /> {t("pages.tasks.abort")}
                </button>
              ) : null}
            </div>
            <AcpRunView
              issueId={localRun.ledgerIssueId}
              run={{
                id: taskId,
                status: localRun.status as any,
                note: localRun.summary || null,
                kind: "acp",
                agentName: localRun.agentName,
                mode: (localRun.mode as any) || "implement",
                updatedAt: localRun.updatedAt || Date.now(),
                launchedAt: localRun.updatedAt || Date.now(),
                prompt: "",
                permissionRequest: null,
              }}
              onRefresh={onRefresh}
              showToast={showToast}
            />
          </div>
        </div>
      ) : issueId && agents.length ? (
        <div className="config-hint">{t("pages.tasks.localAcp.none")}</div>
      ) : null}

      <div className="tk-side-note">{t("pages.tasks.mirrorNote")}</div>
    </div>
  );
}
