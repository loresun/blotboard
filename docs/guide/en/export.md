---
title: Export and sharing
summary: Four formats, each with its own destination
group: Take it with you & extend
order: 50
---

**Export** in the top bar. The menu is ordered top to bottom by "which one do most people want".

## Export PDF (the first two entries)

Pagination, paper size, margins, page numbers and the table of contents are all laid out by the board itself, then handed to the system print dialog (choose "Save as PDF" there). The result is vector text: **links are clickable, text is selectable and searchable**, images are embedded at original resolution, and cards don't straddle pages.

"Export PDF" goes straight out using your last settings; "PDF layout settings…" opens a panel with a **real pagination preview** — change the paper, font size or column count and the page count updates on the spot. Full page: [Export PDF](/docs?doc=pdf).

## Formatted export · HTML

The layout is computed server-side and you get a **self-contained single-file HTML**:

- No external links; double-click to open offline
- Print it and you get an A4 PDF
- Spec cards get a property table per their spec, and diagrams are rendered server-side as vector graphics
- Open it on another machine and it looks the same

The first choice for anything that has to open offline or get forwarded around; for something printable with page numbers and a table of contents, use the PDF above. The menu has two variants too: **preview first** (the same artifact, not downloaded, opened in a new tab) and **review copy with comments** (prints the unresolved annotations alongside, good for a review pass).

With a filter active on the canvas, the menu grows an extra "**export only the filter matches**" — exactly the same standard as what you see on the canvas.

## PNG

A screenshot of the whole board. Cards off-screen are drawn before the capture, so nothing gets clipped.

## Markdown

For humans to read and for models to read. Cards are laid out in reading order, and each edge's relation / strength / label is written out too. If you want to feed a board to an agent as context, this format is the least effort.

## JSON

The board's raw structure, which **can be loaded straight back in** (paste it back in the board settings). Backups, migration and reusing a board as a template all go through this.

## Board bundles (take it away, bring it back)

The five formats above are **artifacts**; this one is for **moving house** — a whole board
(name, group, cards, edges, comments, images and attachments) packed into one
`.blotboard.json` that stands right back up on another board service.

- "Export → Export board bundle" in the top bar is the current board; right-click a board or a
  group in the left sidebar to export that batch; "Back up the whole library" in the storage
  panel is everything.
- **Sub-boards come along**: if the board has a sub-board card, the board it points at is packed
  too — otherwise that card is a dead link on the other end.
- Image and PDF **bytes** are in the bundle (24 MB total cap; anything over it is named on import).

### When the library is large: volumes

One bundle holds at most **200 boards**. Past that it is split into **volumes**: a backup
downloads several files, each named with "volume N of M", and every volume is a
**complete, importable** bundle on its own.

There is only one rule: **keep as many files as there are volumes**. One missing file is one
missing batch of boards. Restoring means importing each volume; the order does not matter.
A sub-board reference that crosses volumes connects once its own volume is imported too.

Over the API: `GET /api/boards/export?…&plan=1` first tells you how many volumes this takes
(without packing anything), then fetch `&volume=1`, `&volume=2`… one at a time. Asking for an
over-limit batch without `volume` **fails loudly** and hands you the whole plan — you never get
a truncated bundle that merely looks successful.

## Importing boards

The arrow next to "New" in the left sidebar → **Import boards…**, or "Import boards…" in the
storage panel. Four kinds of file are accepted:

- A board bundle `.blotboard.json` (each volume of a split backup is one too)
- A single board's JSON (the "Export JSON" above)
- **The formatted HTML export** — it carries the same data at the end, so **the file you send
  someone to look at is also the file they can import into their own board**, cards, edges,
  comments and images included
- A saved **API response** (the whole `{"ok":true,"bundle":{…}}`) — the board digs one level in
  for you, no need to pull `bundle` out by hand

An import **only ever creates new boards** and never touches one you already have; the same name
and the same id still land as a new board. So a board someone sends you is safe to import, look
at, and then decide whether to keep.

To **restore your own backup** (go back to how things were on some day), use "Restore from
backup…" in the storage panel. Once you pick a file you get an **impact summary** first — how
many boards the backup holds, how many of them overwrite a board with the same id here, how many
are new — and then you choose:

- **Cancel**: nothing happens, not a single byte is written;
- **Merge restore**: boards with the same id are overwritten, every other board is left alone
  (the server library saves a checkpoint first — roll back from "History" in the top bar);
- **Replace library** (browser library only): makes this workspace identical to the backup,
  **deleting the boards that are not in it** — the summary tells you how many that is beforehand.

Two things that change along the way, just so you know: an imported copy gets fresh card ids, and
task cards in a copy **do not inherit** the source machine's Issue and task ids (those are work
items on someone else's machine, and copying them over would hit the wrong thing).

## Envelopes (the card exchange format)

The export in the other direction: `GET /api/boards/{id}/export?format=cards` gives you an **envelope** — a self-contained description of a batch of cards, from which another machine can rebuild them completely. All bulk sending and receiving goes through it; see [Spec cards and envelopes](/docs?doc=specs).

## Sharing a board

On the same machine or the same private network, just send the link in the address bar — `?board=b_xxx&card=c_xxx` lands directly on that card on that board. This is also the link shape an agent should use when reporting a location back to you.

To send it to someone outside your network, exporting the single-file HTML is far easier: they don't need to be able to reach your service at all.
