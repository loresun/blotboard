import { expect, test } from "@playwright/test";

test.describe("浏览器隔离存储", () => {
  test("workspace 隔离、刷新持久化、Agent API 与服务端不串库", async ({ page }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const alpha = `alpha-${suffix}`;
    const beta = `beta-${suffix}`;

    await page.goto(`/?storage=browser&workspace=${alpha}`);
    await expect(page.locator(".storage-mode-chip.browser")).toContainText(alpha);
    await expect(page.locator(".board-item").first()).toBeVisible();

    const result = await page.evaluate(async () => {
      const api = window.blotboardBrowser;
      if (!api) throw new Error("browser agent api missing");
      const boards = await api.listBoards();
      const board = await api.getBoard(boards[0].id);
      board.cards.push({
        id: `c_agent_${Date.now().toString(36)}`,
        type: "text",
        title: "Agent 写进浏览器",
        content: "只在 IndexedDB",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "agent",
        x: 120,
        y: 100,
        w: 300,
        h: 180,
        z: 1,
        color: "green",
        agentPrompt: "",
        frameId: null,
      });
      await api.putBoard(board);
      return { boardId: board.id, capabilities: await api.capabilities(), bundle: await api.exportBundle() };
    });

    expect(result.capabilities.storage).toBe("indexeddb");
    expect(result.capabilities.workspace).toBe(alpha);
    await expect(page.locator(".card-title", { hasText: "Agent 写进浏览器" })).toBeVisible();

    await page.reload();
    await expect(page.locator(".card-title", { hasText: "Agent 写进浏览器" })).toBeVisible();

    const serverBoards = await (await page.request.get("/api/boards")).json();
    expect(serverBoards.boards.some((board: { id: string }) => board.id === result.boardId)).toBe(false);

    await page.goto(`/?storage=browser&workspace=${beta}`);
    await expect(page.locator(".storage-mode-chip.browser")).toContainText(beta);
    await expect(page.locator(".card-title", { hasText: "Agent 写进浏览器" })).toHaveCount(0);

    // 浏览器库的备份就是**画板包**（与服务端库同一种格式，两边可以互相导）
    expect((result.bundle as { format: string }).format).toBe("blotboard.boards");

    await page.evaluate(async (bundle) => {
      if (!window.blotboardBrowser) throw new Error("browser agent api missing");
      await window.blotboardBrowser.importBundle(bundle, "replace");
    }, result.bundle);
    await expect(page.locator(".card-title", { hasText: "Agent 写进浏览器" })).toBeVisible();

    // copy = 一律当新板收下：同一份包再导一次，得到第二块板而不是覆盖第一块
    const before = await page.locator(".board-item").count();
    const copied = await page.evaluate(async (bundle) => {
      if (!window.blotboardBrowser) throw new Error("browser agent api missing");
      return window.blotboardBrowser.importBundle(bundle, "copy");
    }, result.bundle);
    expect(copied.boardIds.length).toBe((result.bundle as { boards: unknown[] }).boards.length);
    expect(copied.boardIds).not.toContain(result.boardId);
    await expect(page.locator(".board-item")).toHaveCount(before + copied.boardIds.length);
  });

  test("存储面板明确展示能力边界", async ({ page }) => {
    const workspace = `panel-${Date.now()}`;
    await page.goto(`/?storage=browser&workspace=${workspace}`);
    const agentLink = page.locator('.site-nav a[href^="/agent"]');
    await expect(agentLink).toHaveAttribute('href', /storage=browser.*board=b_/);
    const agentHref = await agentLink.getAttribute('href');
    const agentUrl = new URL(agentHref!, 'http://example.test');
    expect(agentUrl.searchParams.get('storage')).toBe('browser');
    expect(agentUrl.searchParams.get('workspace')).toBe(workspace);
    expect(agentUrl.searchParams.get('board')).toBeTruthy();
    await page.locator(".storage-mode-chip").click();
    await expect(page.locator(".storage-panel")).toBeVisible();
    // 能力边界的文案跟着实现走：附件字节现在**存得住也导得出去**，只是不能在这个模式里新上传
    await expect(page.locator(".storage-warning")).toContainText("不支持新上传文件、服务端快照、Runner");
    await expect(page.locator(".storage-warning")).toContainText("导入进来的图片与附件字节会跟着存下来");
    await expect(page.locator('.toolbar button', { hasText: "上传" })).toHaveCount(0);
    await expect(page.locator('.topbar button', { hasText: "历史" })).toHaveCount(0);
    await page.locator('.storage-panel button[aria-label="关闭"]').click();
    const pane = await page.locator('.react-flow__pane').boundingBox();
    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: pane!.width * .55, y: pane!.height * .65 } });
    await expect(page.getByText('复制 CDP Agent 提示词', { exact: true })).toBeVisible();
  });
});
