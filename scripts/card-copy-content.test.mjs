import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/card-copy-content.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { extractCardCopyText, canCopyCardContent } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

test("extractCardCopyText extracts plain text and code without card JSON", () => {
  const textCard = { id: "c_1", type: "text", title: "说明", content: "第一行\n第二行" };
  assert.equal(extractCardCopyText(textCard), "第一行\n第二行");
  assert.equal(canCopyCardContent(textCard), true);

  const codeCard = {
    id: "c_2",
    type: "code",
    title: "重试函数",
    content: "忽略这里的备注",
    code: { language: "ts", source: "export const ok = () => true;\n" },
  };
  assert.equal(extractCardCopyText(codeCard), "export const ok = () => true;\n");
  assert.equal(canCopyCardContent(codeCard), true);

  const quoteCard = { id: "c_3", type: "quote", title: "摘录", content: "少即是多", quote: { source: "密斯" } };
  assert.equal(extractCardCopyText(quoteCard), "少即是多\n— 密斯");

  const linkCard = { id: "c_4", type: "link", title: "文档", content: "设计说明", link: { url: "https://example.org/spec" } };
  assert.equal(extractCardCopyText(linkCard), "设计说明\nhttps://example.org/spec");

  const todoCard = {
    id: "c_5",
    type: "todo",
    title: "发布清单",
    content: "",
    todo: {
      items: [
        { id: "t1", text: "跑单测", done: true },
        { id: "t2", text: "发版", done: false },
      ],
    },
  };
  assert.equal(extractCardCopyText(todoCard), "- [x] 跑单测\n- [ ] 发版");

  const tableCard = {
    id: "c_6",
    type: "table",
    title: "营收",
    content: "",
    table: {
      columns: [
        { key: "q", label: "季度" },
        { key: "v", label: "收入", align: "right" },
      ],
      rows: [{ q: "Q1", v: "120" }],
      caption: "单位：万元",
    },
  };
  assert.equal(extractCardCopyText(tableCard), "| 季度 | 收入 |\n| --- | ---: |\n| Q1 | 120 |\n\n单位：万元");
});

test("extractCardCopyText handles vector/diagram/mindmap/empty cards safely", () => {
  assert.equal(
    extractCardCopyText({ id: "c_7", type: "svg", title: "架构", content: "", svg: { source: "<svg></svg>" } }),
    "<svg></svg>",
  );
  assert.equal(
    extractCardCopyText({ id: "c_8", type: "mermaid", title: "流程", content: "", mermaid: { source: "graph LR\nA-->B" } }),
    "graph LR\nA-->B",
  );
  assert.equal(
    extractCardCopyText({
      id: "c_9",
      type: "mindmap",
      title: "脑图",
      content: "",
      mindmap: { root: { id: "r", text: "主题", children: [{ id: "a", text: "分支一", children: [] }] } },
    }),
    "- 主题\n  - 分支一",
  );
  assert.equal(canCopyCardContent({ id: "c_10", type: "text", title: "", content: "   " }), false);
  assert.equal(extractCardCopyText({ id: "c_11", type: "text", title: "仅标题", content: "" }), "仅标题");
});
