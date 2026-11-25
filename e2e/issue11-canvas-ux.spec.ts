import { expect, test, type Page } from "@playwright/test";

const CARD = ".react-flow__node";

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

test.describe("Issue #11 无限画布交互、一键复制内容与大尺寸卡片", () => {
  test("1 & 2. 空白处拖动画布（类 ComfyUI）与滚轮直接缩放均可从设置开启并生效", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-Issue11-交互-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "text", title: "交互测试卡", content: "验证卡片内选择、空白处平移与滚轮缩放", x: 240, y: 200, w: 300, h: 160 },
    });
    await page.locator('.top-btn[aria-label="刷新"]').click();
    const card = page.locator(CARD).first();
    await expect(card).toBeVisible();

    // 打开设置抽屉，开启「空白处拖动画布」与「滚轮直接缩放」
    await page.locator('.top-btn[aria-label="设置"]').click();
    const drawer = page.locator(".settings-drawer.open");
    await expect(drawer).toBeVisible();
    await drawer.locator('.set-row[data-toggle="autopan"]').click();
    await drawer.locator('.set-row[data-toggle="wheelzoom"]').click();
    await expect(drawer.locator('.set-row[data-toggle="autopan"]')).toHaveAttribute("aria-pressed", "true");
    await expect(drawer.locator('.set-row[data-toggle="wheelzoom"]')).toHaveAttribute("aria-pressed", "true");
    await drawer.locator(".drawer-close").click();

    await expect(page.locator(".canvas-wrap")).toHaveClass(/tool-select/);
    await expect(page.locator(".canvas-wrap")).toHaveClass(/auto-pan/);

    // ① 卡片内部拖动仍保持选择工具行为：移动卡片坐标
    const beforeCard = (await (await page.request.get(`/api/boards/${boardId}`)).json()).board.cards[0];
    const cardBox = (await card.boundingBox())!;
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 14);
    await page.mouse.down();
    await page.mouse.move(cardBox.x + cardBox.width / 2 + 120, cardBox.y + 80, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1100);
    const movedCard = (await (await page.request.get(`/api/boards/${boardId}`)).json()).board.cards[0];
    expect(movedCard.x).not.toBe(beforeCard.x);

    // ② 卡片外空白区左键拖动自动切抓手平移画布
    const beforeVp = (await (await page.request.get(`/api/boards/${boardId}`)).json()).board.viewport;
    const paneBox = (await page.locator(".react-flow__pane").boundingBox())!;
    const blankX = paneBox.x + paneBox.width * 0.85;
    const blankY = paneBox.y + paneBox.height * 0.82;
    await page.mouse.move(blankX, blankY);
    await page.mouse.down();
    await page.mouse.move(blankX - 160, blankY - 90, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1100);
    const pannedVp = (await (await page.request.get(`/api/boards/${boardId}`)).json()).board.viewport;
    expect(pannedVp.x).not.toBe(beforeVp?.x ?? 0);

    // ③ 滚轮直接缩放画布（不按 Ctrl/⌘ 修饰键）
    const zoomTextBefore = await page.locator(".zoom-label").textContent();
    await page.mouse.move(blankX, blankY);
    await page.mouse.wheel(0, -240);
    await expect.poll(async () => page.locator(".zoom-label").textContent()).not.toBe(zoomTextBefore);
  });

  test("3 & 4. 文本卡与代码卡一键复制纯文本内容（非卡片 JSON）且卡片支持更大尺寸上限", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await boot(page);
    await newBoard(page, `E2E-Issue11-复制与大尺寸-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // ① 建一张超宽超高的卡片（超过旧上限 1600x2400，验证后端与前端都不截断）
    const createdLarge = await (
      await page.request.post(`/api/boards/${boardId}/cards`, {
        headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
        data: { type: "text", title: "大尺寸文本卡", content: "无限画布自由调节尺寸", x: 760, y: 520, w: 2800, h: 2600 },
      })
    ).json();
    expect(createdLarge.card.w).toBe(2800);
    expect(createdLarge.card.h).toBe(2600);

    // ② 在可视区正中放一张常规文本卡与一张代码卡，验证一键复制纯文本内容（非卡片 JSON）
    const textContent = "这是纯文本内容第一行\n第二行用于验证一键复制";
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "text", title: "一键复制文本卡", content: textContent, x: 220, y: 200, w: 360, h: 180 },
    });

    const codeSource = "export function greet(name: string) {\n  return `hello ${name}`;\n}";
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "code", title: "示例代码", code: { language: "ts", source: codeSource }, x: 640, y: 200, w: 420, h: 220 },
    });

    await page.locator('.top-btn[aria-label="刷新"]').click();
    const textCard = page.locator(CARD, { hasText: "一键复制文本卡" });
    await expect(textCard).toBeVisible();

    // 通过卡头一键复制按钮复制文本卡纯文本（确保不是 blotboardClipboard JSON）
    await textCard.hover();
    await textCard.locator('.card-tool[data-act="copy-content"]').click();
    const copiedText = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedText).toBe(textContent);
    expect(copiedText).not.toContain("blotboardClipboard");

    // 阅读模式顶栏同样提供一键复制内容按钮
    await textCard.hover();
    await textCard.locator('.card-tool[aria-label="放大阅读"]').click();
    const reader = page.locator(".reader-modal");
    await expect(reader).toBeVisible();
    await expect(reader.locator('button[data-act="copy-content"]')).toBeVisible();
    await reader.locator('button[data-act="copy-content"]').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(textContent);
    await page.keyboard.press("Escape");
  });
});
