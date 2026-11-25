import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/sidebar-virtual.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const {
  SIDEBAR_BOARD_ROW_HEIGHT,
  SIDEBAR_GROUP_ROW_HEIGHT,
  computeVirtualWindow,
  flattenBoardTree,
} = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

function buildTree(boards) {
  const byParent = new Map();
  const known = new Set(boards.map((b) => b.id));
  for (const item of boards) {
    const parent = item.parentId && known.has(item.parentId) ? item.parentId : "";
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(item);
  }
  const groups = new Map();
  for (const item of byParent.get("") || []) {
    const group = item.group || "";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  const names = [...groups.keys()];
  return { byParent, groups, names };
}

test("virtual window keeps DOM board rows < 80 for 1,100+ boards across top, middle, and bottom scroll", () => {
  const boards = [];
  for (let g = 0; g < 12; g++) {
    const group = `Project-${g}`;
    for (let i = 0; i < 95; i++) {
      const id = `b_${g}_${i}`;
      const parentId = i % 15 === 1 ? `b_${g}_${i - 1}` : null;
      boards.push({ id, name: `Board ${g}-${i}`, group, parentId, counts: { cards: 3, edges: 1 } });
    }
  }
  assert.ok(boards.length >= 1100);
  const tree = buildTree(boards);
  const flat = flattenBoardTree({
    ...tree,
    foldedGroups: {},
    keyword: "",
    activeGroup: "Project-5",
    activeFound: true,
  });

  assert.equal(flat.indexByBoardId.size, boards.length);
  assert.equal(flat.rows.length, boards.length + 12);

  for (const viewportHeight of [600, 812, 1180]) {
    for (const scrollTop of [0, 12000, flat.totalHeight]) {
      const win = computeVirtualWindow(flat.rows, scrollTop, viewportHeight);
      const boardRows = win.visibleRows.filter((row) => row.kind === "board");
      assert.ok(boardRows.length > 0, "window should always render rows");
      assert.ok(boardRows.length < 80, `expected <80 board rows, got ${boardRows.length}`);
      assert.equal(
        win.topPadding + win.visibleRows.reduce((s, r) => s + r.height, 0) + win.bottomPadding,
        win.totalHeight,
      );
    }
  }
});

test("group collapse and parent folding remove descendants and search forces all expanded", () => {
  const boards = [
    { id: "p1", name: "Parent", group: "Alpha" },
    { id: "c1", name: "Child", group: "Alpha", parentId: "p1" },
    { id: "g1", name: "Grandchild", group: "Alpha", parentId: "c1" },
    { id: "b2", name: "BetaItem", group: "Beta" },
  ];
  const tree = buildTree(boards);

  const foldedBranch = flattenBoardTree({
    ...tree,
    foldedGroups: { p1: true },
    keyword: "",
    activeGroup: "",
    activeFound: false,
  });
  assert.deepEqual(
    foldedBranch.rows.map((r) => r.key),
    ["g:Alpha", "p1", "g:Beta", "b2"],
  );
  assert.equal(
    foldedBranch.totalHeight,
    2 * SIDEBAR_GROUP_ROW_HEIGHT + 2 * SIDEBAR_BOARD_ROW_HEIGHT,
  );

  const foldedGroup = flattenBoardTree({
    ...tree,
    foldedGroups: { "g:Alpha": true },
    keyword: "",
    activeGroup: "",
    activeFound: false,
  });
  assert.deepEqual(
    foldedGroup.rows.map((r) => r.key),
    ["g:Alpha", "g:Beta", "b2"],
  );

  const searching = flattenBoardTree({
    ...tree,
    foldedGroups: { "g:Alpha": true, p1: true, c1: true },
    keyword: "Grand",
    activeGroup: "",
    activeFound: false,
  });
  assert.deepEqual(
    searching.rows.map((r) => r.key),
    ["g:Alpha", "p1", "c1", "g1", "g:Beta", "b2"],
  );
});

test("empty trees, cycles, and single ungrouped board behave safely", () => {
  const empty = flattenBoardTree({
    names: [],
    groups: new Map(),
    byParent: new Map(),
    foldedGroups: {},
    keyword: "",
    activeGroup: "",
    activeFound: false,
  });
  assert.equal(empty.rows.length, 0);
  assert.deepEqual(computeVirtualWindow(empty.rows, 100, 500), {
    startIndex: 0,
    endIndex: 0,
    topPadding: 0,
    bottomPadding: 0,
    totalHeight: 0,
    visibleRows: [],
  });

  const single = buildTree([{ id: "only", name: "Only Board", group: "" }]);
  const flatSingle = flattenBoardTree({
    ...single,
    foldedGroups: {},
    keyword: "",
    activeGroup: "",
    activeFound: false,
  });
  assert.deepEqual(
    flatSingle.rows.map((r) => r.key),
    ["only"],
  );

  const cyclicByParent = new Map([
    ["", [{ id: "a", name: "A", group: "G" }]],
    ["a", [{ id: "b", name: "B", group: "G", parentId: "a" }]],
    ["b", [{ id: "a", name: "A", group: "G", parentId: "b" }]],
  ]);
  const cyclic = flattenBoardTree({
    names: ["G"],
    groups: new Map([["G", [{ id: "a", name: "A", group: "G" }]]]),
    byParent: cyclicByParent,
    foldedGroups: {},
    keyword: "",
    activeGroup: "",
    activeFound: false,
  });
  assert.deepEqual(
    cyclic.rows.map((r) => r.key),
    ["g:G", "a", "b"],
  );
});
