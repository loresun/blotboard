import { expect, test, type Page } from "@playwright/test";

/**
 * 备份与恢复：**说成功就得真成功，说取消就得真取消**。
 *
 * 这一份守的是两条以前会静默出事的路：
 *  ① 带附件的画板包导进浏览器库 —— 以前卡片留着、字节丢了，卡面「图片缺失」，
 *     再备份一次连引用都没了，而 toast 说的是「已导入 1 块画板」；
 *  ② 恢复备份的确认 —— 以前是一句 `window.confirm`，点「取消」并不取消，
 *     它只是退回「合并恢复」，照样按 id 覆盖已有的板。
 */

/** 一张真的 4×4 PNG（走完整上传校验：签名 / 白名单 / 扩展名都得对得上） */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR4nGP8z8Dwn4GBgYGJAQpgDAAyowIGmYU7uAAAAABJRU5ErkJggg==";

/** 在服务端库里造一块「带图片的板」，并把它导成画板包（附件字节在里面）。 */
async function serverBundleWithImage(page: Page): Promise<{ bundle: any; wrapped: any; boardId: string }> {
  const upload = await (
    await page.request.post("/api/uploads", {
      headers: { "content-type": "image/png", "x-file-name": "e2e-pixel.png", "x-board-web": "1" },
      data: Buffer.from(PNG_BASE64, "base64"),
    })
  ).json();
  const board = (
    await (
      await page.request.post("/api/boards", {
        headers: { "x-board-web": "1" },
        data: { name: `带图片的板 ${Date.now()}`, group: "备份回归" },
      })
    ).json()
  ).board;
  await page.request.post(`/api/boards/${board.id}/cards`, {
    headers: { "x-board-web": "1" },
    data: { type: "image", title: "配图", file: { uploadId: upload.upload.id, name: "e2e-pixel.png" } },
  });
  const wrapped = await (await page.request.get(`/api/boards/export?ids=${board.id}&format=json&children=0`)).json();
  return { bundle: wrapped.bundle, wrapped, boardId: board.id };
}

