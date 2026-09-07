---
title: Shortcuts and gestures
summary: One table: keyboard, mouse, trackpad
group: Getting started
order: 13
---

The **?** button at the bottom left of the canvas, or pressing `?` on the canvas, opens the shortcut reference at any time. In the tables below, use `Ctrl` on Windows / Linux wherever `⌘` appears.

**Who owns the keyboard**: input fields, body editors, dialogs and embedded web pages keep their own keyboard and their own native undo. Finish editing and return to the canvas before undoing a board operation; while a Chinese IME is composing, board shortcuts don't fire.

## Tools and view

| Key | What it does |
| --- | --- |
| `V` | Select tool: left-drag to marquee-select, middle / right drag to pan |
| `H` | Hand tool: left-drag to pan the canvas |
| Hold `Space` | Temporary hand tool (release to return to your previous tool) |
| `⌘ +` / `⌘ -` | Zoom in / out |
| `⌘` + wheel | Zoom around the cursor |
| Wheel / two fingers | Pan |

> In hand mode (including the temporary hand you get by holding Space), cards can't be dragged and edges can't be pulled out of them — the grabbing-hand cursor promises "what you're grabbing is the canvas". That's deliberate: making one gesture do two different things depending on whether it starts on a card or on empty space is the classic trap for canvas tools.

## Selecting and editing

| Key | What it does |
| --- | --- |
| Double-click empty space | New text card |
| Double-click a card | Edit |
| `⌘A` | Select every card on the current board |
| `⌘C` | Copy the selected cards (pasteable across boards and across windows) |
| `⌘V` | Paste: cards > image / PDF > bare URL |
| `Delete` / `Backspace` | Delete the selected cards or edges (a multi-selection asks first) |
| `⌘Z` / `Ctrl Z` | Undo the last board operation |
| `⌘ Shift Z` / `Ctrl Shift Z` / `Ctrl Y` | Redo an undone board operation |
| `Esc` | Clear the canvas selection |
| Right-click | Cards, edges and empty space each have their own full menu |

You can review the edit history under History in the top bar, and step back and forward with the shortcuts. The "Undo" on the toast at the bottom right works the same way after a delete.

## Reading through and annotating

| Key | What it does |
| --- | --- |
| `R` | Reading mode. With a card selected it starts there; with nothing selected it starts from the first card in reading order |
| `C` | Add a comment on the selected card |
| `⌘F` | Search / filter (Enter jumps through matches, `Shift` + Enter jumps back) |
| `Esc` | Leave the current layer: editing → card, outline → canvas, dialog → closed |

In reading mode: `←` `→` turn cards, `F` enters and leaves full screen, and on picture-like cards `+` `-` zoom (10% – 1000%) with `0` back to 100%. When the body embeds somebody else's page (web card, PDF), a **keyboard ownership** toggle appears at the top — by default `←` `→` still turn cards, and only after you press it does the keyboard go to that slide deck.

## In the outline view

`↑` `↓` move up and down, `Enter` enters inline editing, `⌘Enter` saves, `Esc` returns to the canvas.

## Files accepted for upload

Images, PDFs, and audio/video (mp4 / mov / mp3 / m4a and the like). The check is by **file extension** — the MIME type the browser reports for .m4a / .mov is frequently an empty string, and trusting it would turn away perfectly good files.
