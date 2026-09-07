---
title: FAQ
summary: Won't open / can't find it / looks like it's gone — start here
group: Troubleshooting
order: 60
---

## It won't open, or the port is wrong

The default address is `http://127.0.0.1:8567`, and **if the port is taken it moves up automatically** (8568, 8569…). There are three reliable sources for the actual port: the `port` file in the data directory, the response from `GET /api/health`, and the startup log. Never hard-code the port in any script.

`GET /api/health` also tells you where the data directory is, how many boards there are, which task backend is in use, and whether a token is configured. Start every diagnosis there.

## I can't reach it from another device

By default the service only accepts **direct connections from localhost / your private network / Tailscale**, and returns 403 for everything else. That's deliberate: the write endpoints have no application-level user system, so the network boundary is the only boundary. To reach it from outside, the correct answer is to put a reverse proxy in front and do your own authentication there — not to switch this gate off.

## A card seems to have disappeared

Look in this order:

1. Is a **filter** on? Filters stay in effect while the toolbar is collapsed, and the small button carries a dot to say so
2. Is it inside a **collapsed frame**? A collapsed frame leaves only the frame
3. Was it moved into a **sub-board**? Check in the sidebar whether this board has children
4. Has the viewport drifted somewhere far away? "Fit content" in the middle of the top bar pulls it back in one click
5. Was it really deleted? Pick a snapshot from before the change under History in the top bar and roll back

## The agent finished but nothing changed on my side

The board polls on its own: every 2 seconds while following a task, every 3 seconds with a drawer open, every 15 seconds otherwise; **it stops completely when the page goes to the background** and catches up immediately when you come back. If you can't wait, hit refresh in the middle of the top bar.

## The agent says no permission / 403

Write endpoints need a token. It's generated on first launch in the `token` file in the data directory, and can also be set explicitly with an environment variable. Read endpoints don't need it. Working in the browser doesn't involve any of this — a same-origin page carries write permission automatically.

## I can't find a card kind in the toolbar

Three possibilities:

- That card pack is **disabled in the Card center**
- It's under "**More**" (the structure and organisation group, plus the source kinds that need an external service)
- The **external service it depends on isn't configured** (reference cards need the knowledge base, book cards need the book library) — with nothing configured the whole entry is hidden, so you can't click something that would only error

## The layout is a mess after a tidy

The toast at the bottom right has an "**Undo**" that puts things back the way they were. If the toast is already gone, History in the top bar also holds a snapshot from before the tidy.

While we're here: **frames and the cards inside them don't take part in Tidy** — if you want certain cards to stay exactly as you placed them, fence them into a frame.

## A web card won't embed

Embedding is allowlist-limited — not every site permits being embedded in somebody else's page (many refuse via response headers on their own). As you type the address the editor predicts whether it can be embedded. If it can't, fall back to a link card.

## Where is my data, and how do I back it up

Under `boards/` in the data directory, one JSON file per board. Backing up is copying that directory; migrating is moving it. Uploaded images / PDFs / media are in `uploads/`, and snapshots in `checkpoints/`.

## Still stuck

`npm run doctor` prints a diagnostic report you can paste straight to somebody else (read-only; it changes nothing).
