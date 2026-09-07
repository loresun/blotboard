"use client";

/**
 * 画板应用外壳：启动加载、轮询节奏、卡片动作、上传/粘贴，以及各面板的组装。
 */
import { boardInputBlocked, isEditableTarget } from "@/lib/keyboard-shortcuts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { BoardCanvas } from "./BoardCanvas";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { SearchBar } from "./SearchBar";
import { OutlineView } from "./OutlineView";
import { TopBar } from "./TopBar";
import { Toast } from "./Toast";
import { AgentDrawer } from "./panels/AgentDrawer";
import { CardDrawer } from "./panels/CardDrawer";
import { CommentDrawer } from "./panels/CommentDrawer";
import { HistoryDrawer } from "./panels/HistoryDrawer";
import { AidocsDrawer } from "./panels/AidocsDrawer";
import { BookDrawer } from "./panels/BookDrawer";
import { TemplateDrawer } from "./panels/TemplateDrawer";
import { SpecDrawer } from "./panels/SpecDrawer";
import { MindmapModal } from "./panels/MindmapModal";
import { ExcalidrawModal } from "./panels/ExcalidrawModal";
import { TaskDrawer } from "./panels/TaskDrawer";
import { SettingsDrawer } from "./panels/SettingsDrawer";
import { PdfModal } from "./panels/PdfModal";
import { ReaderModal } from "./panels/ReaderModal";
import { CompareModal } from "./panels/CompareModal";
import type { CardAction } from "./cards/CardBody";
import { api } from "@/lib/api-client";
import { POLL_AGENT_MS, POLL_FAST_MS, POLL_SLOW_MS } from "@/lib/constants";
import { parseCardClipboard } from "@/lib/card-clipboard";
import { UPLOAD_ACCEPT, cardTypeForUploadKind, uploadFormatFor } from "@/lib/upload-accept";
import { taskBackendKind, useFeatures } from "@/lib/features-client";
import { tr } from "@/lib/i18n/client";
import { hydrateUiPrefs, lastBoardId, useBoardStore } from "@/lib/store";
import { installBrowserAgentBridge } from "@/lib/browser-agent-bridge";
import { BROWSER_STORAGE_CHANGED } from "@/lib/browser-board-repository";
import { browserStorageActive, browserWorkspace, persistStorageChoice, storageMode } from "@/lib/storage-mode";
import { StorageModePanel } from "./StorageModePanel";
import type { BoardCard } from "@/lib/types";

export function BoardApp() {
  return (
    <ReactFlowProvider>
      <BoardAppInner />
    </ReactFlowProvider>
  );
}

