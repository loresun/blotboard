"use client";

export type BoardStorageMode = "server" | "browser";

export const STORAGE_MODE_KEY = "blotboard.storage.mode";
export const STORAGE_WORKSPACE_KEY = "blotboard.storage.workspace";
export const DEFAULT_BROWSER_WORKSPACE = "default";

export function normalizeWorkspace(value: unknown): string {
  const text = String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const clipped = [...text].slice(0, 48).join("");
  return clipped || DEFAULT_BROWSER_WORKSPACE;
}

function queryValue(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

export function storageMode(): BoardStorageMode {
  if (typeof window === "undefined") return "server";
  const query = queryValue("storage");
  if (query === "browser" || query === "server") return query;
  return window.localStorage.getItem(STORAGE_MODE_KEY) === "browser" ? "browser" : "server";
}

export function browserWorkspace(): string {
  if (typeof window === "undefined") return DEFAULT_BROWSER_WORKSPACE;
  return normalizeWorkspace(queryValue("workspace") || window.localStorage.getItem(STORAGE_WORKSPACE_KEY));
}

export function browserStorageActive(): boolean {
  return storageMode() === "browser";
}

export function storageUrl(mode: BoardStorageMode, workspace = browserWorkspace(), pathname?: string): string {
  if (typeof window === "undefined") return pathname || "/";
  const params = new URLSearchParams(window.location.search);
  params.set("storage", mode);
  if (mode === "browser") params.set("workspace", normalizeWorkspace(workspace));
  else params.delete("workspace");
  params.delete("board");
  params.delete("card");
  const query = params.toString();
  return `${pathname || window.location.pathname}${query ? `?${query}` : ""}`;
}

export function persistStorageChoice(mode: BoardStorageMode, workspace = browserWorkspace()): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_MODE_KEY, mode);
  if (mode === "browser") window.localStorage.setItem(STORAGE_WORKSPACE_KEY, normalizeWorkspace(workspace));
}
