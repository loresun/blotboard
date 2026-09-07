---
title: What Blotboard is
summary: One board shared by you and your agent: you spread ideas out, it does the work
group: Getting started
order: 10
---

In one line: **spread your thinking out as cards, drag edges between them, right-click to annotate — that is the human half; every single thing the interface can do has a matching API — that is the agent half. You are both looking at the same board.**

The whiteboards on the market are built for people, and agents can't get in; agent memory is built for models, and people can't see it. Blotboard (泼墨画板) wants the ground in between: you think, judge and annotate; the agent creates cards, edits cards, acts on your annotations, takes tasks away and brings the output back. Whatever either side changed, the other side sees on its next refresh.

## Three things it insists on

**① Local first.** Your data is a JSON file on your own disk — one file per board, written atomically. No cloud, no accounts, no network. Want a backup? Copy the directory. Want to move? Move the directory to another machine. By default the service only accepts direct connections from localhost, your private network, and Tailscale.

**② Cards are plugins.** All 21 card kinds (text, task, image, code, table, chart, mindmap, embedded web page…) are separate directories, switched on and off as you need them in the Card center. Disabling one only blocks creating new ones — **cards you already have keep rendering, and not one field of their data is lost**. That is this project's first law, guarded by byte-for-byte round-trip tests.

**③ You don't have to teach the agent.** The interface describes itself (`GET /api/capabilities`), and the guide is assembled on the spot from whatever this particular deployment actually has enabled (`GET /api/skill`) — it documents what is installed, so the manual can never drift away from the deployment.

## What it's good for

- **Thinking one thing through**: scatter of half-ideas → draw the causal links → tidy into a flow → read it once → export as a document
- **The whole picture of a project**: requirement cards, task cards, reference links, meeting notes and decision records on one board, with sub-boards splitting it by module
- **A work surface for an agent**: you write clearly on a card what you want, the agent creates cards and fills them in, takes the task away and runs it, and the output comes back to the same card
- **A small structured library**: meeting notes / topics / incident writeups / model benchmarks… stored as spec cards with real fields, so they can be filtered, exported and shipped in bulk

## What it isn't for

It isn't a real-time collaborative whiteboard (no multiplayer cursors, no conflict merging — it runs on polling plus whole-board optimistic concurrency). It isn't a drawing tool (there is an embedded Excalidraw card if you want to sketch freehand, but it isn't competing with Figma). And it never calls a large language model — the board itself has zero external dependencies; all the AI lives in the agent you connect to it.

## Which page to read next

Just opened it and don't know what to click? See [Five-minute start](/docs?doc=quickstart). Want to know the logic behind where the top-bar buttons live? See [Interface tour](/docs?doc=interface). Want an agent working on the board? See [Connecting an agent](/docs?doc=agent).