test.describe("备份与恢复", () => {
  test("浏览器库收下附件字节：看得见、刷新还在、还能再导出去", async ({ page }) => {
    const { bundle, wrapped, boardId } = await serverBundleWithImage(page);
    expect(bundle.assets.length).toBe(1);
    expect(bundle.assets[0].data).toBeTruthy();

    const workspace = `assets-${Date.now()}`;
    await page.goto(`/?storage=browser&workspace=${workspace}`);
    await page.waitForFunction(() => Boolean(window.blotboardBrowser));
    // 先等这个 workspace 的首块板落定，再导入：整份板列表的读-改-写要拿到锁才不互相覆盖
    await expect(page.locator(".board-item").first()).toBeVisible();

    const imported = await page.evaluate(
      async (text) => window.blotboardBrowser!.importBundle(text, "merge"),
      JSON.stringify(bundle),
    );
    expect(imported.imported).toBe(1);
    expect(imported.assets).toEqual({ stored: 1, reused: 0, missing: 0 });
    expect(imported.notes).toEqual([]);

    // 卡面真的显示出图来，而不是那句「图片缺失」
    await page.goto(`/?storage=browser&workspace=${workspace}&board=${boardId}`);
    const image = page.locator("img.card-img").first();
    await expect(image).toBeVisible();
    await expect(page.getByText("图片缺失")).toHaveCount(0);
    expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(4);

    // 字节在 IndexedDB 里，不是这一次页面会话的内存
    await page.reload();
    await expect(page.locator("img.card-img").first()).toBeVisible();
    await expect(page.getByText("图片缺失")).toHaveCount(0);

    // 再备份一次：字节要原样带出去（以前这一步会把附件洗干净）
    const roundTrip = await page.evaluate(async () => window.blotboardBrowser!.exportBundle());
    expect(roundTrip.assets?.length).toBe(1);
    expect(roundTrip.assets?.[0].data).toBeTruthy();
    expect(roundTrip.assets?.[0].bytes).toBe(bundle.assets[0].bytes);

    // 服务端导出的 `{ok,bundle}` 响应包装：两边同一个解析入口，不该一个收一个拒
    const fromWrapper = await page.evaluate(
      async (text) => window.blotboardBrowser!.importBundle(text, "copy"),
      JSON.stringify(wrapped),
    );
    expect(fromWrapper.imported).toBe(1);

    // 字节真的没跟过来时**要说出来**，不能算完整成功
    const withoutBytes = await page.evaluate(async (text) => {
      const parsed = JSON.parse(text);
      parsed.boards = parsed.boards.map((board: { id: string; cards: any[] }) => ({
        ...board,
        id: `${board.id}_x`,
        cards: board.cards.map((card) => ({ ...card, file: { ...card.file, uploadId: "web-0000000000000-deadbeefcafe.png" } })),
      }));
      parsed.assets = [];
      return window.blotboardBrowser!.importBundle(JSON.stringify(parsed), "merge");
    }, JSON.stringify(bundle));
    expect(withoutBytes.assets.missing).toBe(1);
    expect(withoutBytes.notes.join()).toContain("附件没跟着这份文件过来");
  });

  test("恢复备份的三个出口：取消零写入 / 合并恢复 / 整库恢复", async ({ page }) => {
    const workspace = `restore-${Date.now()}`;
    await page.goto(`/?storage=browser&workspace=${workspace}`);
    await page.waitForFunction(() => Boolean(window.blotboardBrowser));
    await expect(page.locator(".board-item").first()).toBeVisible();

    // 本机：首块板 + 一块「只有本机有」的板；备份：本机首块板的旧版本 + 一块新板
    const seed = await page.evaluate(async () => {
      const boards = await window.blotboardBrowser!.listBoards();
      const onlyLocalId = "b_e2eonlylocal";
      await window.blotboardBrowser!.putBoard({
        id: onlyLocalId,
        name: "只有本机有的板",
        parentId: null,
        group: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        viewport: { x: 0, y: 0, zoom: 1 },
        cards: [],
        edges: [],
        comments: [],
      } as never);
      return { firstId: boards[0].id, firstName: boards[0].name, onlyLocalId };
    });
    const backup = {
      format: "blotboard.boards",
      version: 1,
      exportedAt: Date.now(),
      generator: "e2e",
      boards: [
        { id: seed.firstId, name: "备份里的首块板", parentId: null, group: "", createdAt: 1, updatedAt: 2, viewport: { x: 0, y: 0, zoom: 1 }, cards: [], edges: [], comments: [] },
        { id: "b_e2ebackuponly", name: "只有备份里有的板", parentId: null, group: "", createdAt: 1, updatedAt: 2, viewport: { x: 0, y: 0, zoom: 1 }, cards: [], edges: [], comments: [] },
      ],
    };
    const file = { name: "backup.blotboard.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) };

    const openRestore = async () => {
      // 取消只收起确认块、不关面板（用户多半想换个文件再来一次），所以别重复点胶囊
      if (!(await page.locator(".storage-panel").isVisible())) await page.locator(".storage-mode-chip").click();
      await expect(page.locator(".storage-panel")).toBeVisible();
      await page.locator(".storage-restore-input").setInputFiles(file);
      await expect(page.locator(".storage-restore-confirm")).toBeVisible();
    };

    /* ① 影响摘要：这份备份到底会动什么，问之前先说清楚 */
    await openRestore();
    const summary = page.locator(".storage-restore-summary");
    await expect(summary).toContainText("备份里有 2 块画板");
    await expect(summary).toContainText("其中 1 块与本机同 id");
    await expect(summary).toContainText("另外 1 块本机没有");
    await expect(summary).toContainText("本机还有 1 块画板不在这份备份里");

    /* ② 取消 = 一个字节都不写（以前这里点「取消」照样按 id 覆盖） */
    await page.locator(".storage-restore-cancel").click();
    await expect(page.locator(".storage-restore-confirm")).toHaveCount(0);
    const afterCancel = await page.evaluate(async () => {
      const boards = await window.blotboardBrowser!.listBoards();
      return { ids: boards.map((board) => board.id), names: boards.map((board) => board.name) };
    });
    expect(afterCancel.ids).toContain(seed.onlyLocalId);
    expect(afterCancel.ids).not.toContain("b_e2ebackuponly");
    expect(afterCancel.names).toContain(seed.firstName);
    expect(afterCancel.names).not.toContain("备份里的首块板");

    /* ③ 合并恢复：同 id 由备份覆盖，本机独有的板留着 */
    await openRestore();
    await page.locator(".storage-restore-merge").click();
    // 恢复完会整页刷新：等左栏真的出现备份里那块板，别在刷新的半路上断言
    await expect(page.locator(".board-item", { hasText: "备份里的首块板" })).toBeVisible();
    const afterMerge = await page.evaluate(async () => {
      const boards = await window.blotboardBrowser!.listBoards();
      return { ids: boards.map((board) => board.id), names: boards.map((board) => board.name) };
    });
    expect(afterMerge.names).toContain("备份里的首块板");
    expect(afterMerge.ids).toContain("b_e2ebackuponly");
    expect(afterMerge.ids).toContain(seed.onlyLocalId);

    /* ④ 整库恢复：回到备份那一刻，备份里没有的板一并删掉 */
    await openRestore();
    await expect(page.locator(".storage-restore-summary")).toContainText("本机还有 1 块画板不在这份备份里");
    await page.locator(".storage-restore-replace").click();
    await expect(page.locator(".board-item", { hasText: "只有本机有的板" })).toHaveCount(0);
    await expect(page.locator(".board-item", { hasText: "只有备份里有的板" })).toBeVisible();
    const afterReplace = await page.evaluate(async () => {
      const boards = await window.blotboardBrowser!.listBoards();
      return boards.map((board) => board.id);
    });
    expect(afterReplace).not.toContain(seed.onlyLocalId);
    expect(afterReplace.sort()).toEqual([seed.firstId, "b_e2ebackuponly"].sort());
  });

  test("服务端库的恢复：只给取消 / 合并恢复，取消同样零写入", async ({ page }) => {
    const { bundle, boardId } = await serverBundleWithImage(page);
    await page.goto("/");
    await expect(page.locator(".board-item").first()).toBeVisible();

    // 备份里的板改个名：合并恢复会按原 id 盖回去，取消则一个字不动
    const backup = { ...bundle, boards: bundle.boards.map((board: { name: string }) => ({ ...board, name: "恢复后的名字" })) };
    const file = { name: "server-backup.blotboard.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) };

    await page.locator(".storage-mode-chip").click();
    await expect(page.locator(".storage-panel")).toBeVisible();
    await page.locator(".storage-restore-input").setInputFiles(file);
    await expect(page.locator(".storage-restore-confirm")).toBeVisible();
    // 服务端库不给「整库恢复」这一档（删板有快照兜底，整库推平没有）
    await expect(page.locator(".storage-restore-replace")).toHaveCount(0);
    await expect(page.locator(".storage-restore-summary")).toContainText("其中 1 块与本机同 id");
    await expect(page.locator(".storage-restore-confirm small")).toContainText("服务端库只做「合并恢复」");

    await page.locator(".storage-restore-cancel").click();
    await expect(page.locator(".storage-restore-confirm")).toHaveCount(0);
    const untouched = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(untouched.board.name).not.toBe("恢复后的名字");

    await page.locator(".storage-restore-input").setInputFiles(file);
    await expect(page.locator(".storage-restore-confirm")).toBeVisible();
    await page.locator(".storage-restore-merge").click();
    await expect(page.locator(".board-item").first()).toBeVisible();
    const restored = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(restored.board.name).toBe("恢复后的名字");
  });
});
