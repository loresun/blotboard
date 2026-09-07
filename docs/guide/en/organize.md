---
title: Eleven ways to tidy
summary: Rearrange the whole board in one click — and undo any of them
group: Other ways to look
order: 30
---

**Tidy** in the top bar. Eleven layouts in four tiers; **every tidy can be undone** — the toast at the bottom right has an "Undo", and clicking it puts the cards back where they were.

> Tidy is pure algorithm, and the server and the interface run the same functions. What an agent gets from `POST /api/boards/{id}/tidy` is exactly what you get from the menu.

## Structure-preserving (use this one day to day)

**Neaten** — aligns rows and columns, untangles crossing edges, pushes overlaps apart, and **leaves cards near where you put them**. It doesn't re-layout the structure, it just straightens up a board you laid out by hand. Nine times out of ten this is the one.

## Re-layout by edges (overrides your current layout)

- **Unroll as flow** — every chain from a start node to an end node is pulled into a row, left to right in execution order, with branches stepping down. **Use this when you're building a workflow on the board**
- **Layer horizontally** / **Layer vertically** — re-layout into layers by edge direction. Layering flattens by rank, so you can't see how the paths run; to see paths, use the flow mode above

## Ignore edges, look only at the cards

- **Group by type** — like gathers with like, with whitespace between regions
- **Grid layout** — everything aligned into a grid

## By field semantics (treating the board as data)

- **Timeline** — one column per day, same-day cards stacked vertically. The date is taken from, in order, the first date field on a spec card → the moment a task card was handed to its runner → the card's creation time; anything with none of those goes to the "Undated" region on the far right
- **Kanban columns** — columns by status: task cards by idea / issued / running / done, spec cards by the status field in their spec, everything else by kind
- **Quadrants** — two binary dimensions cutting a four-square. The dimensions are **chosen once for the whole board**: if there are task cards, it uses "important × started"; otherwise the first two enumerable / numeric fields in the specs; failing that, "has upstream × has downstream". Anything unclassifiable sits on the right
- **Swimlanes** — the two-dimensional version of kanban: rows = card kind, columns = status. The row and column boundaries explain themselves through whitespace
- **Cluster subgraphs** — splits out the connected components of the edge graph, so you can see that this board is really several graphs. One cluster, one picture

## Which one to pick

| What you want to know | Which to use |
| --- | --- |
| How do I make this pile tidy | Neaten |
| Where does this process run from and to | Unroll as flow |
| What's actually on this board | Group by type / Grid |
| When did these things happen | Timeline |
| What's in progress, what's finished | Kanban columns / Swimlanes |
| What do I do first | Quadrants |
| Is this board really three boards | Cluster subgraphs |

## Two boundaries worth knowing

- **Frames and the cards inside them don't take part in Tidy** — that's a division you drew by hand, and re-layout would tear it apart
- Tidy only moves coordinates; it changes no content and touches no edge semantics

## Choosing for a messy board

- Still want your original divisions kept: use **Neaten** — it keeps the existing rows and columns as its baseline and only fixes alignment and overlap.
- Completely scattered and you just want order: use **Grid layout**; the cell size is computed from the largest card, so differently sized cards still get consistent whitespace.
- Kinds all mixed together: use **Group by type**, which gathers like with like and leaves larger gaps between groups.
- Want to read the order of things: use **Layer horizontally / vertically**; for branching and merging use **flow**, and for several unrelated graphs use **Cluster subgraphs**.
- Need to see it by business field: pick Timeline, Kanban, Quadrants or Swimlanes. Timeline columns by **UTC calendar day**, so every machine gets the same result; Quadrants only uses valid numbers or enums, and missing data stays in the unclassified region.

Frames, and the cards genuinely inside them, stay put. Free cards are shifted as a whole to avoid the fixed regions after a tidy, so they never cover an existing frame; that whole-group shift doesn't disturb the alignment, spacing or edge layering already computed inside. A layout that would run past the canvas coordinate range is refused rather than squashing every card against the boundary.

## Experiment freely, then step back

Every tidy that actually moves something records its own history step. You can try "grid → layer horizontally → kanban" in a row and then walk back with Ctrl/Cmd+Z; Ctrl/Cmd+Shift+Z redoes, and Ctrl+Y also works on Windows/Linux. The history panel keeps the list of operations, and it survives a refresh.

Running the same mode again when positions have already settled doesn't manufacture an empty undo step. While you're editing text, the shortcuts belong to the text editor and won't accidentally roll back the whole board. For the exact capacity and boundaries, see [History and rollback](/docs?doc=history).
