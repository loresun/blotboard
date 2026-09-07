# Storage Entry and Agent Handoff Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a standalone storage-first landing page, named browser workspace discovery, safe server data-directory reveal, and distinct server/CDP Agent handoff prompts.

**Architecture:** Keep `/` as the stable board route and add `/start` as the product entry. Extend the existing IndexedDB metadata repository for workspace discovery and use one protected server route to reveal the data directory without returning its absolute path. Prompt builders and the Agent page branch by storage mode.

**Tech Stack:** Next.js 16, React 19, IndexedDB, Node child processes, CSS modules, Playwright, TypeScript.

---

### Task 1: Prompt and workspace contracts

**Files:**
- Modify: `lib/agent-onboarding.ts`
- Modify: `lib/browser-agent-bridge.ts`
- Modify: `lib/browser-board-repository.ts`
- Test: `e2e/agent-onboarding.spec.ts`
- Test: `e2e/browser-storage.spec.ts`

1. Add failing tests proving the CDP prompt names the workspace and forbids server API writes.
2. Add workspace list/create operations backed by IndexedDB metadata.
3. Expose those operations on `window.blotboardBrowser`.
4. Run focused typecheck and browser tests.

### Task 2: Safe server data-directory link

**Files:**
- Create: `app/api/storage/reveal/route.ts`
- Modify: `components/StorageModePanel.tsx`
- Test: `e2e/security.spec.ts`

1. Add tests for missing auth, cross-origin rejection and successful same-origin reveal response shape.
2. Implement platform-specific file-manager opening without returning the absolute path.
3. Add the link to server storage configuration.

### Task 3: Standalone landing page

**Files:**
- Create: `app/start/page.tsx`
- Create: `components/StartPage.tsx`
- Create: `components/StartPage.module.css`
- Modify: `components/SiteNav.tsx`
- Test: `e2e/storage-entry.spec.ts`

1. Build the editorial two-world landing page.
2. List existing browser workspaces and support creating/entering a named workspace.
3. Add server and CDP prompt copy actions beside the matching entry buttons.
4. Preserve `/` and all existing deep links.

### Task 4: Agent page and help

**Files:**
- Modify: `components/AgentOnboarding.tsx`
- Modify: `components/AgentOnboarding.module.css`
- Modify: `docs/guide/browser-storage.md`
- Modify: `docs/guide/agent.md`
- Modify: `README.md`

1. Render the HTTP/MCP workflow only in server mode.
2. Render the CDP/browser API workflow only in browser mode.
3. Document server data location, export scope, workspace names and the two prompt types.
4. Run repository lint and typecheck.

### Task 5: Verification and commit

1. Run `npm run check` in an isolated worktree because production uses this checkout.
2. Inspect `/start`, storage settings and both Agent page variants in a real browser with zero console errors.
3. Stage only task files and commit.
