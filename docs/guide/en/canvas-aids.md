---
title: Canvas aid toggles
summary: What Outline, Focus, Align, Grid and the Quick bar each change
group: Getting started
order: 14
---

The last five items on the toolbar at the top left of the canvas are all **toggles**: a pale purple background means on. They only change how you look at things, how dragging behaves, and whether the shortcut buttons show — they never delete or rewrite a card's content. Hover over a button, or move keyboard focus to it, and a short explanation card appears telling you whether it is currently "on" or "off".

## What each of the five does

| Toggle | What happens when it's on | Does it change data? |
| --- | --- | --- |
| **Outline** | Flattens the current board into one column in reading order, showing hierarchy from the edges; you can edit titles and body text inside the outline | Switching the view changes nothing; editing inside the outline does save |
| **Focus** | With a card selected, highlights only it and its directly connected cards, fading the rest | No — purely temporary noise reduction |
| **Align** | Snaps to a neighbouring card's edge, center line, or equal spacing as you drag, with guide lines; also applies while resizing | Only saves the position and size you finally dragged to |
| **Grid** | Snaps to the canvas's 22px dot grid while you drag or resize by hand | Only saves the quantised coordinates and size |
| **Quick bar** | With a card selected, shows recolor, read, comment, duplicate and delete above the card | No; with it off, the right-click menu and the card header `⋯` still have everything |

These toggles remember your choice and carry over after a page refresh.

## "Align" and "Grid" are not the same thing

**Align looks at neighbours**: it cares whether this card's left edge, center line or spacing matches the card beside it. It only helps out in the last few pixels of a drag, is on by default, and feels more natural day to day.

It applies to both dragging and resizing: **dragging** aligns where the whole card sits, with all six edges, the center lines and equal spacing in play; **resizing** aligns wherever you drag that one edge to — only the edge you're pulling (and the center line that follows it) snaps to neighbours, while the opposite edge doesn't move at all, so you can align a row of cards by position first and then pull them all to the same width. Corner handles snap in each direction independently.

**Grid looks at the dot lattice**: it ignores neighbours entirely and just lands positions and sizes on fixed 22px steps. Good for boards that need strictly regular coordinates; off by default.

With both on, proximity to a neighbour wins and Align does the snapping; any axis that didn't hit a neighbour's guide line then lands on the grid.

## It's also not "Tidy → Grid layout"

- The toolbar's **Grid toggle** only takes effect when you later drag or resize a card by hand; it never suddenly moves the whole board.
- **Tidy → Grid layout** in the top bar is a whole-board operation: it immediately rearranges every free card into rows and columns, which does change your existing layout — but it can be undone.

Day-to-day suggestion: keep "Align" and "Quick bar" on and "Grid" off; turn Grid on when you need strict coordinates. To clean up an entire messy board in one go, use [Eleven ways to tidy](/docs?doc=organize).
