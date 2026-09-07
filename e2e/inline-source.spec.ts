import { expect, test, type Page } from "@playwright/test";

/**
 * 卡面上的「编辑文本」（components/cards/SourceFace.tsx）。
 *
 * 覆盖四种源码型卡片：图表卡 / SVG 卡自带一行页脚，代码卡 / 表格卡把按钮挤进原来的页脚。
 * 断言都落在**服务端那份卡片**上——卡面改完只是本地状态，存没存进去只有 API 说了算。
 */

const CARD = ".react-flow__node";
const HEADERS = { "content-type": "application/json", "x-auth-key": "e2e-token" };

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator(".board-item").first()).toBeVisible();
  await expect(page.locator(".topbar")).toBeVisible();
}

async function newBoard(page: Page, name: string) {
  await page.locator(".new-board-btn").click();
  const input = page.locator(".board-name");
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator(".board-item.active .bi-name")).toHaveText(name);
}

function currentBoardId(page: Page) {
  return page.evaluate(() => window.localStorage.getItem("blotboard_last"));
}

test.describe("卡面「编辑文本」", () => {
  test("四种源码卡：卡面改源码即存，Esc 放弃不落库", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-卡面源码-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 建卡手势别的用例已经覆盖，这里要测的是卡面上那个按钮，卡片直接走 API 建
    async function add(data: Record<string, unknown>) {
      const response = await page.request.post(`/api/boards/${boardId}/cards`, { headers: HEADERS, data });
      return (await response.json()).card.id as string;
    }
    const mermaidId = await add({ type: "mermaid", x: 60, y: 60, mermaid: { source: "graph TD\n  A[想法] --> B[任务]" } });
    const svgId = await add({ type: "svg", x: 520, y: 60, svg: { source: '<svg viewBox="0 0 200 120"><circle cx="100" cy="60" r="40"/></svg>' } });
    const codeId = await add({ type: "code", x: 60, y: 460, code: { source: "const a = 1;", language: "ts", filename: "a.ts" } });
    const tableId = await add({
      type: "table",
      x: 520,
      y: 460,
      table: { markdown: "| 季度 | 收入 |\n| --- | ---: |\n| Q1 | 120 |", caption: "季度收入" },
    });

    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(4);

    const card = (id: string) => page.locator(`${CARD}[data-id="${id}"]`);
    const box = (id: string) => card(id).locator('textarea[data-field="source-inline"]');
    async function cardOf(id: string) {
      const detail = await (await page.request.get(`/api/boards/${boardId}`)).json();
      return detail.board.cards.find((item: any) => item.id === id);
    }

    /** 点开卡面的「编辑文本」，返回框里那份草稿（应当就是这张卡现在的源码） */
    async function open(id: string) {
      await card(id).locator('[data-act="edit-source"]').click();
      await expect(box(id)).toBeVisible();
      return box(id).inputValue();
    }

    /* ① 图表卡：自带页脚 → 改源码 → 保存按钮 */
    expect(await open(mermaidId)).toBe("graph TD\n  A[想法] --> B[任务]");
    await box(mermaidId).fill("graph LR\n  A[卡面改的] --> B[存进去了]");
    await card(mermaidId).locator('[data-act="save-source"]').click();
    await expect(box(mermaidId)).toHaveCount(0);
    await expect(card(mermaidId).locator(".diagram-wrap svg")).toBeVisible();
    expect((await cardOf(mermaidId)).mermaid.source).toBe("graph LR\n  A[卡面改的] --> B[存进去了]");

    /* ② SVG 卡：Esc 放弃——框关掉，库里那份一个字没动 */
    await open(svgId);
    await box(svgId).fill('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
    await box(svgId).press("Escape");
    await expect(box(svgId)).toHaveCount(0);
    expect((await cardOf(svgId)).svg.source).toContain("circle");

    /* ③ 代码卡：按钮挤在原来的页脚里；⌘/Ctrl+Enter 保存，语言与文件名不受影响 */
    expect(await open(codeId)).toBe("const a = 1;");
    await box(codeId).fill("const a = 42;");
    await box(codeId).press("ControlOrMeta+Enter");
    await expect(box(codeId)).toHaveCount(0);
    const code = (await cardOf(codeId)).code;
    expect(code).toMatchObject({ source: "const a = 42;", language: "ts", filename: "a.ts" });

    /* ④ 表格卡：框里是 Markdown，存回去仍是结构化表格，表标题留着 */
    expect(await open(tableId)).toContain("| 季度 |");
    await box(tableId).fill("| 季度 | 收入 |\n| --- | ---: |\n| Q1 | 120 |\n| Q2 | 340 |");
    await card(tableId).locator('[data-act="save-source"]').click();
    await expect(box(tableId)).toHaveCount(0);
    const table = (await cardOf(tableId)).table;
    expect(table.rows).toHaveLength(2);
    expect(table.caption).toBe("季度收入");
  });

  test("空卡也有入口：表格卡从零填一张表", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-空表格-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const response = await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: HEADERS,
      data: { type: "table", x: 80, y: 80 },
    });
    const id = (await response.json()).card.id as string;
    await page.locator(".top-btn[aria-label='刷新']").click();

    const card = page.locator(`${CARD}[data-id="${id}"]`);
    // 空表格没有自己的页脚，按钮由 SourceFace 那行页脚给
    await card.locator('[data-act="edit-source"]').click();
    const box = card.locator('textarea[data-field="source-inline"]');
    await expect(box).toHaveValue("");
    await box.fill("| 名字 | 状态 |\n| --- | --- |\n| 空卡 | 填上了 |");
    await box.press("ControlOrMeta+Enter");
    await expect(box).toHaveCount(0);
    await expect(card.locator(".table-card")).toBeVisible();

    const detail = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const saved = detail.board.cards.find((item: any) => item.id === id);
    expect(saved.table.columns.map((column: any) => column.label)).toEqual(["名字", "状态"]);
    expect(saved.table.rows).toHaveLength(1);
  });
});
