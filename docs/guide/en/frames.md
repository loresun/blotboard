---
title: Frames and sub-boards
summary: Two ways to tame a big board — don't mix them up
group: Putting things on the board
order: 22
---

Once a board gets big you start wanting to "put these few together". There are two ways to do it, and picking the wrong one is awkward later.

## Frame: fence off a patch in place

Draw a box on the canvas; drag cards into it and they belong to it.

- The cards are still **on this board**, they just carry a note saying which frame they're in
- Drag the frame = the whole patch comes with it
- A frame can be **collapsed**, leaving just the frame and a count
- **Frames and the cards inside them are skipped by Tidy** — that's a division you drew by hand, and re-layout would tear it apart
- Reading mode treats a frame as a **chapter**: reach a frame and the cards it holds come next (the outline nests them under it too)

### "There are clearly cards in the frame — why does it say 0?"

Because membership is a note **on the card itself**, not a question of which rectangle sits on top of which. Dragging a card into a frame writes that note; but a batch imported from elsewhere, or cards left behind after an agent rewrote the whole board, may only have coordinates that land inside the frame, with the note still empty.

When that happens the frame shows a "Take in N" button. Press it and those N cards join (the same button is on the frame's right-click menu and in reading mode).

- It only takes in cards that belong to **no frame at all**; cards already in another frame are never stolen — that membership is something you stated
- The test is "the card's **centre point** falls inside the frame"
- This is a batch edit: the system snapshots the whole board first, and the toast offers **Undo**

The system will **never** do this for you. Overlapping visually is not the same as belonging, and quietly re-homing a batch of cards on geometry alone costs far more than one extra click.

When to use it: these cards need to move together and be seen together, but they still belong to this board's main thread. Things like "Phase one", "The undecided batch", "Counterexamples".

## Sub-board card: move it onto another board

Put one card on this board that points at **another board**; double-click to drill in, and a return path appears in the top bar.

- The cards really do move to the other board, and only one card's worth of space is left here
- The sub-board shows indented in the left sidebar, and inherits the group automatically
- The card face shows a thumbnail of that board and its counts

When to use it: this pile is complex enough to deserve a whole canvas of its own — or you simply want it **out of sight** so the main board stays clean.

## The one-line rule

**Use a frame to "move things together"; use a sub-board to "move things out of sight".**

## Finding boards once you have a lot

Three places:

- **Sidebar search** — searches board names, group names and card body text at once
- **Board nav page** — groups on the left, boards on the right in date order; far faster than digging through the tree in the sidebar
- **Breadcrumbs** — after drilling into a sub-board, the path back appears at the top left

Board groups are managed under the arrow next to the New button in the sidebar: new group, move a board into a group, rename a group, dissolve a group.
