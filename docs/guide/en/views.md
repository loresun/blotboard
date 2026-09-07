---
title: Reading · Outline · Compare · Focus
summary: Four ways to look at the same board, each solving a different problem
group: Other ways to look
order: 31
---

The canvas is the real thing, but "spread out on a two-dimensional plane" isn't always the best way to read it.

## Reading mode (`R`)

The whole board is compressed into one sequence, one card filling the screen, `←` `→` to turn, with a table of contents down the left.

- The order follows **where cards sit**: top to bottom, left to right within a row (not edges — edges only cover some of the cards, and isolated ones would be dropped wholesale)
- With a filter active on the canvas, **only the matches are read**
- With a card selected it starts from that card; with nothing selected it reads from the top
- `F` for full screen: the stage for images / slides / tables grows a lot, and body text switches to a larger size
- Cards that are "one picture" (images, diagrams, mind maps, sub-boards) zoom over a **10% – 1000%** range: `⌘/Ctrl` + scroll (or a trackpad pinch) zooms continuously, `+` `-` step through preset stops, `0` or a double-click returns to 100%, and dragging pans. Text cards don't zoom — bigger type reads worse than a wider measure, so those scroll instead
- When somebody else's page is embedded, a **keyboard ownership** toggle appears at the top — by default `←` `→` turn cards, and only after you press it does the keyboard go to that slide deck

This is the fastest way to check whether the board actually says anything.

### Three handles for when the order is wrong

Reading by position is enough for most boards, but a few cards never lay out in the order you mean. Three handles — **none of them need configuring, and leaving them alone reads exactly as before**:

- **Chapters**: a [frame](/docs?doc=frames) reads as one chapter — reach a frame and the cards it holds come next, nested under it in the outline. On a board with no frames this simply doesn't exist
- **Skip**: side notes, service info, a "leave feedback" card — appendices that break the teaching thread. Press **Skip** at the top when you reach one and it won't come up again (the same checkbox is in the card editor). Reading order only: the canvas, exports and outline all keep it
- **Reading number**: give a few cards an explicit number in the card editor. Numbered cards come first in that order, the rest still follow their position — **numbering the opening few is usually enough**, you never number the whole board

No card is ever lost to these three: if a card's frame has been deleted, it simply reads as a free card.

## Outline (the "Outline" toggle in the toolbar)

The whole board flattened into one column, indented by edge direction. You can filter it, and you can **edit titles and body text inline** — `↑` `↓` to move, `Enter` to edit, `Esc` back to the canvas.

The outline lies over the canvas rather than replacing it — click a row and the canvas viewport moves too, so when you switch back you're parked on the card you were just looking at.

## Compare (right-click a card → "Add to compare")

Two to four cards side by side, each column scrolling independently. Two text cards also get **line-level diff highlighting** — before and after, or two versions of a proposal, side by side beats flipping back and forth.

## Focus (the "Focus" toggle in the toolbar)

With it on, selecting a card lights up only that card and its **directly connected** neighbours, fading the rest. Very useful for following one thread on a big board; turn it off when you're done — it changes no data.

## Search and filter (`⌘F`)

Searches titles, body text, links and Issue numbers; can also filter by card kind alone. Matches highlight, misses fade, Enter jumps through them, `Shift` + Enter jumps back.

Filtering is a **global standard**: with a filter on, reading mode reads only the matches, and the export menu grows an extra "export only the filter matches" entry. That consistency is deliberate — what you see on the canvas is what you read and what you export.