function BoardAppInner() {
  const flow = useReactFlow();
  const drawer = useBoardStore((state) => state.drawer);
  const agentRun = useBoardStore((state) => state.agentRun);
  const loadError = useBoardStore((state) => state.loadError);
  // 可选集成没配就不挂对应面板：入口按钮已经不渲染了，这里是第二道闸
  //（防的是任何遗漏的 setDrawer 调用把用户带进一个只会报错的抽屉）
  const features = useFeatures();

  useEffect(() => installBrowserAgentBridge(), []);

  useEffect(() => {
    persistStorageChoice(storageMode(), browserWorkspace());
  }, []);

  useEffect(() => {
    if (!browserStorageActive()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ workspace?: string; boardId?: string | null }>).detail;
      if (detail?.workspace && detail.workspace !== browserWorkspace()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const state = useBoardStore.getState();
        const boards = await state.loadBoards().catch(() => []);
        const current = useBoardStore.getState().boardId;
        if (current && boards.some((board) => board.id === current)) {
          if (!detail?.boardId || detail.boardId === current) await useBoardStore.getState().refreshBoard().catch(() => undefined);
        } else if (boards[0]) {
          await useBoardStore.getState().openBoard(boards[0].id).catch(() => undefined);
        }
      }, 40);
    };
    window.addEventListener(BROWSER_STORAGE_CHANGED, refresh);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener(BROWSER_STORAGE_CHANGED, refresh);
    };
  }, []);

  /* ── 启动：深链 > 上次打开 > 第一块 ── */
  useEffect(() => {
    hydrateUiPrefs();
    const state = useBoardStore.getState();
    // 规格表：画板上只要有一张规格卡就要用它渲染，所以跟画板一起拉（失败不阻塞）
    void state.loadSpecs();
    // 卡片包开关：工具条显隐靠它（失败不阻塞，维持全显示）
    void state.loadCardPacks();
    (async () => {
      try {
        const boards = await state.loadBoards();
        // ?board=b_xxx&card=c_xxx 直接定位（分享链接 / agent 回传链接用）
        const params = new URLSearchParams(window.location.search);
        const wantBoard = params.get("board");
        const wantCard = params.get("card");
        const deepTarget = wantBoard ? boards.find((item) => item.id === wantBoard) : null;
        const last = lastBoardId();
        const target = deepTarget || boards.find((item) => item.id === last) || boards[0];
        if (target) {
          await state.openBoard(target.id, { focusCardId: deepTarget && wantCard ? wantCard : null });
        } else {
          const created = await state.createBoard(tr("app.firstBoard"));
          await state.openBoard(created.id);
        }
        if (wantBoard && !deepTarget) state.showToast(`链接里的画板不存在：${wantBoard}`);
      } catch (err) {
        state.showToast((err as Error).message);
        useBoardStore.setState({ loadError: (err as Error).message });
      }
    })();
  }, []);

  /* 当前画板 / 选中卡片同步进地址栏，刷新与分享都不丢上下文 */
  const boardId = useBoardStore((state) => state.boardId);
  const selection = useBoardStore((state) => state.selection);
  useEffect(() => {
    if (!boardId) return;
    const params = new URLSearchParams(window.location.search);
    params.set("board", boardId);
    if (selection?.kind === "card") params.set("card", selection.id);
    else params.delete("card");
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, [boardId, selection]);

  /* ── 轮询：跟踪 agent 任务时 2s 强拉，抽屉打开 3s，平时 15s；窗口重新聚焦立即拉一次 ──
     页面不可见时完全停掉：浏览器只会把定时器节流到 1s，逻辑照跑，
     后台标签页没有任何理由还在拉画板。回到前台时立即补一次。 */
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const sync = () => {
      const next = document.visibilityState === "hidden";
      setHidden(next);
      if (!next) void useBoardStore.getState().pollOnce();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  useEffect(() => {
    if (hidden) return;
    if (agentRun) {
      const timer = setInterval(() => void useBoardStore.getState().pollAgentRun(), POLL_AGENT_MS);
      void useBoardStore.getState().pollAgentRun();
      return () => clearInterval(timer);
    }
    const interval = drawer ? POLL_FAST_MS : POLL_SLOW_MS;
    const timer = setInterval(() => void useBoardStore.getState().pollOnce(), interval);
    return () => clearInterval(timer);
  }, [drawer, agentRun, hidden]);

  /* agent 任务结束后自动退出跟踪（多留一轮，把最后一次写入也收进来） */
  useEffect(() => {
    if (!agentRun || agentRun.status === "running") return;
    const timer = setTimeout(() => useBoardStore.getState().stopAgentRun(), POLL_AGENT_MS + 500);
    return () => clearTimeout(timer);
  }, [agentRun]);

  useEffect(() => {
    const onFocus = () => void useBoardStore.getState().pollOnce();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  /* ── 上传（工具条 / 拖入 / 粘贴共用） ─────────── */
  const uploadFiles = useCallback(async (files: File[]) => {
    const state = useBoardStore.getState();
    if (features.browserStorage) {
      state.showToast(tr("app.upload.browserUnsupported"));
      return;
    }
    if (!state.boardId) {
      state.showToast(tr("app.noBoard"));
      return;
    }
    for (const file of files) {
      // 认不认这个文件按**扩展名**判（唯一真源 lib/upload-accept.ts）：
      // 浏览器给的 file.type 对 .m4a / .mov / .flac 经常是空串，靠它判会把正常文件挡在门外
      if (!uploadFormatFor(file.name, file.type)) {
        state.showToast(`暂不支持该文件类型：${file.name}（收 ${UPLOAD_ACCEPT}）`);
        continue;
      }
      try {
        const upload = await api.upload(file);
        await state.createCard({
          type: cardTypeForUploadKind(upload.kind),
          title: upload.name.replace(/\.[a-z0-9]+$/i, ""),
          file: {
            uploadId: upload.id,
            name: upload.name,
            kind: upload.kind,
            mediaType: upload.mediaType,
            size: upload.size,
          },
        });
        state.showToast(`已上传：${upload.name}`);
      } catch (err) {
        state.showToast((err as Error).message);
      }
    }
  }, [features.browserStorage]);

  /* ── 粘贴落点：鼠标在画布上就粘在鼠标那儿，否则粘在视口中心 ── */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);
  const pasteAnchor = useCallback(() => {
    const pane = document.querySelector(".react-flow__pane")?.getBoundingClientRect();
    if (!pane) return null;
    const point = pointer.current;
    const inside =
      point && point.x >= pane.left && point.x <= pane.right && point.y >= pane.top && point.y <= pane.bottom;
    const screen = inside ? point! : { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 };
    return flow.screenToFlowPosition(screen);
  }, [flow]);

  /**
   * 粘贴：⌘C 复制的卡片 > 图片/PDF 成卡 > 纯链接成链接卡。
   *
   * 卡片走系统剪贴板里的那段 JSON（见 lib/card-clipboard），所以另一个窗口、
   * 甚至另一台机器上复制的卡也能粘进来。非安全上下文（走 Tailscale 的 http://100.x）
   * 写不进系统剪贴板，这时退回 store 里的内存副本——那种场景下 ⌘V 就归卡片。
   */
  useEffect(() => {
    async function onPaste(event: ClipboardEvent) {
      const state = useBoardStore.getState();
      if (!state.boardId || event.defaultPrevented || boardInputBlocked(event.target, state) || event.composedPath().some(isEditableTarget)) return;
      const text = event.clipboardData?.getData("text/plain")?.trim();
      const fromClipboard = text ? parseCardClipboard(text) : null;
      if (fromClipboard) {
        event.preventDefault();
        await state.pasteCards(fromClipboard, { at: pasteAnchor() });
        return;
      }
      const files = [...(event.clipboardData?.files || [])];
      if (files.length) {
        event.preventDefault();
        await uploadFiles(files);
        return;
      }
      const isUrl = Boolean(text && /^https?:\/\/\S+$/i.test(text));
      if (!isUrl && !state.clipboardIsSystem() && state.clipboardCards()) {
        event.preventDefault();
        await state.pasteCards(null, { at: pasteAnchor() });
        return;
      }
      if (isUrl) {
        event.preventDefault();
        try {
          await state.createCard({ type: "link", link: { url: text! } });
          state.showToast(tr("app.paste.linkCard"));
        } catch (err) {
          state.showToast((err as Error).message);
        }
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [uploadFiles, pasteAnchor]);

  /* ── 任务卡动作 ───────────────────────────────── */
  const openDetail = useCallback((card: BoardCard) => {
    useBoardStore.getState().openTaskDetail(card.id);
  }, []);

  const onCardAction = useCallback(
    async (cardId: string, action: CardAction) => {
      const state = useBoardStore.getState();
      const card = state.board?.cards.find((item) => item.id === cardId);
      if (!card) return;
      try {
        if (action === "issue") {
          if (!card.title && !card.content) {
            state.showToast(tr("app.task.needContent"));
            state.setEditing(cardId);
            return;
          }
          const data = await api.cardToIssue(state.boardId!, cardId);
          state.showToast(
            data.alreadyIssued
              ? tr("app.task.alreadyIssue")
              : `已创建 ${data.issue?.number || data.issue?.id}（关联节点已注入 Issue 上下文）`,
          );
          await state.patchCard(cardId, {});
        } else if (action === "launch") {
          // local 后端：「发起」= 生成完整 prompt（不真派单），没有 implement/analyze 之分要确认，
          // 生成完直接打开任务抽屉——「复制 prompt」按钮就在那里，动线一步到位
          const local = taskBackendKind() === "local";
          const mode = local
            ? "implement"
            : window.confirm(tr("app.task.implementOrAnalyze"))
              ? "implement"
              : "analyze";
          const data = await api.launchCard(state.boardId!, cardId, mode);
          if (local) {
            state.showToast(tr("app.task.promptReady"));
            state.openTaskDetail(cardId);
          } else {
            state.showToast(`任务已发起：${data.task.sessionId}`);
          }
          await state.patchCard(cardId, {});
          void state.refreshTaskStatuses(true);
        } else if (action === "open-board") {
          const target = card.boardRef?.boardId;
          if (!target) {
            state.showToast(tr("app.board.noTarget"));
            return;
          }
          await state.drillInto(target, card.boardRef?.name || card.title || target);
        } else if (action === "detail") {
          openDetail(card);
        } else if (action === "copy-task") {
          await navigator.clipboard.writeText(card.task?.taskId || "");
          state.showToast(tr("app.task.idCopied"));
        } else if (action === "done") {
          await state.patchCard(cardId, { task: { status: "done" } });
        } else if (action === "reopen") {
          await state.patchCard(cardId, { task: { status: "issued" } });
        } else if (action === "toggle-frame") {
          // 折叠 / 展开分组框：只改这张框卡的一个布尔，子卡一个字段都不动
          await state.patchCard(cardId, { frame: { collapsed: !card.frame?.collapsed } });
        }
      } catch (err) {
        state.showToast((err as Error).message);
      }
    },
    [openDetail],
  );

  async function newBoard() {
    const state = useBoardStore.getState();
    try {
      const board = await state.createBoard(tr("common.untitledBoard"));
      await state.openBoard(board.id);
      const input = document.querySelector<HTMLInputElement>(".board-name");
      input?.focus();
      input?.select();
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <Sidebar onNewBoard={newBoard} />
        <BoardCanvas onCardAction={onCardAction} onUploadFiles={uploadFiles}>
          {/* 工具条与搜索条排成一列：工具条按钮数随卡片包增长，必须能换行，
              而换行之后搜索条得跟着往下让位——两者各自绝对定位就做不到这件事 */}
          <div className="toolbox">
            <Toolbar onUploadFiles={uploadFiles} />
            <SearchBar />
          </div>
          {/* 大纲盖在画布上而不是替掉它：画布不卸载，点大纲某一行就能顺手把视口挪过去，
              切回画布时视野正停在你刚看的那张卡上（详见 OutlineView 抬头） */}
          <OutlineView />
        </BoardCanvas>

        {/* Agent 派单要有真的执行方（local 后端不挂）；任务抽屉永远在——local 下它是复制 prompt 的家 */}
        {features.taskBackend !== "local" ? <AgentDrawer /> : null}
        <CardDrawer />
        {features.search ? <AidocsDrawer /> : null}
        {features.library ? <BookDrawer /> : null}
        <TaskDrawer />
        {!features.browserStorage ? <TemplateDrawer /> : null}
        {!features.browserStorage ? <SpecDrawer /> : null}
        <CommentDrawer />
        <SettingsDrawer />
        {!features.browserStorage ? <HistoryDrawer /> : null}
        <StorageModePanel />
      </div>
      <MindmapModal />
      <ExcalidrawModal />
      <ReaderModal />
      <CompareModal />
      <PdfModal />
      <Toast />
      {loadError ? (
        <div className="toast show" style={{ bottom: 64 }}>
          加载失败：{loadError}
        </div>
      ) : null}
    </div>
  );
}
