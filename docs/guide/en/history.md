---
title: History, undo and redo
summary: Try tidy layouts back to back, step undo and redo, keep going after a refresh, and roll the whole board back to a snapshot
group: Working with agents
order: 43
---

**History** in the top bar opens with **step-by-step undo** enabled. Try grid, then layering, then kanban; step back if you don't like it, or step forward again — no racing to click before a one-shot toast disappears.

## Step-by-step undo and redo

- Undo: `Ctrl+Z` / `⌘Z`, or "Undo last step" in History.
- Redo: `Ctrl+Shift+Z` / `⌘Shift+Z` / `Ctrl+Y`, or "Redo next step".
- While you're in an input field, the shortcuts belong to the text editor; whole-board history only resumes once you're back on the canvas.
- History is stored per board on the server, so it survives a page refresh or a restart. Changes submitted from other windows, or by an agent through the API, are recorded too.
- A new edit truncates any branch you hadn't redone. Undo and redo themselves only move the cursor; they don't append inverse records.

Editing, adding and deleting cards / edges / comments, dragging, and tidying are all recorded. Each tidy is its own step; pure panning, zooming the viewport and polling don't count as edits. Consecutive saves to the same field of the same card merge into one step within 2 seconds — it doesn't store a copy of the whole board per keystroke.

Undoing immediately after a drag makes the board wait for the geometry change to finish saving before undoing it, so a late save can't wash out the undo. If another window or an agent has already written a newer version, the undo stops and syncs the latest board instead; look at the new content and then decide.

## Scope and limits of the record

Each board keeps the last **100 steps or 8 MiB**, whichever comes first. History stores only the changed fields and the added or removed objects; an ordinary single-card edit doesn't copy the whole board. A single change that exceeds the capacity may have no step-by-step undo record — the interface will say so, and you can check the history snapshots instead.

**Undo restores board content only. It does not cancel external tasks, unsend messages, or delete uploaded files.** When a task link or execution state changes, the old undo chain stops with an explicit notice, so a genuinely running task can't be dressed up as "undone". Ordinary board edits afterwards start a new history. Undoing after deleting a task card restores the card and its reference; it does not re-run the task.

The history files live in `history/` under the data directory. Editing a board around the API by hand, or a corrupted history file, stops the old undo chain so that nothing outside the history gets overwritten. A failed history write never blocks a board save that already succeeded, but the page will warn you that undo records are unavailable. Deleting a whole board clears its step-by-step history; to recover a deleted board, use a snapshot or a backup.

## Change log and whole-board snapshots

"Change log" shows the source and a summary of bulk operations; "History snapshots" are whole-board backups kept **before** a whole-board rewrite, an envelope ingest, a paste, a server-side tidy, a bulk edit or delete, or a template insertion. They're independent of step-by-step undo.

Rolling back to a snapshot requires confirmation and overwrites cards, edges and comments; another snapshot is saved before the rollback. Single-card edits and ordinary dragging use the lightweight history and don't generate whole-board snapshots. After a board is deleted its snapshots persist under the retention policy, so a board deleted by mistake can be recovered.

## The API for agents

First `GET /api/boards/{id}` for the latest `updatedAt`, then `GET /api/boards/{id}/history` to see `canUndo`, `canRedo` and the step summaries. To act, `POST /api/boards/{id}/history` with a body of `{"action":"undo"}` or `{"action":"redo"}`, carrying write auth and `x-board-since: <updatedAt>`.

A version mismatch returns 409 and leaves the board unchanged. A successful response carries the new board and history state; read back to verify afterwards. Don't swallow the 409 and auto-retry in a loop — you may undo something the user has just submitted.
