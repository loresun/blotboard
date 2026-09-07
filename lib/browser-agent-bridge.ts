"use client";

import { browserBoards, BROWSER_STORAGE_CHANGED, type BrowserImportMode, type BrowserWorkspaceSummary } from "./browser-board-repository";
import { browserStorageActive, browserWorkspace } from "./storage-mode";
import type { Board, BoardDetail, BoardListItem } from "./types";
import type { BoardBundle } from "./board-bundle";

export interface BlotboardBrowserAgentApi {
  readonly version: 1;
  readonly mode: "browser";
  readonly workspace: string;
  capabilities(): Promise<{ storage: "indexeddb"; workspace: string; operations: string[] }>;
  listWorkspaces(): Promise<BrowserWorkspaceSummary[]>;
  createWorkspace(name: string): Promise<BrowserWorkspaceSummary>;
  listBoards(): Promise<BoardListItem[]>;
  getBoard(boardId: string): Promise<BoardDetail>;
  putBoard(board: Board): Promise<BoardDetail>;
  deleteBoard(boardId: string): Promise<unknown>;
  /** 产物是画板包（lib/board-bundle.ts）：与服务端库、与「导出的 HTML」同一种格式 */
  exportBundle(selection?: { ids?: string[]; group?: string; all?: boolean }): Promise<BoardBundle>;
  /**
   * 收画板包 / 旧的浏览器备份 / 单块板 JSON / 导出的 HTML 文本；copy = 一律当新板。
   * `assets` 是这次附件字节的去向（落库 / 复用 / 缺件），`notes` 是要如实转告用户的话——
   * 「导进来了几块板」不等于「东西全在」，缺件必须看得见。
   */
  importBundle(
    bundle: unknown,
    mode?: BrowserImportMode,
  ): Promise<{
    workspace: string;
    imported: number;
    total: number;
    mode: BrowserImportMode;
    boardIds: string[];
    assets: { stored: number; reused: number; missing: number };
    notes: string[];
  }>;
  subscribe(listener: (detail: { workspace: string; boardId: string | null; at: number }) => void): () => void;
}

declare global {
  interface Window {
    blotboardBrowser?: BlotboardBrowserAgentApi;
  }
}

export function installBrowserAgentBridge(): () => void {
  if (!browserStorageActive()) return () => undefined;
  const workspace = browserWorkspace();
  const api: BlotboardBrowserAgentApi = {
    version: 1,
    mode: "browser",
    workspace,
    async capabilities() {
      return {
        storage: "indexeddb",
        workspace,
        operations: ["listWorkspaces", "createWorkspace", "listBoards", "getBoard", "putBoard", "deleteBoard", "exportBundle", "importBundle", "subscribe"],
      };
    },
    listWorkspaces: () => browserBoards.listWorkspaces(),
    createWorkspace: (name) => browserBoards.createWorkspace(name),
    listBoards: () => browserBoards.listBoards(),
    getBoard: (boardId) => browserBoards.getBoard(boardId),
    putBoard: (board) => browserBoards.putBoard(board),
    deleteBoard: (boardId) => browserBoards.deleteBoard(boardId),
    exportBundle: (selection) => browserBoards.exportBundle(selection),
    importBundle: (bundle, mode = "merge") => browserBoards.importBundle(bundle, mode),
    subscribe(listener) {
      const handler = (event: Event) => listener((event as CustomEvent).detail);
      window.addEventListener(BROWSER_STORAGE_CHANGED, handler);
      return () => window.removeEventListener(BROWSER_STORAGE_CHANGED, handler);
    },
  };
  window.blotboardBrowser = api;
  window.dispatchEvent(new CustomEvent("blotboard:browser-agent-ready", { detail: { workspace, version: 1 } }));
  return () => {
    if (window.blotboardBrowser === api) delete window.blotboardBrowser;
  };
}
