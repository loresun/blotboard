import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

// 保持 Node 20 支持：不依赖较新 Node 的原生 TypeScript 加载器。
const source = fs.readFileSync(new URL("../lib/board-list-sort.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { parseBoardListSort, sortBoardSiblings } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

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
