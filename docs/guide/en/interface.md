---
title: Interface tour
summary: Why the top bar splits into three, the sidebar into two, and where the toolbar lives
group: Getting started
order: 12
---

The interface has four areas. Once you know which question each of them answers, you stop hunting for buttons.

## Top bar: "where am I" on the left, "how do I look at this" in the middle, "what do I do to it" on the right

The things in the top bar aren't ordered by importance — they're split into three **mental** blocks:

| Position | Question it answers | What's there |
| --- | --- | --- |
| **Top left** | Where am I? Where can I go? | Sidebar toggle · site nav (Board / Nav / Resources / Task board / Help) · sub-board path · board name · save state |
| **Middle** | How do I look at this canvas? | Select / hand tool · zoom level · fit content · back to origin · refresh now |
| **Right** | What do I do to this board? | ① Content: Templates / Card　② Tidy and export: Tidy / Reading / Export　③ Collaboration and agents: Comments / History / Agent |

The five pages in the **site nav** are all the pages this service has: Board (where you are), board nav (for flipping through boards by group and date once you have many), Resources, Task board, and the Help you're reading now. From the board they all **open in a new tab** — the canvas is your work surface, and losing it to a single nav click is too expensive; between the sub-pages it's a same-tab switch.

The **three groups on the right** are pills sorted by "which kind of thing is this", rather than one long row of buttons: putting things on the board (Templates, Card center), doing something once to the whole board (Tidy, Reading, Export), and dealing with agents (Comments, History, dispatch). Narrow the window and the labels collapse to icons first, but **the three-way split never goes away** — the top bar is always "three blocks", never "eight buttons".

### When the window gets narrow: commands move into "More", never off-screen

Once the top bar runs out of room a **More** button appears on the right, and commands move into it in this order (nothing is lost — everything that left is in that menu):

1. **Labels** first, leaving icons;
2. Templates / Card;
3. History / Settings;
4. Tidy / Export (**Reading goes last** — reading the board through is the most-used button here);
5. Comments / Agent (the "still owed" comment badge moves onto More with it);
6. Last step: the wordmark and the storage pill give way, the site nav folds into one button (still all seven pages when you open it), and Reading joins the menu too.

Which step you land on is **measured**, not guessed from the screen width — how long the board name is, whether there's a sub-board path, whether the interface is in Chinese or English all take room too. So at the same window width a short board name keeps more buttons out, and that is correct. On a phone in portrait (≤480px) a few more pixels are saved: the zoom readout hides, while `+` and `−` stay.

## Left sidebar: board list / card list

Two tabs you flip between:

- **Boards**: every board laid out by group and by parent/child nesting; the search box searches board names, group names and **card body text** at the same time (body hits get their own section below, and clicking one jumps straight to that card on that board)
- **Cards**: the cards on the current board, listed grouped by kind; click one to move the viewport to it, right-click to copy the card ID (a high-frequency move when you're working with an agent)

Drag the right edge to resize it, double-click to snap back to the default. The leftmost button in the top bar, or the thin strip hugging the edge, collapses it.

## Toolbar: creating cards and searching

The strip floating at the top left of the canvas. The top row is the **create-card** entry (generated from the card pack registry — disable a card kind and its button disappears on the spot), with the third and fourth groups tucked under "More"; then upload, then five toggles:

- **Outline**: the whole board flattened into one column, indented by edge direction (see [Other ways to look](/docs?doc=views))
- **Focus**: when a card is selected, only it and its directly connected neighbours stay lit; everything else fades
- **Align**: while dragging or resizing, cards snap to a neighbour's edges, center lines and equal spacing, with guides drawn (on by default)
- **Grid**: while dragging or resizing, cards snap to the canvas 22px lattice for strictly rounded coordinates (off by default)
- **Quick bar**: floats a small toolbar above the selected card. Turning it off costs you nothing — the `⋯` on the card header and the right-click menu are the complete entry points

How the two kinds of snapping differ and work together: [Canvas aids](/docs?doc=canvas-aids).

The whole toolbar can collapse into a single small button (the arrow at the far right), leaving the canvas to the content; while collapsed, search and filters **stay in effect**, and the small button carries a dot to remind you.

Below it is the search bar (`⌘F`): it searches titles, body text, links and Issue numbers, and can filter by card kind. Matches highlight, misses fade, Enter jumps through them one at a time.

## The canvas itself

- **Double-click** empty space to create a card, **right-click** for the menu (add comment / paste / select all…)
- **Double-click** a card to edit, **right-click** for the full menu — the `⋯` on the card header is the same menu
- Click an edge to select it; right-click to change its relation / appearance / strength
- Scroll wheel or two fingers to pan, `⌘` + wheel to zoom

More gestures in [Shortcuts and gestures](/docs?doc=shortcuts).
