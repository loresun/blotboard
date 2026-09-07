# Browser-local Storage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an isolated IndexedDB-backed browser workspace and a page-scoped API that lets an authorized local browser agent operate that data.

**Architecture:** Keep the existing HTTP/file backend unchanged. Route core board operations through a client data-source selector; the browser implementation stores one board per IndexedDB record under a normalized workspace namespace and exposes the same operations to the UI and `window.blotboardBrowser`. Server-only integrations are disabled visibly while browser mode is active.

**Tech Stack:** Next.js 16, React 19, Zustand, IndexedDB, Playwright, Node test runner, TypeScript.

---

### Task 1: Storage mode and pure browser-domain helpers

**Files:**
- Create: `lib/storage-mode.ts`
- Create: `lib/browser-board-domain.ts`
- Test: `e2e/browser-storage.spec.ts`

**Steps:**
1. Add failing browser tests for workspace normalization, bundle validation/merge and core board mutations.
2. Run the focused Playwright test and verify failure.
3. Implement stable storage-mode parsing and browser-safe pure domain functions.
4. Run the focused test and verify pass.

### Task 2: IndexedDB repository and data-source routing

**Files:**
- Create: `lib/browser-board-repository.ts`
- Modify: `lib/api-client.ts`
- Modify: `lib/store.ts`
- Modify: `lib/api-client.ts`
- Modify: `lib/export.ts`

**Steps:**
1. Implement object stores for workspace metadata and per-board records, with atomic read-modify-write transactions.
2. Implement the browser data source with the core methods currently consumed by the Zustand store.
3. Route store, navigation search and JSON export through the selected source.
4. Keep non-board server APIs unchanged and return explicit unsupported errors for server-only operations.
5. Run `npm run typecheck`.

### Task 3: Storage UI, bundle backup and capability degradation

**Files:**
- Create: `components/StorageModePanel.tsx`
- Modify: `components/BoardApp.tsx`
- Modify: `components/TopBar.tsx`
- Modify: `components/Toolbar.tsx`
- Modify: `components/BoardNavApp.tsx`
- Modify: `lib/features-client.ts`
- Modify: `app/globals.css`

**Steps:**
1. Add a persistent top-bar mode badge and panel for server/browser selection plus workspace naming.
2. Add “backup browser library” and “restore browser library” controls with merge/replace semantics.
3. Hide or disable upload, Runner, checkpoint and server-layout exports in browser mode with an explanation.
4. Ensure switching waits for pending writes and reloads with an explicit URL mode.
5. Run `npm run typecheck && npm run build`.

### Task 4: Page-scoped Agent API

**Files:**
- Create: `lib/browser-agent-bridge.ts`
- Modify: `components/BoardApp.tsx`
- Modify: `lib/types.ts`

**Steps:**
1. Install `window.blotboardBrowser` only in browser mode.
2. Expose documented, promise-based list/get/put/delete/bundle methods and a change subscription.
3. Dispatch a storage-change event after mutations and refresh the open board/list without reload.
4. Remove the API on component teardown or mode change.
5. Run `npm run typecheck`.

### Task 5: Documentation and end-to-end verification

**Files:**
- Create: `docs/guide/browser-storage.md`
- Modify: `README.md`
- Modify: `lib/skill-core.md`
- Modify: `e2e/board.spec.ts`

**Steps:**
1. Document persistence, isolation, backup, feature boundaries and the browser-agent control recipe.
2. Add E2E tests for workspace isolation, reload persistence, bundle restore and Agent API visibility.
3. Run `npm run check` and fix actual failures without weakening checks.
4. Review `git diff`, stage only task files and commit the implementation.
