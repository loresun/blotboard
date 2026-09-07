---
title: Connecting an agent
summary: Three doors in: HTTP API, MCP, and dispatching the other way
group: Working with agents
order: 40
---

The board itself **never calls a large language model**. All the AI lives in the agent you connect — the board's only job is to provide one surface both sides can read and write.

## Start from Agent at the top left

The [start page](/start) offers two **completely different** prompts depending on where your data lives; the [Agent page](/agent) then lays out the full procedure for the current mode:

1. Right-click empty canvas or the board list in the sidebar and choose "Copy prompt for Agent" — it carries the current board ID, a deep link, the single-board API and a quick guide. Paste it and add your specific task.
2. On the Agent page, copy the Skill install prompt and hand it to Codex, Claude Code, or any client that supports Skills. You can also download the `SKILL.md` returned by `GET /api/skill?format=install`, or expand the manual install commands. Existing files are never overwritten by those commands.

The install file carries standard `name` / `description` frontmatter and stores only this deployment's entry point; every task re-reads `/api/skill` and `/api/capabilities`, so the capability list can't go stale. Installing and reading need no credentials; writing to a board still needs authorization.

The address that gets copied comes from the deployment address in your current browser. A remote agent that visits `127.0.0.1` will reach itself — open the Agent page on a deployment address that both sides can reach and that is protected. If the browser has blocked the clipboard, the page says so and you can select the text and copy it by hand.

## Browser storage: CDP prompts only

A browser workspace isn't under `/api/boards`, and it uses neither a server token nor MCP. Right-clicking the canvas or the sidebar shows "Copy CDP Agent prompt" instead: the agent has to take over the target tab through Playwright/CDP and call `window.blotboardBrowser`.

The prompt carries the exact origin, workspace and optional board ID. It tells the agent to check capabilities and workspace first, then read the board, `putBoard`, read it back and check the canvas. An agent without browser control should stop and say so, rather than editing the browser profile files directly.

The HTTP, MCP, Skill and Runner sections below apply only to the **server-side file store**.

## First, get the key

Read endpoints need no auth; **write endpoints need a token**. On first launch a random `token` file is generated in the data directory, and the startup log points at it too. The browser side doesn't have to care: a same-origin page carries write permission automatically.

By default the service only accepts direct connections from localhost / your private network / Tailscale, and refuses everything else.

## Door one: HTTP API plus a self-describing guide

Anything that can send a request can connect. The two endpoints that matter:

- `GET /api/skill?format=md` — **the complete agent guide for this deployment**, assembled on the spot from the card packs, specs and task backends actually enabled. It documents what is installed, so the manual can never drift away from the deployment
- `GET /api/capabilities` — the machine-readable capability list (tidy modes, rendering limits, valid category values…)

The guide is long, so you can ask for just one kind of work: `?focus=cards,tasks`, where the legal values are auth / api / cards / comments / specs / envelope / tasks / links / resources / pitfalls.
Those ten values are split by *kind of work*, not by feature: there is no focus named after layout — tidying lives in the `api` section, and the list of the eleven modes is under `layouts` in `/api/capabilities`. An unrecognised value returns 400 and tells you which section to read instead.

The endpoints for everyday board editing look like this:

```
GET    /api/boards                     board list
GET    /api/boards/{id}                the whole board (cards + edges + comments)
POST   /api/boards/{id}/cards          create a card
PATCH  /api/boards/{id}/cards/{cardId} edit a card
POST   /api/boards/{id}/edges          draw an edge
POST   /api/boards/{id}/ingest         bulk-ingest cards (envelope)
POST   /api/boards/{id}/tidy           tidy
GET    /api/boards/{id}/export         export
```

Write requests carry `x-auth-key: <token>`.

## Door two: MCP (the agent comes to edit the board)

An MCP server ships with the project: run `npm link` in a checked-out repo and MCP clients can use `blotboard mcp`. These `board_*` tools cover every everyday board-editing action: list boards / create board / add card / edit card / delete card / draw edge / tidy / comment / spec / ingest envelope / snapshot / export / turn into Issue / launch / check tasks.

Running it inside the repo directory picks up the local token automatically; use environment variables to point it at a remote host or a non-default port. Concrete config snippets are in the `README.md` at the project root.

## Door three: dispatching the other way (board → agent)

Register the coding agents on your machine (the ones that speak the Agent Client Protocol) under "Runner settings" on the Task board; then launch a task card with an agent attached and the board spawns its subprocess, with streaming progress and permission prompts coming back to the Task board. Protocol details in `docs/RUNNER.md`.

## That "Agent" button in the top bar

When a real runner is configured, a purple "Agent" appears in the third group on the right of the top bar. It is the entry point for working with an agent **on this particular board**: hand the whole board or the selected cards to the agent to edit or extend, or edit the whole board's config JSON directly. With no runner configured (the built-in local backend) the button doesn't render — a capability you can't deliver shouldn't be sitting there.

## Three ways to hand work to an agent, easiest first

1. **Comments** — pin "change this to…" on a card; the agent reads unresolved comments, does the work, replies, and marks them resolved. See [Comments are how you hand off work](/docs?doc=comments)
2. **Task cards** — write the thing to be executed as a task card, turn it into an Issue, launch it. See [Tasks and Issues](/docs?doc=tasks)
3. **Just say it** — tell your agent "tidy up board b_xxx" and it goes through the API

Board IDs and card IDs can be copied by right-clicking in the sidebar; the `?board=&card=` in the address bar is also a deep link you can send straight to an agent.
