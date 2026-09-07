---
title: Tasks and Issues
summary: Task card → Issue → launch → progress comes back to the same card
group: Working with agents
order: 42
---

Tasks **always work**: with no external runner connected, the board ships a local backend — the Issue lands locally and you get a complete prompt generated for you.

## A task card's four states

| State | What it means |
| --- | --- |
| **Idea** (idea) | Just written down, not committed to |
| **Issued** (issued) | Turned into an Issue, waiting to start |
| **Running** (running) | Dispatched; progress is writing back |
| **Done** (done) | Finished |

## Walking it through

1. Create a **task card** and write down clearly what you want (title + body — the body is the brief for whoever runs it)
2. **Turn into Issue** on the card — this also injects the content of **the cards connected to it** into the Issue's context. That step matters: a task shouldn't be one lonely sentence, and the background cards around it are its context
3. **Launch** —
   - With an external runner connected: it dispatches directly, the `sessionId` comes back to the card, and progress starts writing back
   - With the built-in local backend: it generates a complete prompt, copyable in one click from the task drawer, to paste into any agent you have handy
4. Progress, output and conclusions come back to **the same card**

## The Task board (in the site nav at the top left)

Manages every Issue and running task across all boards: to dispatch / in progress / needs me, all on one page. Arriving from a board pre-filters it to that board.

The Task board also handles three things the canvas can't:

- **Runner settings** — register the coding agents on this machine, choose a default, set permission levels
- **Permission requests** — when a running agent wants to touch a file or run a command, approve or deny it here
- **Orphan Issues** — Issues whose card was deleted but which are still around; you can see them here

## Which runner to connect

Three choices, in order of preference:

1. **Generic http backend** — any service implementing the protocol in `docs/RUNNER.md`
2. **ACP agent** — a coding agent on this machine that the board spawns as a subprocess directly, with streaming transcript / permission prompts / abort all coming back to the Task board
3. **local** (the default when neither is configured) — the Issue is stored locally, and "launch" = generate a prompt

The third is both the least effort and the most robust: zero external dependencies, and any agent you have to hand can pick it up.

## One boundary

With an external runner connected, **the task's source of truth is over there**; the board only stores a reference ID and never copies the business state. So the state you see on the Task board is always what's really happening over there — you'll never get the split where "the board says done and the runner says still running".
