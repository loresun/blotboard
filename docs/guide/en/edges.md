---
title: Edges carry meaning
summary: Five relations, strength 1-5, three appearance controls — they're not just decoration
group: Putting things on the board
order: 21
---

Drag from the small dot on a card's edge onto another card and you have an edge. Select it (one click) or right-click it, and you can change three things.

## 1. Relation (five of them)

| Relation | What it means |
| --- | --- |
| **Related** | These two things are connected (the default) |
| **Blocks** | A is holding B up; B has to wait |
| **Precedes** | A comes before B |
| **References** | B cites A's content |
| **Produces** | Finishing A produced B |

## 2. Strength (1-5) and the edge label

Strength **is semantics, not line width**. It has real uses: layered re-layout and subgraph clustering use it as a weight, and it comes along in exported Markdown / HTML / envelopes. "These two cards just mention each other in passing" and "this one is the spine" end up looking different when laid out.

The edge label is a line of free text written on the edge — "rate-limited" or "waiting on the design" says far more precisely what's going on than picking one of five relations.

Three conventions govern where a label sits, all of them in service of **being readable**:

- The label is pushed to the **side** of the line, never on top of it
- When several edges join the same pair of cards, their labels are staggered along the curve (labels only — the routes themselves are untouched)
- Long labels are truncated, and **selecting that edge expands the full text** (hovering shows it too)

A label still **does not dodge a third card or another label**. Real obstacle avoidance needs orthogonal routing first, which would change the route of every existing edge on every board — that's a change of its own. For now: where edges get dense, run [Tidy](/docs?doc=organize) to spread the cards out and the labels stop crowding.

## 3. The three appearance controls

Color, line style (solid / dashed / dotted) and thickness. Purely visual; they take part in no calculation whatsoever. If you want a board where the spine and the side branches are obvious at a glance, this is the most direct way to get it.

## How edges affect everything else

- **Outline indentation**: a card's "parent" is the single upstream card that comes before it, and the whole outline hierarchy is derived from edges
  (**reading mode does not look at edges** — it reads by position; see [Four ways to look](/docs?doc=views))
- **Tidy**: layering / unroll as flow / subgraph clustering all run on edges; grid and group-by-type ignore edges entirely
- **Focus mode**: lights up the selected card and only its **direct** neighbours
- **Export**: Markdown and HTML write out the relation, strength and label along with everything else

## Small notes

- An edge connects cards, not particular sides — drag a card and the edge finds the nearest side by itself
- To delete an edge: select it and press `Delete`, or right-click and delete. Undoable, same as everything else
- If one card has too many edges, it's carrying too many roles; it should probably be split in two
