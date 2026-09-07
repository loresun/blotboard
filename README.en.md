# Blotboard · 泼墨画板

English | [中文](README.md)

**Blotboard — a local-first whiteboard that humans and any agent share.**

> ℹ️ **v1.0.1.** Refactored out of a private project (1.0.0 was the first public release); the code and its
> acceptance suite (239 e2e specs) are in place, but it has few public users yet. It follows
> [semantic versioning](https://semver.org): breaking changes go into a major version.
> Before you run it in production, run `npm run check` yourself and read [SECURITY.md](SECURITY.md) on network boundaries.

Spread your thinking out as cards, drag them around, wire them together, right-click to annotate — that is the half meant for people. The other half is for agents:
every single thing you can do in the UI has a matching API, cards travel in and out in batches, comments *are* the hand-off channel, and a task card can be dispatched to a
coding agent in one click. **You are both looking at the same Board**: you think and annotate, the agent creates Cards, edits Cards,
works through your annotations, takes a task away and brings the output back.

- **Local-first**: either server-side JSON files (one file per Board, atomic writes) or browser IndexedDB (isolated per origin + workspace). No hosted cloud, no built-in accounts; external links and optional integrations are reached only as you configure them
- **Agent-native**: a self-describing interface (`/api/capabilities`) plus a guide assembled from what this particular deployment actually has turned on (`/api/skill`). Three ways in, below
- Stack: Next.js 16 (App Router) + React 19 + TypeScript + [React Flow](https://reactflow.dev) + zustand

## Features

| | |
| --- | --- |
| **21 card packs** | Text / Task / Link / Quote / Image / **Audio & video** (drop in a local mp4 / mov / mp3 / m4a… and it plays right there, scrubbable) / PDF / Todo / Mindmap / Mermaid / SVG / Excalidraw freehand / Web embed / Sub-board / Spec card / Reference / Book / **Code** (syntax highlighting + one-click copy) / **Table** (paste Markdown or CSV straight in) / **Data chart** (fill in the numbers, no syntax to learn) / **Frame** (fence off a few cards, drag them as one, collapsible) — each of them is a plugin directory under `cards/<type>/`, switched on and off in the Card center. Switching one off only blocks *new* cards; existing cards and their data lose nothing |
| **Spec cards and envelopes** | One JSON spec = one kind of structured card (meeting notes / decision records / metric snapshots / prompts… 17 built in). Install it and the board can receive that kind — no code changes. Bulk transfer goes through one envelope format (`blotboard.cards`), with dry-run validation and externalId de-duplication |
| **Resource library** | Register the skills / MCPs / CLIs / libraries an agent can pick up and use directly — they are just "linked resource" Spec cards, scattered across your boards. The `/resources` page lays out everything in the deployment on one page (filter by type / status, one-click copy of the install command), an agent gets the same list from `GET /api/resources`, and the `/api/skill` guide carries this section too |
| **A safety net for board-wide edits** | Every entry point that "changes a lot at once" (whole-board rewrite / envelope ingest / paste / server-side tidy / bulk edit and delete / template insert) automatically stores a full board snapshot **before** it acts, and every Board keeps its last 10. Open History in the top bar to see the record of changes and roll the whole board back in one click (a rollback stores another snapshot first, so even a rollback is reversible). The same place keeps the work log of agent edits: who, when, through which endpoint, how much they changed |
| **Comments** | Pin a comment on a Card, an Edge, or anywhere on the canvas; an agent reads the open comments, does the work, replies, marks it resolved — the request is pinned to the card, the loop closes on the board |
| **Task board + three runners** | Turn a task Card into an Issue and launch it. The built-in local backend works out of the box (Issues stored locally + a complete prompt generated), or plug in any http backend that speaks the [RUNNER.md](docs/RUNNER.md) protocol; `/tasks` is the Task board for lenses / permission requests / orphaned Issues |
| **ACP dispatch** | The local backend can also really launch a coding agent on this machine ([Agent Client Protocol](https://agentclientprotocol.com)): streaming transcript, permission prompts, abort — all of it lands back on the Task board |
| **MCP server** | `npx blotboard mcp` plugs into any MCP client (or `npm link` a trusted source checkout). 17 `board_*` tools cover everything you do to a board day to day |
| **Frame vs Sub-board** | Two ways to get a big board under control — don't mix them up. A **Frame** fences off a patch in place: the cards are still on this board, they just gain a `frameId`; drag the frame and the whole patch follows; collapse it and only the frame is left. A **Sub-board Card** moves a pile of things onto **another board** that you double-click to drill into. Use a Frame to "move them together", a Sub-board to "get them out of sight". Cards inside a frame are skipped by Tidy (that is a partition you drew by hand — re-laying it out would tear it apart) |
| **Eleven tidy modes** | Tidy (keeps your structure) / unroll the flow / horizontal and vertical layering / partition by type / grid / timeline (one column per day) / kanban (columns by status) / **matrix** (two dimensions cut into quadrants) / **swimlane** (a type × status grid) / **cluster** (split by connected component, so you can see that "this board is actually several separate graphs") — pure server-side functions; `POST /tidy` and Tidy in the top bar run the same algorithm, and both can be undone |
| **Floating quick bar** | Select a Card and a toolbar floats above it and follows it (recolor / read / comment / duplicate / delete; multi-select swaps in the bulk version). It is a **shortcut layer, not a new entry point** — the ⋯ on the card header and the right-click menu still hold the full set of actions, and if it gets in your way you can switch it off in the toolbox |
| **Three ways to look** | Canvas (the real thing) / **Outline** (the whole Board laid out in one column, indented by edge direction upstream to downstream, filterable, titles and bodies editable inline) / **Compare** (2-4 Cards side by side, each column scrolling on its own; two text Cards also get line-level diff highlighting). Reading mode is separate again: it flattens the whole board into one sequence you walk through with ←/→ |
| **Reading mode and fullscreen** | One Card spread across the whole screen: table of contents on the left, ←/→ to turn cards, images zoom and pan. **Press F for fullscreen** (native fullscreen; if the browser refuses, it falls back to filling the window) — the stage for an image / slide deck / table grows a lot, and body text steps up a size. When someone else's page is embedded (Web embed Card / PDF), a **keyboard ownership** switch appears at the top: by default ←/→ still turns cards, and one press hands the keyboard over to that slide deck |
| **Edges carry meaning** | Five relations (relates / blocks / precedes / references / produces) + the three appearance knobs (color / line style / thickness) + **strength 1-5** and a **relation label**. Strength is semantics, not line width: layered layout and cluster split use it as a weight, and exported md / HTML / envelopes all carry it |
| **Help that ships with the service** | `/docs` is a full set of user documentation, 21 pages in six groups: Getting started (intro / five-minute start / interface tour / shortcuts / canvas aids) · Putting things on the board (cards / edges / frames / templates) · Other ways to look (tidy / views) · Working with agents (access / comments / tasks / history / browser storage) · Take it with you and extend (export / PDF / specs and envelopes / resources) · Troubleshooting (FAQ). Written in both English and Chinese, following the interface language. The real source is `docs/guide/*.md` — **adding a page = dropping in one .md** (title / summary / group live in the frontmatter), and an agent gets the same data from `GET /api/docs` |
| **One-click PDF** | Pagination, paper size, margins, page numbers and **a table of contents with real page numbers** are all laid out by the board itself, then handed to the system print dialog (choose "Save as PDF" there) — the output is vector text: **links are clickable, text is selectable and searchable**, images are embedded at original resolution, and cards never straddle a page break. The right side of the settings panel is a **real pagination preview** (the same document, the same pagination pass as the printed output), so changing paper / font size / columns changes the page count right there. The range can be the whole Board, the current filter hits, or just the Cards selected on the canvas |
| **Export** | The whole Board as a single-file HTML (zero external references, opens offline, prints to A4 PDF) / Markdown / JSON / a card envelope; 13 thinking-framework Templates lay out a board in one click |
| **Browser-isolated storage** | Switch to an IndexedDB workspace from the top bar and the Board never touches the server. Workspaces are isolated from one another, and the whole store can be backed up and restored as a bundle. Uploads, Runners, snapshots and server-side layout are explicitly degraded in this mode; a local Agent drives the same data through `window.blotboardBrowser` in an authorized tab |

## Quick start

Needs Node.js ≥ 20.9.

```bash
npm install
npm run build
npm start        # → http://127.0.0.1:8567
```

Open `/start` and pick where your data lives first: the server-side file store, or an existing / new browser IndexedDB workspace. `/` is still the stable direct route to the Board, and existing `?board=&card=` deep links are unchanged.

> **Don't hard-code the address**: the default is `http://127.0.0.1:8567`, and if the port is taken it walks forward (8568, 8569…).
> There are three accurate sources for the port it actually got: the `port` file in the data directory, the `port` field of `GET /api/health`, and the startup log.
> `BLOTBOARD_PORT` asks for a port, `BLOTBOARD_PORT_TRIES` changes how far it walks (default 10),
> `BLOTBOARD_PORT_STRICT=1` turns walking off (taken port = error and exit; useful in tests).


Development mode: `npm run dev` (with HMR). Keep it running under pm2: `cp ecosystem.config.example.cjs ecosystem.config.cjs`, edit it, then `pm2 start ecosystem.config.cjs`.

The first start generates a random token in `data/token` and points at it in the log — that is the key an agent uses for write APIs
(you can also set `BLOTBOARD_INTERNAL_TOKEN` explicitly). The browser side needs no token: a same-origin page carries write permission,
and the service only accepts direct connections from localhost / private networks / Tailscale by default.

To update in production, stop the old process in the same workspace first, then build and start. A running `.next` cannot be overwritten; `npm run build` checks for exactly that. Full procedures, backup, rollback and the history-free source package are in [Deployment and release](docs/DEPLOYMENT.md).

## Agent access: three doors

The **Agent** entry at the top left changes with the current storage. Server mode offers Skill/HTTP/MCP prompts; browser mode offers a completely separate CDP/Playwright prompt. Right-clicking empty canvas or the board list also copies the matching version automatically.

> Browser-isolated storage is a boundary of its own: HTTP/MCP only ever touch the server-side file store. To act on IndexedDB, have your local Agent drive the corresponding tab through Playwright/CDP and call `window.blotboardBrowser`; see [Browser-isolated storage](docs/guide/browser-storage.md).

**① HTTP API + `/api/skill`** — anything that can make a request. Reads need no auth; writes carry `x-auth-key`:

```bash
TOKEN=$(cat data/token)
curl -s -X POST http://127.0.0.1:8567/api/boards \
  -H "x-auth-key: $TOKEN" -H "content-type: application/json" -d '{"name":"第一块板"}'

# 这台部署的完整 agent 指南（按实际启用的卡片包 / 规格 / 任务后端现场拼装，永不过期）
curl -s http://127.0.0.1:8567/api/skill?format=md
# 只要其中一类活（省上下文）：cards / specs / envelope / tasks / comments / api / links / pitfalls
curl -s "http://127.0.0.1:8567/api/skill?format=md&focus=cards,tasks"
# 机器可读的能力清单（含整理模式 layouts、mermaid 渲染边界、skillFocus 合法值）
curl -s http://127.0.0.1:8567/api/capabilities
```

**② MCP (agent → board)** — `npx blotboard mcp` works out of the box (the `blotboard` package on npm is this MCP entry point; you can also `npm link` a trusted source checkout). Run it from the repo directory and it reads `data/token` by itself;
point env at it when you are connecting to a remote host or a non-default port:

```json
{
  "mcpServers": {
    "blotboard": {
      "command": "blotboard",
      "args": ["mcp"],
      "env": { "BLOTBOARD_URL": "http://127.0.0.1:8567", "BLOTBOARD_TOKEN": "<data/token 的内容>" }
    }
  }
}
```

17 tools: `board_list / board_create / board_add_card / board_update_card / board_delete_card /
board_link / board_edge / board_layout / board_comments / board_card_specs / board_ingest_cards /
board_checkpoints / board_export / board_to_issue / board_launch / board_tasks / blotboard_capabilities`.

**③ ACP (board → agent)** — dispatch in the other direction: register a local agent under "Runner settings" on the Task board
(e.g. `npx -y @zed-industries/claude-code-acp`, `gemini --acp`), launch a task Card that carries an `agentId`,
and the board spawns it as a child process, with streaming progress and permission prompts coming back to `/tasks`. Protocol details in [docs/RUNNER.md](docs/RUNNER.md) §4.

## Optional integrations: nothing runs until you configure it

The board calls no LLM; the thing itself has zero external dependencies. An optional integration that is **not configured means its entry point is hidden entirely** (the API answers 503); configure it and it appears:

| Environment variable | What it turns on |
| --- | --- |
| `BLOTBOARD_RUNNER_URL` | Generic http task backend (anything implementing [RUNNER.md](docs/RUNNER.md); highest priority) |
| `GOAL_AGENT_RUNNER_URL` | Goal Agent task backend (a special case of http, sharing the same token); neither configured = the built-in local backend (so tasks always work) |
| `AIDOCS_URL` | Reference cards: search a knowledge base, collect the hits into a card (protocol in [INTEGRATIONS.md](docs/INTEGRATIONS.md)) |
| `BOOK_LIBRARY_URL` | Book cards: pick a book from a library — cover / read online / PDF (protocol in [INTEGRATIONS.md](docs/INTEGRATIONS.md)) |
| `GOAL_AGENT_WEB_URL` | Where "View in main UI" on a task detail jumps to |

None of these three **bind to a particular service**: implement a task backend per [RUNNER.md](docs/RUNNER.md),
a knowledge base and a book library per [INTEGRATIONS.md](docs/INTEGRATIONS.md), and the board only knows the protocol, never the implementation.
The repo ships a **reference implementation** of both protocols, if you want to see what they look like first:

```bash
npm run mock:integrations                # 起在 127.0.0.1:8899
AIDOCS_URL=http://127.0.0.1:8899 BOOK_LIBRARY_URL=http://127.0.0.1:8899 npm run dev
```

## Environment variables (all optional)

| Variable | Default | What it does |
| --- | --- | --- |
| `BLOTBOARD_PORT` / `BLOTBOARD_HOST` | `8567` / `127.0.0.1` | Listen address |
| `BLOTBOARD_PUBLIC_URL` | `http://127.0.0.1:<port>` | Outward-facing address (the base written into prompts / deep links for agents). Required for cross-machine access / working deep links — otherwise prompts and deep links point at `127.0.0.1` |
| `BLOTBOARD_ROOT` | `process.cwd()` | Project root (Templates and built-in specs follow it) |
| `BLOTBOARD_DATA_DIR` | `<root>/data` | User data directory |
| `BLOTBOARD_INTERNAL_TOKEN` | self-managed `<data>/token` | Write token (first of the three sources) |
| `BLOTBOARD_GOAL_AGENT_SETTINGS` | — | Point at Goal Agent's settings.json when sharing its token |
| `BLOTBOARD_RUNNER_TOKEN` | the board's internal token | Token for the http task backend |
| `BLOTBOARD_ACP_STDERR` | redacted summary only | How ACP agent stderr is kept: `full` also writes the raw text to `<data>/runs/<runId>.stderr.log` (0600); the raw text never enters the transcript |
| `BLOTBOARD_HTML_ALLOW` | `@private` | Domain allowlist for Web embed cards (comma-separated; `@private` = localhost/private network/Tailscale, `@none` = off) |
| `BLOTBOARD_PORT_TRIES` | `10` | How many ports to walk forward when the one you asked for is taken (8567 → 8568 → …) |
| `BLOTBOARD_PORT_STRICT` | — | Set `1` to stop walking: a taken port becomes an error and exit (for tests, so assertions don't land on nothing) |
| `BLOTBOARD_ALLOW_PUBLIC_DIRECT` | — | Set `1` to disable the "trusted networks only" address gate (**read [Before you put it on the public internet](#before-you-put-it-on-the-public-internet) first**) |
| `BLOTBOARD_TRUST_PROXY` | — | Set `1` to trust `x-forwarded-host` / `x-forwarded-proto` (used for the base that points back at the board in exports and `/api/skill`). **Only turn it on when you really are behind a reverse proxy** |
| `BLOTBOARD_ISSUE_SYNC_DEBOUNCE_MS` | `1200` | Debounce window for card edit → Issue push-back |
| `BLOTBOARD_CHECKPOINT_KEEP` | `10` | How many automatic snapshots to keep per Board (`0` = turn the whole safety net off) |
| `BLOTBOARD_CHECKPOINT_ORPHAN_TTL_DAYS` | `30` | How many days a deleted Board's snapshot directory is kept before it is cleaned (`0` = never clean). It is kept so that "I deleted the wrong one" is still recoverable in full |
| `BLOTBOARD_CHECKPOINTS_DIR` | `<data>/checkpoints` | Where snapshots land |
| `BLOTBOARD_DATA_FILE` | `<data>/boards.json` | Location of the old single-file store (used for first-start migration; the board directory is derived from it as `<same name minus .json>/`) |
| `BLOTBOARD_UPLOADS_DIR` | `<data>/uploads` | Attachment directory |
| `BLOTBOARD_MEDIA_MAX_MB` | `200` | Per-file limit for audio/video uploads (MB). Images at 10 MB and PDFs at 20 MB are hard-coded; audio and video follow this value |
| `BLOTBOARD_ISSUES_FILE` | `<data>/issues.json` | Issue storage for the local backend |
| `BLOTBOARD_RUNNER_SETTINGS_FILE` | `<data>/runner-settings.json` | ACP agent registry |
| `BLOTBOARD_RUNS_DIR` | `<data>/runs` | Transcripts of ACP runs |
| `BLOTBOARD_AGENT_COMMANDS_FILE` | `<data>/agent-commands.json` | Custom agent commands |
| `BLOTBOARD_TEMPLATES_DIR` / `BLOTBOARD_CARD_SPECS_DIR` | `<root>/data/templates` / `<root>/data/card-specs` | Asset directories shipped with the repo |
| `BLOTBOARD_USER_CARD_SPECS_DIR` / `BLOTBOARD_CARD_SPEC_STATE_FILE` / `BLOTBOARD_CARD_PACKS_FILE` | `<data>/my-card-specs` etc. | Custom specs / spec toggles / card pack toggles |

Two more exist on the MCP server side (for client configuration): `BLOTBOARD_URL` (which board to connect to) and `BLOTBOARD_TOKEN` (for writes).

## Before you put it on the public internet

The board **has no account system** — it assumes "whoever can reach this port is you". Two gates hold that assumption up:

| Gate | Where | What it covers |
| --- | --- | --- |
| **Network layer**: trusted networks only | `server.mjs` (the TCP `remoteAddress`, not the forgeable `x-forwarded-for`) | localhost / private networks / Tailscale (100.64/10) / link-local pass; everything else gets a 403 |
| **Application layer**: writes need a credential | `lib/auth.ts` | The browser uses same-origin + `x-board-web`, an agent uses `x-auth-key`; **reads need no auth** |

`BLOTBOARD_ALLOW_PUBLIC_DIRECT=1` disables **the first** one. The default binds `127.0.0.1` only;
if you explicitly set `BLOTBOARD_HOST=0.0.0.0` (all network interfaces) *and* disable the gate, anyone who can reach the port can read and write every Board.
So startup logs one loud warning about it. It doesn't refuse to start, because "sitting behind an authenticating reverse proxy" is a legitimate way to run it.

If you really need outside access, pick one:

- **Reverse proxy + your own auth** (recommended): the proxy does SSO / Basic Auth and forwards to `127.0.0.1:<port>`,
  while the board keeps `BLOTBOARD_HOST=127.0.0.1` (so you never even disable the first gate).
  A proxy rewrites `x-forwarded-*`, and *that* is when `BLOTBOARD_TRUST_PROXY=1` should be turned on.
- **Tailscale / WireGuard**: bind explicitly to the virtual interface address or `0.0.0.0` and control which devices can reach it; the default loopback binding accepts no remote connections.

### Known boundaries (not bugs, by design, but you need to know)

- **Downloading / previewing an upload has no application-layer auth**: `/api/uploads/{id}` is deliberately unauthenticated — the
  `<img src>` on a card face and the exported single-file HTML both have to fetch it directly, and adding a token breaks every image.
  All that stands in front of it is the **non-enumerable upload id** plus the network gate above. Before you put this on an untrusted network,
  that layer is yours to add (auth by path on the proxy, or simply don't expose `/api/uploads/`).
- **An ACP agent inherits every environment variable of the board process**: the commands registered in `<data>/runner-settings.json`
  are `spawn`ed by the board and can see the board's internal token and everything you exported in your shell. **Don't register commands you can't vouch for**
  — whoever can edit that file or call `PATCH /api/runner-settings` can run arbitrary commands on this machine as you.
  Details in [docs/RUNNER.md](docs/RUNNER.md) §4.1.
- **Reads need no auth**: `GET /api/boards/...`, `/api/skill` and `/api/capabilities` all take no token.
  That is a deliberate trade to keep agents and browsers simple, and the boundary again falls on the two gates above.

Found a security problem? See [SECURITY.md](SECURITY.md).

## Testing and diagnostics

```bash
npm run check       # ★ 提交前只跑这一条：lint:repo → test:unit → typecheck → build → smoke → e2e
npm run doctor      # 用着出问题时：打活服务，出一份可以直接贴进 issue 的诊断报告（只读）
```

Every step inside `check` can also be run on its own:

| Command | What it is |
| --- | --- |
| `npm run lint:repo` | Static repo checkup (seconds, zero dependencies): private traces / source files grep can't see / dead documentation links / card pack completeness / env reconciled against the table above / CSS variables / build-time env traps / foreign objects in the workspace |
| `npm run test:unit` | Build mutual exclusion, source-release boundaries, JS/CSS diagnostic regressions |
| `npm run release:source` | Produce a source package from a clean commit, with no Git history and no private data |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Production build (smoke and e2e both consume its output) |
| `npm run smoke` | API smoke test: spins up an isolated instance + mock Runner + mock ACP agent + MCP subprocess, never touching `data/` |
| `npm run e2e` | Playwright end-to-end (run `npx playwright install chromium` first): both the goal-agent and local shapes |
| `npm run mock:integrations` | Reference implementation of the two optional integrations, knowledge base and book library (single file, zero dependencies, see [INTEGRATIONS.md](docs/INTEGRATIONS.md)) |

When you file a bug, paste the output of `npm run doctor`: version / where the port actually landed / data directory / which **kind of source**
the token came from (never the value) / reachability of the three optional integrations / board count and broken board files / snapshot usage / free disk, all at once.

## Read deeper

- [AGENTS.md](AGENTS.md) — for an agent that opens the repo to change code: the four architectural layers, directory tour, data conventions, hard rules, how to add a card pack
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to get it running, the full acceptance command, what is expected before you commit
- [SECURITY.md](SECURITY.md) — threat model, the two gates, known boundaries, how to report a security problem
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — code of conduct (Contributor Covenant 2.1)
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) — the protocols for the two optional integrations, knowledge base and book library, plus a reference implementation
- [CHANGELOG.md](CHANGELOG.md) — change log and known technical debt
- [docs/CARD-SPEC.md](docs/CARD-SPEC.md) — card specs and the envelope format: how an external system sends structured Cards to the board
- [docs/RUNNER.md](docs/RUNNER.md) — task backend protocol (4 actions + the write-back contract + ACP dispatch); read it if you want to plug in your own agent backend
- [docs/OPEN-SOURCE-PLAN.md](docs/OPEN-SOURCE-PLAN.md) — the open-source roadmap and decision record
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — runtime dependencies and their licenses

## License

[MIT](LICENSE)

## Tidy and continuous undo

Cards that are completely scattered can be laid out on a grid first (rows and columns balanced against card count and size), then tidied by type or by flow; a board that already has structure is better off simply straightened. Pinned Frames stay where they are, and free cards route around the pinned regions.

Ctrl/Cmd+Z undoes step after step, Ctrl/Cmd+Shift+Z redoes (Windows/Linux also accepts Ctrl+Y). The History panel shows the record of ongoing edits and survives a refresh; while editing text, the editor's own undo is left alone. The `?` button in the bottom left has the full shortcut reference.

If you need to reproduce an experiment, run `node scripts/audit-layouts.mjs` to see its help. That script only creates a dedicated test Board when you pass `--write` explicitly — it will never run tidy experiments on a board you actually use.
