---
title: The 21 card kinds
summary: What problem each kind solves, and when to switch to another
group: Putting things on the board
order: 20
---

One card kind = one self-contained plugin directory. Switch them on and off as you need them under **Card** (the Card center) in the top bar: disabling one only blocks creating new ones — **cards already on the board keep rendering, and not one field of their data is lost**.

A fresh install only enables the common few; the rest are one switch away in the Card center.

## Writing and spreading ideas out

| Card | When to use it |
| --- | --- |
| **Text** | The default. If you can't decide, use this; the body supports Markdown |
| **Quote** | Something somebody said, or an excerpt from a source, with attribution |
| **Todo** | A list of checkboxes in one card; progress is calculated as you tick them |
| **Mindmap** | One card is a whole mind map; double-click for full-screen editing |

## Doing the work and tracking it

| Card | When to use it |
| --- | --- |
| **Task** | Something that needs to get done. Turn it into an Issue in one click, launch it, and progress writes back to the same card (see [Tasks and Issues](/docs?doc=tasks)) |
| **Spec** | Structured information with fixed fields: meeting notes / decision records / topics / incident writeups… see [Spec cards and envelopes](/docs?doc=specs) |

## Material

| Card | When to use it |
| --- | --- |
| **Link** | A URL; the title is fetched automatically |
| **Image** / **PDF** / **Media** | Drag one in and it's a card. Audio and video play in place, with a draggable scrub bar |
| **Web** | Embeds somebody else's page in the board (allowlist-limited — see the hint in the card editor) |
| **Book** / **Reference** | Only appear in the toolbar once the matching external service is configured |

## Structured expression

| Card | When to use it |
| --- | --- |
| **Code** | Syntax highlighting, one-click copy, with a filename |
| **Table** | Drop in a Markdown table or CSV directly |
| **Diagram** | Mermaid: flowcharts / sequence diagrams / Gantt charts, written as syntax |
| **Chart** | Bar / line / pie charts where you fill in data instead of writing syntax |
| **SVG** | Paste in a piece of SVG |
| **Excalidraw** | The embedded freehand whiteboard; double-click to draw full screen |

## Taming a big board

| Card | When to use it |
| --- | --- |
| **Frame** | Fence off a patch in place: drag the frame and everything inside comes along; collapsible |
| **Sub-board** | Move a pile onto **another board** and double-click to drill into it |

For the difference and how to choose, see [Frames and sub-boards](/docs?doc=frames).

## Switching to another kind

Right-click a card → "Change type". The conversion preserves whatever fields it can match, and anything it can't match **is kept as-is** — that's this project's pass-through law: no single "open board → save" cycle may destroy any field, and the private fields of unknown or disabled kinds are stored untouched, never scrubbed.

## What else the Card center covers

Besides the switches for the 21 card packs, the same drawer holds **Data specs** (switches, field documentation and "create one from the example" for the 17 built-in specs) and **Ingest cards** (paste envelope JSON, dry-run validate, then land it on the board). See [Spec cards and envelopes](/docs?doc=specs).
