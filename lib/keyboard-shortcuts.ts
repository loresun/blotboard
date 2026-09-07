/** Shared keyboard/paste ownership. Embedded editors keep their native commands. */
export interface BoardShortcutContext {
  editingCardId?: string | null;
  drawer?: string | null;
  compareIds?: readonly string[];
  viewMode?: string;
}

type Target = EventTarget & { closest?: (selector: string) => Element | null; isContentEditable?: boolean };

export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as Target | null;
  return Boolean(element?.isContentEditable || element?.closest?.("input, textarea, select, [contenteditable], [role='textbox']"));
}

export function boardInputBlocked(target: EventTarget | null, state: BoardShortcutContext, doc: Document = document, historyCommand = false): boolean {
  if (state.editingCardId || state.compareIds?.length || state.viewMode === "outline") return true;
  if (["read", "excalidraw", "mindmap", "pdf"].includes(state.drawer || "")) return true;
  if (isEditableTarget(target) || doc.activeElement?.tagName === "IFRAME") return true;
  if (doc.querySelector("dialog[open], .modal-backdrop, [role='dialog'][aria-modal='true']")) return true;
  const element = target as Target | null;
  if (!historyCommand && element?.closest?.(".drawer")) return true;
  return Boolean(element?.closest?.(".context-menu, [role='dialog'], [data-board-shortcuts='off']"));
}

export function boardKeyBlocked(event: KeyboardEvent, state: BoardShortcutContext, doc: Document = document): boolean {
  // Clicking a history button leaves focus in its drawer. Only history commands may
  // continue there; typing, deletion, canvas tools and paste retain the normal boundary.
  const historyCommand = state.drawer === "history" && historyShortcut(event) !== null &&
    Boolean((event.target as Target | null)?.closest?.(".history-drawer"));
  return event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey ||
    boardInputBlocked(event.target, state, doc, historyCommand) || event.composedPath().some(isEditableTarget);
}

export function historyShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): "undo" | "redo" | null {
  if (event.altKey || (!event.ctrlKey && !event.metaKey)) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) return "redo";
  return null;
}
