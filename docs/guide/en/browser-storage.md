---
title: Browser-isolated storage
summary: No account; the board lives only in this browser — how backup, migration and agent control work
group: Take it with you & extend
order: 45
---

Choose where your data lives on the [start page](/start), or switch with the **Server / Browser** pill next to the board name in the top bar.

## The two stores never share data

- **Server files**: the existing arrangement — one JSON file per board in the deployment's data directory. Uploads, the Task board, Runners, automatic snapshots and HTML/PDF layout all work. "Open the data directory in the file manager" in the settings panel takes you straight there; the web page never shows the absolute path.
- **Browser-isolated**: boards go into IndexedDB under the current site origin and are never sent to `/api/boards`. Within the same browser you can add another layer of isolation using different workspaces.

Switching only changes "which store you're looking at" — it never migrates or deletes the other side's data. For example `https://board.example.com` and `http://127.0.0.1:8567` are two different origins, and even with identically named workspaces neither can see the other's data.

## Multiple named workspaces

Both the start page and the storage settings list the workspaces that already exist under the current origin, along with their board counts and names. Type a new name to create one; the workspace name is written into the address bar, so agent prompts, refreshes and new tabs all land back in the same store.

The page-level agent API provides the matching `listWorkspaces()` and `createWorkspace(name)`. Creating a workspace doesn't copy the old data; entering an empty workspace creates its first board automatically.

## Know what you're giving up first

Browser mode has no server file directory, so you **cannot upload a new file here**, and there is no server-side continuous history/snapshots, task Issues/Runners, knowledge-base and book-library proxying, or server-side HTML/PDF/Markdown layout. Ordinary cards, edges, comments, tidy, search, navigation and JSON/PNG export all work.

**Attachment bytes that arrive with an import do stay.** Import a bundle with images (or a formatted HTML export) from the server library — or from someone else — and the image, PDF and media bytes are stored in this browser library alongside the boards: the card face shows the picture, it survives a reload, and "Back up the whole browser store" carries those bytes back out. This covers moving existing things in and out; uploading a **new** file in this mode is still impossible (that needs the server's upload directory). When bytes genuinely did not come along (for instance the bundle was over the 24 MB cap and only kept a reference), the import result says how many are missing instead of claiming a clean success.

Clearing site data, resetting the browser profile, or a privacy tool that automatically clears IndexedDB will take these boards with it. "**Back up the whole browser store**" in the storage panel downloads a **board bundle** (`.blotboard.json`, the same format as the server library, so the two can import each other; past 200 boards it splits into volumes — as many files as volumes, and you need **all** of them). "Import boards…" always adds new boards and never touches existing ones. Older browser backup files still restore.

"**Restore from backup…**" shows an **impact summary** once you pick a file (how many boards the backup holds, how many overwrite a board with the same id, how many are new, how many boards here are not in the backup), then lets you choose one of three: **Cancel** (nothing happens, zero writes) / **Merge restore** (same ids overwritten, everything else kept) / **Replace library** (back to that moment; boards not in the backup are deleted).

## How a local agent takes control

An ordinary shell process can't safely edit Chrome's or Edge's IndexedDB files directly. The correct entry point is to have the agent enter this tab through Playwright, CDP, or a browser-control tool you have already authorized, and call this in the page context:

```js
const api = window.blotboardBrowser;
await api.capabilities();
const boards = await api.listBoards();
const board = await api.getBoard(boards[0].id);
board.cards.push({ /* a complete card */ });
await api.putBoard(board);
```

There are also `listWorkspaces`, `createWorkspace`, `deleteBoard`, `exportBundle(selection?)`, `importBundle(bundle, "merge" | "replace" | "copy")` and `subscribe(listener)`. `exportBundle` produces a board bundle with the attachment bytes included; `importBundle` also accepts a single board's JSON, the formatted HTML export's text, and a saved API response `{"ok":true,"bundle":{…}}` (`copy` = always take everything as new boards). Its return value carries `assets` (how many bytes were stored / reused / missing this time) and `notes` — **report missing attachments to the user honestly**, don't paper over them with "imported N boards". This object only exists in browser storage mode; writes still go through IndexedDB transactions and notify the current page and other tabs on the same workspace to refresh.

"Copy for Agent" on the canvas and in the sidebar automatically becomes "**Copy CDP Agent prompt**" in browser mode. That prompt is completely different from the server one: it carries the workspace, requires checking `storage=indexeddb`, and explicitly forbids calling `/api/boards`.

Which means the agent has to obtain control of **this tab** first. The project won't open an extra localhost HTTP port, and won't hand every process on your machine a key that bypasses the browser boundary.
