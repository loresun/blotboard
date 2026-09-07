---
title: Export PDF
summary: Pagination, page numbers and the table of contents are laid out by the board itself — one click and it's out
group: Take it with you & extend
order: 51
---

The first two entries under Export in the top bar are it: **Export PDF** (straight out with your last settings) and **PDF layout settings…** (a panel with a real pagination preview).

## How is this different from "export HTML and print it yourself"

Getting a PDF used to take three steps: export HTML → open the file → press Cmd+P. The layout was screen styling making do on paper, pagination was whatever the browser felt like, and there were no page numbers and no table of contents.

Now **the board computes the pagination itself**: paper size, margins, font size, columns, the footer on every page, and a **table of contents with real page numbers** are all pinned down at the layout step. The page-by-page preview on the right of the settings panel isn't a mock-up — it's the same document and the same pagination pass that gets printed, so "page 3 starts with this card" in the preview means page 3 starts with that card on paper.

## What survives into the PDF

- **Links still click** — links in the body are real link annotations, not a line of blue text printed on paper
- **Text selects and searches** — vector text, not each page screenshotted. A twenty-page board is a few hundred KB
- **Images embedded at original resolution** — images, charts and flowcharts are all there, inlined before export, with no network dependency
- **Cards don't straddle pages** — a card will move to the next page whole rather than be cut in half (except for cards longer than a full page, which are allowed to flow)

## Walking it through

1. Top bar Export → "**Export PDF**" (to adjust the layout first, click "PDF layout settings…" below it)
2. The system print dialog opens; set the destination to "**Save as PDF**"
3. Save it and you're done

Three things in the dialog need to match:

- **Pick the same paper as in the settings** — if you chose A4 here, choose A4 in the dialog. A mismatch makes the browser scale the whole page, and your font size and margins are no longer the ones you set
- **Turn off "Headers and footers"** — the page numbers are printed by this layout, and two sets of page numbers will fight
- **Leave margins at "Default"** — the margins are already baked into the paper; adding another layer squeezes out blank pages

> Why go through a print dialog at all: there's no other way in a browser to produce a real PDF while keeping clickable links and selectable text. The only way around the dialog is screenshotting each page, which gets you a stack of images — links dead, text unselectable, and several times the file size. So this step doesn't get skipped.

## The settings panel

Three groups on the left; change anything and the right side re-paginates immediately, page count and all — you can see whether you're saving paper without printing a test copy.

**Paper**: size (A4 / A3 / Letter / Legal) · orientation (portrait / landscape) · margins (narrow 12mm / standard 18mm / wide 26mm)

**Layout**:

| Item | Notes |
| --- | --- |
| Font size | Small / standard / large. The whole document scales proportionally, not just the body text |
| Columns | One or two. **Two columns saves a lot of paper on boards with many cards and short bodies**; wide images and wide tables automatically span the full page |
| Cover | Board name, group, statistics, export timestamp |
| Table of contents | With **real page numbers**; the entries are the card numbers |
| Footer page numbers | Prints the board name and "page n / N" at the bottom of every page |
| Each card on a new page | For a review draft you go through card by card |

**Content**:

| Item | Notes |
| --- | --- |
| Scope | The whole board / the filter matches (same standard as the canvas) / the cards selected on the canvas |
| Include comments | For a review copy — unresolved annotations print alongside their cards |
| Print images | Turning it off only saves ink; captions and card structure stay as they are |
| Append URLs after links | A link on paper can't be clicked, so putting the URL after it is the only way to copy it down — turn this on when the thing really is going to be printed for someone |

Settings live **in the browser on your machine**, not in the board data: send the same board to someone else and they should use their own paper size and font size.

## A few boundaries

- **A card longer than a full page** is allowed to flow (better to spend an extra sheet than to cut content). The pages containing such a card have no footer page number, and the table of contents gives an estimated page number for it
- **Landscape + one column** leaves only half the usable height, which makes long cards trip the rule above very easily; pair landscape with "two columns"
- A web embed card prints as the card frame plus the address (a cross-origin page can't be captured anyway), and a media card prints the file information

## Want another format

The same menu also has formatted HTML (a single file that opens offline), PNG (a screenshot of the whole board), Markdown, JSON and card envelopes — for where each of them goes, see [Export and sharing](/docs?doc=export).
