/** 「sidebar」这一摊的英文文案。键由 sidebar.zh.ts 钉死，漏一条 typecheck 就红。 */
import type { sidebarZh } from "./sidebar.zh";

export const sidebarEn: Record<keyof typeof sidebarZh, string> = {
  /* ── Sidebar sections and the New button ── */
  "sidebar.tab.boards": "Boards",
  "sidebar.tab.cards": "Cards",
  "sidebar.new.caret.title": "New group, or a new board inside a group",

  /* ── Board search ───────────────────────── */
  "sidebar.search.placeholder": "Search board names, groups, card contents",
  "sidebar.search.clear": "Clear (Esc)",
  "sidebar.search.empty": "No board name or group matches",

  /* ── Board tree ─────────────────────────── */
  "sidebar.board.row.title": "Right-click: copy the agent prompt, move to a group, copy the ID",
  "sidebar.board.unfold": "Show sub-boards",
  "sidebar.board.fold": "Hide sub-boards",
  "sidebar.board.counts": "{cards} cards · {tasks} tasks",
  "sidebar.board.counts.comments": "{count} open comments",
  "sidebar.board.meta.cards": "{count}c",
  "sidebar.board.meta.tasks": "/{count}t",
  "sidebar.board.meta.comments": "{count} open",
  "sidebar.board.more": "More: move to a group, copy the ID, delete",
  "sidebar.locate": "Scroll back to the current board",

  /* ── Groups ─────────────────────────────── */
  "sidebar.group.none": "Ungrouped",
  "sidebar.group.current.title": "The current board is in this group",
  "sidebar.group.current": "current",
  "sidebar.group.more": "Group: rename or dissolve",
  "sidebar.group.rename": "Rename group",
  "sidebar.group.rename.hint": "{count} boards",
  "sidebar.group.prompt": "Group (project) name",
  "sidebar.group.renamed": "Group renamed to “{name}”",
  "sidebar.group.newBoard": "New board in this group",
  "sidebar.group.dissolve": "Dissolve group",
  "sidebar.group.dissolve.hint": "boards are kept",
  "sidebar.group.dissolve.confirm": "Dissolve the group “{group}”? Its {count} boards move to “Ungrouped”; the boards themselves are not deleted.",
  "sidebar.group.dissolved": "Group dissolved",

  /* ── New menu ───────────────────────────── */
  "sidebar.new.board": "New board",
  "sidebar.new.inGroup": "New in “{group}”",
  "sidebar.new.inGroups": "New board in a group",
  "sidebar.new.inGroups.hint": "{count} groups",
  "sidebar.new.group": "New group…",
  "sidebar.new.group.hint": "creates a board too",
  "sidebar.new.group.prompt": "New group (project) name",

  /* ── Board context menu ─────────────────── */
  "sidebar.board.open": "Open this board",
  "sidebar.board.copyAgentCdp": "Copy the CDP agent prompt",
  "sidebar.board.copyAgent": "Copy the agent prompt",
  "sidebar.board.copyId": "Copy board ID",
  "sidebar.board.copyName": "Copy board name",
  "sidebar.board.copyApi": "Copy API URL",
  "sidebar.board.copyCurl": "Copy curl snippet",
  "sidebar.board.delete": "Delete board",
  "sidebar.board.delete.confirm": "Delete the board “{name}”? Its cards and edges go with it.",
  "sidebar.board.deleted": "Board deleted",

  /* ── Move to a group ────────────────────── */
  "sidebar.move": "Move to",
  "sidebar.move.newGroup": "New group…",
  "sidebar.move.clear": "Remove from group",
  "sidebar.move.unnest": "Promote to a top-level board",
  "sidebar.moveTo": "Moved to “{group}”",
  "sidebar.move.cleared": "Removed from its group",

  /* ── Copy feedback ──────────────────────── */
  "sidebar.copy.done": "{label} copied",
  "sidebar.copy.failed": "Could not copy — open the Agent page and copy it by hand",
  "sidebar.copy.label.cdpPrompt": "CDP prompt",
  "sidebar.copy.label.boardPrompt": "Board prompt",
  "sidebar.copy.label.boardId": "Board ID",
  "sidebar.copy.label.boardName": "Board name",
  "sidebar.copy.label.api": "API URL",
  "sidebar.copy.label.curl": "curl snippet",
  "sidebar.copy.label.cardId": "Card ID",
  "sidebar.copy.label.title": "Title",
  "sidebar.copy.label.cardApi": "Card API URL",

  /* ── Deep search results ────────────────── */
  "sidebar.deep.head": "Matches in card content",
  "sidebar.deep.loading": "Searching…",
  "sidebar.deep.empty": "No card content contains “{keyword}”",
  "sidebar.deep.card.title": "Click to open that board and jump to this card",
  "sidebar.deep.more": "{count} more matches — open the board and keep looking with ⌘F",

  /* ── Card list ──────────────────────────── */
  "sidebar.cards.emptyFiltered": "No card matches the filter",
  "sidebar.cards.empty": "This board has no cards yet",
  "sidebar.card.untitled": "{label} card",
  "sidebar.card.item.title": "Click to locate it; right-click to copy the ID",

  /* ── Card context menu ──────────────────── */
  "sidebar.card.focus": "Locate on the canvas",
  "sidebar.card.edit": "Edit the content",
  "sidebar.card.copyId": "Copy card ID",
  "sidebar.card.copyTitle": "Copy title",
  "sidebar.card.copyApi": "Copy card API URL",
  "sidebar.card.delete": "Delete card",

  /* ── Shortcut cheatsheet at the foot ────── */
  /* These four lines interleave with <kbd>; a value carries its own leading or
     trailing space wherever English needs one that the Chinese did not. */
  "sidebar.foot.select": "select /",
  "sidebar.foot.pan": "hand · hold ",
  "sidebar.foot.space": "Space",
  "sidebar.foot.panTemp": " to pan temporarily",
  "sidebar.foot.marquee": "Select mode: left-drag to marquee-select. ",
  "sidebar.foot.selectAll": "A selects all. ",
  "sidebar.foot.delete": "deletes the selection",
  "sidebar.foot.wheel": "Wheel or two fingers pans. ",
  "sidebar.foot.zoom": "+wheel zooms. ",
  "sidebar.foot.search": "F searches",
  "sidebar.foot.mouse": "Double-click empty canvas for a new card · double-click a card to edit · right-click for more",

  /* ── Resize handle ──────────────────────── */
  "sidebar.resizer.title": "Drag to resize the sidebar (double-click to restore the default)",

  /* ── Toolbar: new cards and More ────────── */
  "toolbar.fab.title": "Show the toolbar (new card, search, filter)",
  "toolbar.fab": "Tools",
  "toolbar.fab.filter": "A filter is in effect",
  "toolbar.fab.focus": "Focus mode is on",
  "toolbar.more": "More",
  "toolbar.more.title": "More cards: the ones for structure and organisation (spec card, sub-board, frame, web page), plus source cards that need an external service configured",
  "toolbar.more.structure": "Organisation and structure",
  "toolbar.more.external": "External sources",
  "toolbar.upload": "Upload",
  "toolbar.upload.title": "Upload an image or PDF (you can also drop or paste one)",
  "toolbar.subboard.name": "Sub-board",
  "toolbar.toast.needBoard": "Create or open a board first",

  /* ── Toolbar: switches that change the view ─ */
  "toolbar.outline": "Outline",
  "toolbar.focus": "Focus",
  "toolbar.align": "Align",
  "toolbar.grid": "Grid",
  "toolbar.nodebar": "Quick bar",
  "toolbar.collapse.title": "Hide the toolbar (search and filter stay in effect)",
  "toolbar.collapse.aria": "Hide the toolbar",

  /* ── Toolbar: hover explanation card ────── */
  "toolbar.help.on": "On",
  "toolbar.help.off": "Off",
  "toolbar.help.outline.title": "Outline · another way to read the board",
  "toolbar.help.outline.body": "Lays the board out as one column in reading order, with the hierarchy taken from the edges; card contents and canvas positions are left alone.",
  "toolbar.help.focus.title": "Focus · quiet everything else down",
  "toolbar.help.focus.body": "With a card selected, only that card and the ones directly connected to it stay bright and the rest fade; deselect to see the whole board again.",
  "toolbar.help.align.title": "Align · snap to neighbours",
  "toolbar.help.align.body": "Snaps to a nearby card's edges, center lines or equal spacing as you drag; while resizing, the edge under your cursor snaps to a neighbour's edges and center lines too. Both show guides, and it is on by default.",
  "toolbar.help.grid.title": "Grid · snap to the dot lattice",
  "toolbar.help.grid.body": "Snaps to a {size}px lattice while you drag or resize by hand. It never rearranges the board, and it does not guarantee alignment with neighbours.",
  "toolbar.help.nodebar.title": "Quick bar · common actions float up",
  "toolbar.help.nodebar.body": "With a card selected, color, reading mode, comments, duplicate and delete appear above it; with it off, the card's ⋯ menu and the right-click menu still hold everything.",
  /* ── Exporting and importing boards (bundles) ── */
  "sidebar.export.toast": "Exporting {label} ({kind})",
  "sidebar.export.kind.bundle": "board bundle",
  "sidebar.export.kind.html": "typeset HTML",
  "sidebar.export.failed": "Export failed: {message}",
  "sidebar.export.bundle": "Board bundle (.blotboard.json)",
  "sidebar.export.bundle.hint": "with attachments",
  "sidebar.export.html": "Typeset HTML",
  "sidebar.export.html.hint": "importable too",
  "sidebar.export.board": "Export this board",
  "sidebar.export.board.hint": "with sub-boards",
  "sidebar.export.board.label": "“{name}”",
  "sidebar.export.group": "Export this group",
  "sidebar.export.group.hint": "{count} boards",
  "sidebar.export.group.label": "the group “{group}”",
  "sidebar.import": "Import boards…",
  "sidebar.import.hint": ".json / .html",
  "sidebar.import.done": "Imported {imported} boards",
  "sidebar.import.skipped": ", skipped {skipped}",
  "sidebar.import.failed": "Import failed: {message}",
};
