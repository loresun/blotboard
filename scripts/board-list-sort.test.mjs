import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

// 保持 Node 20 支持：不依赖较新 Node 的原生 TypeScript 加载器。
const source = fs.readFileSync(new URL("../lib/board-list-sort.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { parseBoardListSort, sortBoardGroups, sortBoardSiblings } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const boards = [
  { name: "画板10", createdAt: 100, updatedAt: 300 },
  { name: "画板2", createdAt: 200, updatedAt: 200 },
  { name: "画板1", createdAt: 300, updatedAt: 100 },
];
const titles = (items) => items.map((item) => item.name);

test("default board order restores the input order without changing source data", () => {
  const original = structuredClone(boards);
  const byTime = sortBoardSiblings(boards, { field: "created", direction: "desc" });
  assert.deepEqual(titles(byTime), ["画板1", "画板2", "画板10"]);
  assert.deepEqual(sortBoardSiblings(boards, { field: "default", direction: "asc" }), original);
  assert.deepEqual(boards, original);
});

test("creation and modification time sort independently in both directions", () => {
  assert.deepEqual(titles(sortBoardSiblings(boards, { field: "updated", direction: "desc" })), ["画板10", "画板2", "画板1"]);
  assert.deepEqual(titles(sortBoardSiblings(boards, { field: "updated", direction: "asc" })), ["画板1", "画板2", "画板10"]);
  assert.deepEqual(titles(sortBoardSiblings(boards, { field: "created", direction: "asc" })), ["画板10", "画板2", "画板1"]);
  // 老数据缺少修改时间时使用创建时间，时间相同的板不因排序切换而跳来跳去。
  const legacy = [{ name: "B", createdAt: 300 }, { name: "A", createdAt: 300, updatedAt: 300 }];
  assert.deepEqual(titles(sortBoardSiblings(legacy, { field: "updated", direction: "desc" })), ["B", "A"]);
});

test("board names use natural numeric order and can be reversed", () => {
  assert.deepEqual(titles(sortBoardSiblings(boards, { field: "name", direction: "asc" })), ["画板1", "画板2", "画板10"]);
  assert.deepEqual(titles(sortBoardSiblings(boards, { field: "name", direction: "desc" })), ["画板10", "画板2", "画板1"]);
});

test("saved sort preferences reject malformed and obsolete browser data", () => {
  for (const raw of [null, "{", "null", "[]", '"name"', '{"field":"unknown","direction":"asc"}', '{"field":"name","direction":"up"}']) {
    assert.deepEqual(parseBoardListSort(raw), { field: "default", direction: "desc" });
  }
  assert.deepEqual(parseBoardListSort('{"field":"name","direction":"desc","extra":"ignored"}'), { field: "name", direction: "desc" });
});

test("group names follow natural ascending and descending order; default restores legacy order", () => {
  const groups = ["", "Group10", "Group2"];
  assert.deepEqual(sortBoardGroups(groups, [], { field: "name", direction: "asc" }), ["Group2", "Group10", ""]);
  assert.deepEqual(sortBoardGroups(groups, [], { field: "name", direction: "desc" }), ["Group10", "Group2", ""]);
  assert.deepEqual(sortBoardGroups(groups, [], { field: "default", direction: "desc" }), ["Group10", "Group2", ""]);
  assert.deepEqual(groups, ["", "Group10", "Group2"]);
});

test("group time includes complete nested branches under their displayed ancestor group", () => {
  const members = [
    { id: "grandchild", name: "hidden", parentId: "child", group: "Other", createdAt: 600, updatedAt: 900 },
    { id: "child", name: "hidden", parentId: "root", group: "Other", createdAt: 500, updatedAt: 800 },
    { id: "root", name: "Root", group: "Group2", createdAt: 100, updatedAt: 100 },
    { id: "second", name: "Root", group: "Group10", createdAt: 200, updatedAt: 700 },
    { id: "ungrouped", name: "Root", group: "", createdAt: 1000, updatedAt: 1000 },
  ];
  const original = structuredClone(members);
  for (const field of ["updated", "created"]) {
    assert.deepEqual(sortBoardGroups(["", "Group10", "Group2"], members, { field, direction: "desc" }), ["Group2", "Group10", ""]);
    assert.deepEqual(sortBoardGroups(["", "Group10", "Group2"], members, { field, direction: "asc" }), ["Group10", "Group2", ""]);
  }
  assert.deepEqual(members, original);
});

test("equal group times are deterministic and missing parents or cycles cannot hang sorting", () => {
  const members = [
    { id: "a", name: "A", group: "Group10", parentId: "missing", createdAt: 100, updatedAt: 100 },
    { id: "b", name: "B", group: "Group2", createdAt: 100, updatedAt: 100 },
    { id: "c", name: "C", group: "Cycle", parentId: "d", createdAt: 1, updatedAt: 1 },
    { id: "d", name: "D", group: "Cycle", parentId: "c", createdAt: 1, updatedAt: 1 },
  ];
  for (const direction of ["asc", "desc"]) {
    assert.deepEqual(sortBoardGroups(["Group10", "Group2"], members, { field: "updated", direction }), ["Group2", "Group10"]);
  }
});
