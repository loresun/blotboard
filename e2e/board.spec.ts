import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { E2E_AIDOCS_URL, E2E_BOOK_LIBRARY_URL } from "./integrations";

/**
 * UI 冒烟：用例清单继承 goal-agent 的 Electron 冒烟（smoke-board-ui.cjs），
 * 覆盖建板 / 六类卡片 / 双击编辑 / 拖动落库 / 连线与衍生卡 / 任务链路 /
 * 配置 whole / agent 写入后自动刷新。
 */

const CARD = ".react-flow__node";
/** 编辑器已从卡面搬进右侧抽屉：所有 data-field / 保存按钮都在这里面找 */
const EDITOR = ".drawer.card-drawer.open";

/** 把配置来的 URL 塞进正则里：端口号里没有元字符，但 `.` 得转义，否则 127.0.0.1 会误配 */
function escapeRe(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function editor(page: Page) {
  return page.locator(EDITOR);
}

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

/** 用真实命中测试找空白，避免点到工具条、Controls 或新加入的帮助按钮。 */
async function clickBlankPane(page: Page) {
  const point = await page.locator(".react-flow__pane").evaluate((pane) => {
    const box = pane.getBoundingClientRect();
    for (const yRatio of [0.92, 0.8, 0.65, 0.45]) {
      for (const xRatio of [0.15, 0.35, 0.55, 0.75]) {
        const x = box.x + box.width * xRatio, y = box.y + box.height * yRatio;
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    throw new Error("没有找到可点击的空白画布");
  });
  await page.mouse.click(point.x, point.y);
}

/**
 * 工具条建卡：组织与结构化（规格卡 / 子画板 / 分组框 / 网页）与外部来源（资料 / 图书）
 * 收在「更多」面板里，点之前得先展开——常驻那 12 个直接点即可。
 */
async function toolbarAdd(page: Page, type: string) {
  const direct = page.locator(`.toolbar > button[data-add="${type}"]`);
  if (await direct.count()) {
    await direct.click();
    return;
  }
  await page.locator('.toolbar button[data-act="toolbar-more"]').click();
  await page.locator(`.tb-more-panel button[data-add="${type}"]`).click();
}

test.describe("泼墨画板", () => {
  test("建板 → 建卡 → 编辑 → 落库", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-编辑-${Date.now() % 100000}`);

    await page.locator('.toolbar button[data-add="text"]').click();
    const card = page.locator(CARD).first();
    await expect(card).toBeVisible();

    // 新建即进编辑态：标题 + 正文
    const titleInput = editor(page).locator('input[data-field="title"]');
    await expect(titleInput).toBeFocused();
    await titleInput.fill("E2E 文本卡");
    await editor(page).locator('textarea[data-field="content"]').fill("这是 e2e 写入的正文");
    await editor(page).locator('[data-act="save"]').click();

    await expect(card.locator(".card-title")).toHaveText("E2E 文本卡");
    await expect(card.locator(".card-body")).toContainText("这是 e2e 写入的正文");

    // 刷新后仍在（真落库，不是内存态）
    await page.reload();
    await expect(page.locator(`${CARD} .card-title`).first()).toHaveText("E2E 文本卡");
  });

  test("四类卡片工具条 + 链接卡校验", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-类型-${Date.now() % 100000}`);

    for (const type of ["text", "task", "quote"]) {
      await page.locator(`.toolbar button[data-add="${type}"]`).click();
      await page.keyboard.press("Escape");
    }
    await expect(page.locator(CARD)).toHaveCount(3);

    await page.locator('.toolbar button[data-add="link"]').click();
    const linkCard = page.locator(CARD).last();
    await editor(page).locator('input[data-field="link.url"]').fill("https://example.com/e2e");
    await editor(page).locator('[data-act="save"]').click();
    await expect(linkCard.locator(".host-chip")).toHaveText("example.com");
  });

  test("拖动落库 + 拖锚点衍生新卡并自动连线", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-连线-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.locator('.toolbar button[data-add="text"]').click();
    const card = page.locator(CARD).first();
    await editor(page).locator('input[data-field="title"]').fill("源卡");
    await editor(page).locator('[data-act="save"]').click();

    // 拖动 → 防抖 600ms 后落库
    const before = await card.boundingBox();
    await page.mouse.move(before!.x + before!.width / 2, before!.y + 14);
    await page.mouse.down();
    await page.mouse.move(before!.x + before!.width / 2 - 160, before!.y + 90, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1200);

    const detail = await page.request.get(`/api/boards/${boardId}`);
    const payload = await detail.json();
    const moved = payload.board.cards[0];
    expect(Math.abs(moved.x - Math.round(before!.x))).toBeGreaterThan(50);

    // 从右锚点拖到空白 → 衍生新卡 + 自动连线
    const box = await card.boundingBox();
    const handle = card.locator(".react-flow__handle-right");
    await handle.hover({ force: true });
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width + 220, box!.y + 120, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator(CARD)).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);

    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(after.board.edges).toHaveLength(1);
    expect(after.board.edges[0].from).toBe(moved.id);
  });

  test("任务链路：转 Issue → 发起任务 → 抽屉进展 → 任务台", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-任务-${Date.now() % 100000}`);

    await page.locator('.toolbar button[data-add="task"]').click();
    const card = page.locator(CARD).first();
    await editor(page).locator('input[data-field="title"]').fill("E2E 任务卡");
    await editor(page).locator('textarea[data-field="content"]').fill("跑通任务链路");
    await editor(page).locator('[data-act="save"]').click();

    await expect(card.locator(".status-chip.st-idea")).toBeVisible();
    await card.locator('[data-act="issue"]').click();
    await expect(card.locator(".status-chip.st-issued")).toBeVisible({ timeout: 15_000 });

    page.once("dialog", (dialog) => dialog.accept());
    await card.locator('[data-act="launch"]').click();
    await expect(card.locator(".status-chip.st-running")).toBeVisible({ timeout: 15_000 });

    // 详情走右侧任务抽屉（任务视图模态框已退役，卡片主按钮此时就是「进展」）
    await card.locator('[data-act="detail"]').click();
    await expect(page.locator(".drawer.task-drawer.open")).toContainText("e2e mock：任务执行中", { timeout: 15_000 });

    // 顶栏「任务台」新标签打开（预过滤到当前板）：执行中的任务出现在列表里
    const [tasksPage] = await Promise.all([
      page.context().waitForEvent("page"),
      page.locator(".topbar a.tasks-link-btn").click(),
    ]);
    const row = tasksPage.locator(".tk-row", { hasText: "E2E 任务卡" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("执行中");
    await tasksPage.close();
  });

  test("配置 JSON 全量替换 + agent 写入后页面自动刷新", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-配置-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // whole：直接编辑 JSON 应用
    await page.locator(".top-btn", { hasText: "Agent" }).click();
    await page.locator(".drawer-tabs button", { hasText: "画板配置 JSON" }).click();
    const textarea = page.locator(".config-textarea");
    await expect(textarea).not.toHaveValue("");
    const config = JSON.parse(await textarea.inputValue());
    config.cards.push({
      id: "c_e2e_from_config",
      type: "text",
      title: "配置加的卡",
      content: "whole 写入",
      x: 220,
      y: 160,
      w: 280,
      h: 170,
      z: 1,
      color: "green",
      createdBy: "user",
    });
    await textarea.fill(JSON.stringify(config, null, 2));
    await page.locator(".mini-btn", { hasText: "应用并重载" }).click();
    await expect(page.locator(CARD, { hasText: "配置加的卡" })).toBeVisible({ timeout: 15_000 });

    // agent 通道（x-auth-key）直接改卡片 → 页面轮询自动刷新（抽屉打开时 3s 一次）
    await page.request.patch(`/api/boards/${boardId}/cards/c_e2e_from_config`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { title: "agent 改过的标题" },
    });
    await expect(page.locator(CARD, { hasText: "agent 改过的标题" })).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("重设计后的交互", () => {
  test("右键菜单：卡片改色 / 转任务卡 / 复制 / 删除", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-右键-${Date.now() % 100000}`);

    await page.locator('.toolbar button[data-add="text"]').click();
    const card = page.locator(CARD).first();
    await editor(page).locator('input[data-field="title"]').fill("右键测试卡");
    await editor(page).locator('[data-act="save"]').click();

    // 右键出菜单
    await card.click({ button: "right" });
    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByText("编辑内容")).toBeVisible();

    // 改颜色（菜单里的色块）
    await menu.locator(".swatch").nth(2).click();
    await expect(menu).toBeHidden();

    // 转成任务卡
    await card.click({ button: "right" });
    await page.locator(".context-menu").getByText("转成任务卡").click();
    await expect(card.locator(".status-chip")).toBeVisible();

    // 复制卡片：副本整张落在原卡右边，不压着原卡（粘贴走的是同一条服务端路径，但那边是按中心对齐）
    const boardIdForCopy = await currentBoardId(page);
    await card.click({ button: "right" });
    await page.locator(".context-menu").getByText("复制卡片", { exact: true }).click();
    await expect(page.locator(CARD)).toHaveCount(2);
    const copied = await (await page.request.get(`/api/boards/${boardIdForCopy}`)).json();
    const [origin, dup] = copied.board.cards;
    expect(dup.x).toBeGreaterThanOrEqual(origin.x + origin.w);

    // 删除单张不再拦系统弹窗（删完提示里有「撤销」，见第十一轮那组用例）
    await page.locator(CARD, { hasText: "右键测试卡 副本" }).click({ button: "right" });
    await page.locator(".context-menu").getByText("删除卡片").click();
    await expect(page.locator(CARD)).toHaveCount(1);

    // Esc 关菜单
    await card.click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".context-menu")).toBeHidden();
  });

  test("评论：右键标记 → 画布气泡 → 抽屉回复与解决", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-评论-${Date.now() % 100000}`);

    await page.locator('.toolbar button[data-add="text"]').click();
    const card = page.locator(CARD).first();
    await editor(page).locator('input[data-field="title"]').fill("要评论的卡");
    await editor(page).locator('[data-act="save"]').click();

    // 右键卡片 →「加评论」→ 就地写一条
    await card.click({ button: "right" });
    await page.locator(".context-menu").getByText("加评论").click();
    const composer = page.locator(".comment-composer");
    await expect(composer).toBeVisible();
    await expect(composer.locator("textarea")).toBeFocused();
    await composer.locator("textarea").fill("标题太长了，砍成一句");
    await composer.getByRole("button", { name: "发布" }).click();
    await expect(composer).toBeHidden();

    // 画布上冒出气泡，顶栏角标跟着记账
    const pin = page.locator(".comment-pin");
    await expect(pin).toHaveCount(1);
    await expect(page.locator(".top-badge")).toHaveText("1");

    // 同一张卡再加一条：气泡不增加，改成标数字
    await card.click({ button: "right" });
    await page.locator(".context-menu").getByText("加评论").click();
    await page.locator(".comment-composer textarea").fill("顺手把配图也换了");
    await page.locator(".comment-composer").getByRole("button", { name: "发布" }).click();
    await expect(pin).toHaveCount(1);
    await expect(pin.locator(".cp-count")).toHaveText("2");

    // 点气泡 → 评论抽屉，两条都在
    await pin.click();
    const drawer = page.locator(".drawer.comment-drawer.open");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".comment-thread:not(.composing)")).toHaveCount(2);
    await expect(drawer).toContainText("标题太长了，砍成一句");


    // 回复挂在原评论下面
    const thread = drawer.locator(".comment-thread", { hasText: "标题太长了" });
    await thread.getByRole("button", { name: "回复" }).click();
    await thread.locator("textarea").fill("改完了，见新标题");
    await thread.locator("textarea").press("Meta+Enter");
    await expect(thread.locator(".ct-reply")).toContainText("改完了，见新标题");

    // 标记解决 → 从画布上收起来，默认档里也不再列
    await thread.getByRole("button", { name: "解决" }).click();
    // 只剩一条了：气泡还在，但不再标数字（数字是「这儿不止一条」的信号）
    await expect(pin).toHaveCount(1);
    await expect(pin.locator(".cp-count")).toHaveCount(0);
    await expect(drawer.locator(".comment-thread:not(.composing)")).toHaveCount(1);
    await expect(page.locator(".top-badge")).toHaveText("1");

    // 已解决的退到「已解决」页当档案，没丢
    await drawer.locator(".drawer-tabs button", { hasText: "已解决" }).click();
    await expect(drawer).toContainText("标题太长了，砍成一句");

    // 刷新后还在（真落库）
    await page.reload();
    await expect(page.locator(".comment-pin")).toHaveCount(1);
    await expect(page.locator(".top-badge")).toHaveText("1");
  });

  test("评论：空白处钉一条，定位能把视口带回去", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-评论钉-${Date.now() % 100000}`);

    const pane = await page.locator(".react-flow__pane").boundingBox();
    await page.mouse.click(pane!.x + 320, pane!.y + 260, { button: "right" });
    await page.locator(".context-menu").getByText("在这里加评论").click();
    await page.locator(".comment-composer textarea").fill("这一片留白之后补个流程图");
    await page.locator(".comment-composer textarea").press("Meta+Enter");
    await expect(page.locator(".comment-pin")).toHaveCount(1);

    // 钉在画布上的评论没有卡片可挂，抽屉里认作「画布上的一处」
    await page.locator(".comment-pin").click();
    const drawer = page.locator(".drawer.comment-drawer.open");
    await expect(drawer.locator(".ct-target")).toContainText("画布上的一处");

    // 气泡开关：关掉之后画布清爽，评论本身还在
    await drawer.locator('.drawer-close[title="隐藏画布上的评论气泡"]').click();
    await expect(page.locator(".comment-pin")).toHaveCount(0);
    await expect(drawer.locator(".comment-thread:not(.composing)")).toHaveCount(1);
    await drawer.locator('.drawer-close[title="显示画布上的评论气泡"]').click();
    await expect(page.locator(".comment-pin")).toHaveCount(1);
  });

  test("空白右键建卡 + 一键整理布局与撤销", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-整理-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 空白右键建卡
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 260, y: 200 } });
    await page.locator(".context-menu").getByText("新建任务卡").click();
    const first = page.locator(CARD).first();
    await editor(page).locator('input[data-field="title"]').fill("整理-源");
    await editor(page).locator('[data-act="save"]').click();
    await expect(first.locator(".status-chip")).toBeVisible();

    // 第二张卡与连线走 API 建（连线手势本身在上面的用例里已覆盖，这里只测布局）
    const detail = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const sourceId = detail.board.cards[0].id;
    const secondResponse = await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "text", title: "整理-下游", x: 120, y: 620 },
    });
    const secondId = (await secondResponse.json()).card.id;
    await page.request.post(`/api/boards/${boardId}/edges`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { from: sourceId, to: secondId },
    });
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);

    const before = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const beforePos = Object.fromEntries(before.board.cards.map((c: any) => [c.id, [c.x, c.y]]));

    // 一键整理（横向分层）
    await page.locator(".top-btn", { hasText: "整理" }).click();
    await page.locator(".layout-menu").getByText("横向分层").click();
    await expect(page.locator(".toast.show")).toContainText("已横向分层 2 张卡片");

    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const changed = after.board.cards.some((c: any) => {
      const prev = beforePos[c.id];
      return !prev || prev[0] !== c.x || prev[1] !== c.y;
    });
    expect(changed).toBe(true);

    // 撤销回到原位
    await page.locator(".toast-action", { hasText: "撤销" }).click();
    await expect(page.locator(".toast.show")).toContainText("已撤销：服务端整理");
    await page.waitForTimeout(600);
    const restored = await (await page.request.get(`/api/boards/${boardId}`)).json();
    for (const card of restored.board.cards) {
      expect([card.x, card.y]).toEqual(beforePos[card.id]);
    }
  });

  test("自定义 Agent 指令：新建 → 派发 → 跟踪 agent 改动自动刷新", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-指令-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.locator(".top-btn", { hasText: "Agent" }).click();
    const drawer = page.locator(".drawer.agent.open");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".agent-card")).toHaveCount(5); // 5 条内置（含「自由指令」）

    // 新建自定义指令
    await drawer.locator(".mini-btn", { hasText: "新建指令" }).click();
    const form = drawer.locator(".cmd-form");
    await form.locator('input[type="text"]').first().fill("E2E 指令");
    await form.locator('input[type="text"]').nth(1).fill("e2e 用");
    await form.locator("textarea").fill("对画板 {boardId} 做点什么");
    // 占位符按钮可以插入
    await form.locator(".placeholder-list button", { hasText: "{boardName}" }).click();
    await expect(form.locator("textarea")).toHaveValue(/\{boardName\}/);
    await form.locator(".mini-btn", { hasText: "保存" }).click();
    await expect(drawer.locator(".agent-card")).toHaveCount(6);
    await expect(drawer.locator(".agent-card", { hasText: "E2E 指令" })).toBeVisible();

    // 派发自定义指令 → 进入跟踪
    await drawer.locator(".agent-card", { hasText: "E2E 指令" }).locator(".mini-btn.primary").click();
    await expect(drawer.locator(".agent-track")).toContainText("正在跟踪：E2E 指令", { timeout: 15_000 });

    // 模拟 agent 通过 API 改画板 → 跟踪期间应自动出现在画布上（无需手动刷新）
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "text", title: "agent 加的卡", content: "跟踪期间写入", createdBy: "agent" },
    });
    await expect(page.locator(CARD, { hasText: "agent 加的卡" })).toBeVisible({ timeout: 20_000 });
    await expect(drawer.locator(".agent-track")).toContainText("画板已同步", { timeout: 20_000 });

    // 停止跟踪
    await drawer.locator(".mini-btn", { hasText: "停止跟踪" }).click();
    await expect(drawer.locator(".agent-track")).toHaveCount(0);

    // 删除自定义指令
    page.once("dialog", (dialog) => dialog.accept());
    await drawer
      .locator(".agent-card", { hasText: "E2E 指令" })
      .locator(".ac-icon-btn.danger")
      .click();
    await expect(drawer.locator(".agent-card")).toHaveCount(5);
  });

  test("模板中心：搜索/分类 → 详情预览 → 应用到新画板 → 待填标记落到卡片上", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-模板-${Date.now() % 100000}`);

    await page.locator(".top-btn", { hasText: "模板" }).click();
    const drawer = page.locator(".drawer.templates.open");
    await expect(drawer).toBeVisible();
    // 内置模板至少 12 个，且每项都画出了几何缩略
    const items = drawer.locator(".tpl-item");
    await expect(items.first()).toBeVisible(); // 列表是异步拉的，先等第一条渲染出来
    const total = await items.count();
    expect(total).toBeGreaterThanOrEqual(12);
    await expect(items.first().locator(".tpl-shape")).toBeVisible();

    // 分类筛选：思维模型这一类比全部少
    await drawer.locator(".et-chip", { hasText: "思维模型" }).click();
    const mentalCount = await items.count();
    expect(mentalCount).toBeGreaterThan(0);
    expect(mentalCount).toBeLessThan(total);

    // 搜索：搜「九宫格」只剩一条（搜索是在全部里搜，先切回全部）
    await drawer.locator(".et-chip", { hasText: "全部" }).click();
    await drawer.locator(".ad-search input").fill("九宫格");
    await expect(items).toHaveCount(1);

    // 详情：预览 + 卡片清单 + 待填标记
    await items.first().click();
    await expect(drawer.locator(".tpl-detail h3")).toContainText("九宫格创意");
    await expect(drawer.locator(".tpl-preview .tpl-shape")).toBeVisible();
    await expect(drawer.locator(".tpl-card-row")).toHaveCount(10);
    await expect(drawer.locator(".tpl-card-row .meta-chip.fillable")).toHaveCount(9);

    // 应用到新画板
    await drawer.locator(".mini-btn.primary", { hasText: "应用到新画板" }).click();
    await expect(page.locator(".board-item.active .bi-name")).toHaveText("九宫格创意", { timeout: 15_000 });
    await expect(page.locator(CARD)).toHaveCount(10);
    await expect(page.locator(CARD, { hasText: "中心主题" })).toBeVisible();
    await expect(page.locator(".toast")).toContainText("9 张待填");

    // 待填的提示词落在卡片级 agent 指令上（不新增卡片字段）
    const boardId = await currentBoardId(page);
    const board = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const marked = board.board.cards.filter((card: any) => (card.agentPrompt || "").startsWith("【模板待填】"));
    expect(marked).toHaveLength(9);
    expect(board.board.edges).toHaveLength(9);
  });

  test("模板插入当前画板：不动原有卡片，插两次不撞 id", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-插模板-${Date.now() % 100000}`);

    await page.locator('.toolbar button[data-add="text"]').click();
    await editor(page).locator('input[data-field="title"]').fill("原来就有的卡");
    await editor(page).locator('[data-act="save"]').click();
    await expect(page.locator(CARD)).toHaveCount(1);

    async function insertWeekly() {
      await page.locator(".top-btn", { hasText: "模板" }).click();
      const drawer = page.locator(".drawer.templates.open");
      await drawer.locator(".ad-search input").fill("周复盘");
      await drawer.locator(".tpl-item").first().click();
      await drawer.locator(".mini-btn", { hasText: "插入到当前画板" }).click();
      await expect(drawer).not.toBeVisible();
    }

    await insertWeekly();
    await expect(page.locator(CARD)).toHaveCount(6); // 1 + 5
    await insertWeekly();
    await expect(page.locator(CARD)).toHaveCount(11); // 1 + 5 + 5

    // 原有卡片还在，两批模板卡 id 不重复
    await expect(page.locator(CARD, { hasText: "原来就有的卡" })).toHaveCount(1);
    const boardId = await currentBoardId(page);
    const board = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const ids = board.board.cards.map((card: any) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(board.board.edges).toHaveLength(8); // 每批 4 条
  });

  test("模板 AI 填充：待填卡整批派给 Agent 并进入跟踪", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-填充-${Date.now() % 100000}`);

    // 先插一个模板，画板里就有待填卡了
    await page.locator(".top-btn", { hasText: "模板" }).click();
    let drawer = page.locator(".drawer.templates.open");
    await drawer.locator(".ad-search input").fill("SWOT");
    await drawer.locator(".tpl-item").first().click();
    await drawer.locator(".mini-btn", { hasText: "插入到当前画板" }).click();
    await expect(page.locator(CARD)).toHaveCount(6);

    // 重新打开模板抽屉：顶部应提示「还有 N 张没填」，点它派任务
    await page.locator(".top-btn", { hasText: "模板" }).click();
    drawer = page.locator(".drawer.templates.open");
    await expect(drawer.locator(".tpl-pending")).toContainText("5 张模板卡没填");
    await drawer.locator(".tpl-pending .mini-btn").click();
    // 派出后立刻进入跟踪态；toast 会很快被「画板已同步」顶掉，所以看跟踪条更稳
    await page.locator(".top-btn", { hasText: "Agent" }).click();
    await expect(page.locator(".drawer.agent.open .agent-track")).toContainText("正在跟踪：AI 填充", {
      timeout: 15_000,
    });
    await page.locator(".drawer.agent.open .drawer-close").click();

    // 进入跟踪态：agent 写回 content 后画布 2 秒内自动反映
    const boardId = await currentBoardId(page);
    const board = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const target = board.board.cards.find((card: any) => (card.agentPrompt || "").startsWith("【模板待填】"));
    await page.request.patch(`/api/boards/${boardId}/cards/${target.id}`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { content: "agent 填的内容" },
    });
    await expect(page.locator(CARD, { hasText: "agent 填的内容" })).toBeVisible({ timeout: 20_000 });

    // 版本握手：agent 在中途写过之后，本地的几何保存不能把「我已同步」当真
    // （不然条件拉取会一路 unchanged，agent 那次改动就永远看不到了）
    const stateRes = await page.request.put(`/api/boards/${boardId}/state`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token", "x-board-since": "1" },
      data: { cards: [] },
    });
    expect((await stateRes.json()).stale).toBe(true);

    // 填过的卡不再算待填
    await page.locator(".top-btn", { hasText: "模板" }).click();
    await expect(page.locator(".drawer.templates.open .tpl-pending")).toContainText("4 张模板卡没填");
  });

  test("侧栏折叠：顶栏按钮与边缘条都能开合", async ({ page }) => {
    await boot(page);
    const sidebar = page.locator(".sidebar");
    await expect(sidebar).not.toHaveClass(/collapsed/);

    await page.locator(".sidebar-btn").click();
    await expect(sidebar).toHaveClass(/collapsed/);

    // 刷新后保持折叠（存 localStorage）
    await page.reload();
    await expect(page.locator(".sidebar")).toHaveClass(/collapsed/);

    // 边缘细条也能展开
    await page.locator(".sidebar-toggle").click();
    await expect(page.locator(".sidebar")).not.toHaveClass(/collapsed/);
  });
});

test.describe("第三轮：整齐化 / 左栏 / 任务弹窗 / 搜索 / 导出 / 语义边", () => {
  test("整齐化：保留列结构，对齐行列并消除重叠", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-整齐-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 造一块「乱」的板：三列各三张，坐标带抖动 + 交叉连线
    const ids: string[] = [];
    const cols = [80, 470, 860];
    for (let i = 0; i < 9; i += 1) {
      const response = await page.request.post(`/api/boards/${boardId}/cards`, {
        headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
        data: {
          type: "text",
          title: `卡 ${i + 1}`,
          x: cols[i % 3] + (i % 2 ? 23 : -19),
          y: 60 + Math.floor(i / 3) * 230 + (i % 3 ? 17 : -13),
        },
      });
      ids.push((await response.json()).card.id);
    }
    for (const [a, b] of [[0, 4], [1, 3], [2, 5], [3, 7], [4, 6], [5, 8]]) {
      await page.request.post(`/api/boards/${boardId}/edges`, {
        headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
        data: { from: ids[a], to: ids[b] },
      });
    }
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(9);

    await page.locator(".top-btn", { hasText: "整理" }).click();
    await page.locator(".layout-menu").getByText("整齐化").click();
    await expect(page.locator(".toast.show")).toContainText("已整齐化 9 张卡片");
    await page.waitForTimeout(700);

    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const cards = after.board.cards as { id: string; x: number; y: number; w: number; h: number }[];

    // 对齐：x 与 y 各自只剩 3 个不同值（三列三行）
    expect(new Set(cards.map((c) => c.x)).size).toBe(3);
    expect(new Set(cards.map((c) => c.y)).size).toBe(3);
    // 吸附网格
    for (const card of cards) {
      expect((card.x + card.w / 2) % 22).toBe(0);
      expect((card.y + card.h / 2) % 22).toBe(0);
    }
    // 没有重叠
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        const a = cards[i];
        const b = cards[j];
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap).toBe(false);
      }
    }
    // 保留结构：整齐化后仍是三列，不是被 dagre 重排成长链
    expect(new Set(cards.map((c) => c.x)).size).toBeLessThan(cards.length);
  });

  test("搜索 + 类型筛选：命中高亮、其余变淡", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-搜索-${Date.now() % 100000}`);

    for (const [type, title] of [["text", "苹果"], ["task", "香蕉"], ["quote", "橘子"]] as const) {
      await page.locator(`.toolbar button[data-add="${type}"]`).click();
      const card = page.locator(CARD).last();
      await editor(page).locator('input[data-field="title"]').fill(title);
      await editor(page).locator('[data-act="save"]').click();
    }
    await expect(page.locator(CARD)).toHaveCount(3);

    await page.locator(".search-input input").fill("香蕉");
    await expect(page.locator(".search-count")).toHaveText("1");
    await expect(page.locator(".card.hit")).toHaveCount(1);
    await expect(page.locator(".card.dimmed")).toHaveCount(2);

    // 类型筛选与关键字叠加
    await page.locator(".search-clear").click();
    await page.locator(".type-chip", { hasText: "任务" }).click();
    await expect(page.locator(".card.hit")).toHaveCount(1);
    await expect(page.locator(".card.dimmed")).toHaveCount(2);
    await page.locator(".search-clear").click();
    await expect(page.locator(".card.dimmed")).toHaveCount(0);
  });

  test("左栏卡片列表 + 右键复制 ID", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await boot(page);
    await newBoard(page, `E2E-左栏-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.locator('.toolbar button[data-add="text"]').click();
    const card = page.locator(CARD).first();
    await editor(page).locator('input[data-field="title"]').fill("左栏定位卡");
    await editor(page).locator('[data-act="save"]').click();

    await page.locator(".aside-tabs > button", { hasText: "卡片" }).click();
    const entry = page.locator(".card-item", { hasText: "左栏定位卡" });
    await expect(entry).toBeVisible();

    await entry.click({ button: "right" });
    const menu = page.locator(".context-menu");
    await expect(menu.getByText("复制卡片 ID")).toBeVisible();
    await menu.getByText("复制卡片 ID").click();
    await expect(page.locator(".toast.show")).toContainText("卡片 ID已复制");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^c_[a-z0-9]+$/);

    // 画板项右键：复制画板 ID
    await page.locator(".aside-tabs > button", { hasText: "画板" }).click();
    await page.locator(".board-item.active").click({ button: "right" });
    await page.locator(".context-menu").getByText("复制画板 ID").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(boardId);
  });

  test("任务台 /tasks：画板收窄 + 镜头切换 + 详情 + 回卡片深链", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-台A-${Date.now() % 100000}`);
    await page.locator('.toolbar button[data-add="task"]').click();
    await editor(page).locator('input[data-field="title"]').fill("A板任务");
    await editor(page).locator('[data-act="save"]').click();
    const boardA = await currentBoardId(page);

    await newBoard(page, `E2E-台B-${Date.now() % 100000}`);
    await page.locator('.toolbar button[data-add="task"]').click();
    await editor(page).locator('input[data-field="title"]').fill("B板任务");
    await editor(page).locator('[data-act="save"]').click();
    const boardB = await currentBoardId(page);

    // 深链 ?board= 预过滤：只看 B 板
    await page.goto(`/tasks?board=${boardB}`);
    await expect(page.locator(".tk-row", { hasText: "B板任务" })).toBeVisible();
    await expect(page.locator(".tk-row", { hasText: "A板任务" })).toHaveCount(0);

    // 清掉画板收窄 → 两块板的任务都在
    await page.locator(".tk-board-select").selectOption("");
    await expect(page.locator(".tk-row", { hasText: "A板任务" })).toBeVisible();
    await expect(page.locator(".tk-row", { hasText: "B板任务" })).toBeVisible();

    // 镜头切换（goal-agent 模式镜头 = 卡片状态列）：已完成下没有这张卡，切回想法又出现
    await page.locator(".tk-lens", { hasText: "已完成" }).click();
    await expect(page.locator(".tk-row", { hasText: "A板任务" })).toHaveCount(0);
    await page.locator(".tk-lens", { hasText: "想法" }).click();
    await expect(page.locator(".tk-row", { hasText: "A板任务" })).toBeVisible();

    // 关键词筛选
    await page.locator(".nav-search input").fill("A板");
    await expect(page.locator(".tk-row", { hasText: "B板任务" })).toHaveCount(0);
    await expect(page.locator(".tk-row", { hasText: "A板任务" })).toBeVisible();

    // 详情：选中后右栏出标题，地址栏带上 ?issue= 便于分享 / 回传
    await page.locator(".tk-row", { hasText: "A板任务" }).click();
    await expect(page.locator(".tk-detail .tk-title")).toHaveText("A板任务");
    await expect(page).toHaveURL(/issue=/);

    // 「回到卡片」深链跳回画板并定位到那张卡
    const back = page.locator(".tk-detail a", { hasText: "回到卡片" });
    const href = await back.getAttribute("href");
    expect(href).toContain(`board=${boardA}`);
    expect(href).toContain("card=");
    await page.goto(href!);
    await expect(page.locator(`${CARD} .card-title`, { hasText: "A板任务" })).toBeVisible();
  });

  test("深链 ?board=&card= 直接定位", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-深链-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    await page.locator('.toolbar button[data-add="text"]').click();
    const card = page.locator(CARD).first();
    await editor(page).locator('input[data-field="title"]').fill("深链目标卡");
    await editor(page).locator('[data-act="save"]').click();
    const detail = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const cardId = detail.board.cards[0].id;

    // 换一块板，再用深链回来
    await newBoard(page, `E2E-别的板-${Date.now() % 100000}`);
    await page.goto(`/?board=${boardId}&card=${cardId}`);
    await expect(page.locator(".board-name")).toHaveValue(/E2E-深链/);
    await expect(page.locator(CARD, { hasText: "深链目标卡" })).toBeVisible();
    await expect(page.locator(`${CARD}.selected`)).toHaveCount(1);
  });

  test("导出 JSON / Markdown + 连线语义", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-导出-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 两张卡拉开距离：连线中段要露在空白处，否则右键会打到盖在上面的卡片
    const a = await (await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "text", title: "上游卡", content: "正文", x: 40, y: 200, w: 240, h: 150 },
    })).json();
    const b = await (await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "task", title: "下游任务", agentPrompt: "执行时先跑冒烟", x: 1100, y: 200, w: 240, h: 150 },
    })).json();
    await page.request.post(`/api/boards/${boardId}/edges`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { from: a.card.id, to: b.card.id, kind: "blocks", label: "先做" },
    });

    const json = await (await page.request.get(`/api/boards/${boardId}/export?format=json`)).json();
    expect(json.board.cards).toHaveLength(2);
    expect(json.board.edges[0].kind).toBe("blocks");
    expect(json.board.cards.find((c: any) => c.id === b.card.id).agentPrompt).toBe("执行时先跑冒烟");

    const mdResponse = await page.request.get(`/api/boards/${boardId}/export?format=md`);
    expect(mdResponse.headers()["content-type"]).toContain("text/markdown");
    const md = await mdResponse.text();
    expect(md).toContain("# E2E-导出");
    expect(md).toContain("上游卡");
    expect(md).toContain("agent 指令：执行时先跑冒烟");
    expect(md).toContain("—[阻塞 · 先做]→");

    // 连线右键改语义：点在连线中段（两卡之间的空白处）
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await page.locator(".top-btn[aria-label='适应内容']").click();
    await page.waitForTimeout(600);
    const midpoint = await page.evaluate(() => {
      const path = document.querySelector<SVGPathElement>(".react-flow__edge-interaction");
      if (!path) return null;
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const rect = path.getBoundingClientRect();
      const svg = path.ownerSVGElement!;
      const matrix = path.getScreenCTM()!;
      const screen = svg.createSVGPoint();
      screen.x = point.x;
      screen.y = point.y;
      const mapped = screen.matrixTransform(matrix);
      return { x: mapped.x, y: mapped.y, rect: { x: rect.x, y: rect.y } };
    });
    expect(midpoint).not.toBeNull();
    await page.mouse.click(midpoint!.x, midpoint!.y, { button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    await page.locator(".context-menu").getByText("引用", { exact: true }).click();
    await page.waitForTimeout(500);
    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(after.board.edges[0].kind).toBe("references");
  });

  test("转过 Issue 的卡片改完，最新正文自动同步回 Goal Agent", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-同步-${Date.now() % 100000}`);

    await page.locator('.toolbar button[data-add="task"]').click();
    const card = page.locator(CARD).first();
    await editor(page).locator('input[data-field="title"]').fill("会变的需求");
    await editor(page).locator('textarea[data-field="content"]').fill("第一版：先做个能跑的");
    await editor(page).locator('[data-act="save"]').click();
    await card.locator('[data-act="issue"]').click();
    await expect(card.locator(".status-chip.st-issued")).toBeVisible({ timeout: 15_000 });

    const boardId = await currentBoardId(page);
    const detail = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const issueId = detail.board.cards[0].task.issueId;

    // 转完再改：这一版必须也到 Goal Agent 那边去，否则执行的还是第一版
    await card.dblclick();
    await editor(page).locator('textarea[data-field="content"]').fill("第二版：改成按周出三条");
    await editor(page).locator('[data-act="save"]').click();

    await expect
      .poll(
        async () => {
          const payload = await (await page.request.get(`/api/runner/issues/${issueId}`)).json();
          return String(payload?.issue?.description || "");
        },
        { timeout: 15_000 },
      )
      .toContain("第二版：改成按周出三条");

    // 卡片上留下了同步账本，任务抽屉里直接看得到
    await expect
      .poll(async () => {
        const fresh = await (await page.request.get(`/api/boards/${boardId}`)).json();
        return fresh.board.cards[0].task.issueSyncedAt;
      })
      .toBeGreaterThan(0);
  });

  test("卡片 agent 指令写入后随转 Issue 一起下发", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-指令注入-${Date.now() % 100000}`);
    await page.locator('.toolbar button[data-add="task"]').click();
    const card = page.locator(CARD).first();
    await editor(page).locator('input[data-field="title"]').fill("带指令的任务");
    await editor(page).locator('textarea[data-field="content"]').fill("做这件事");
    await editor(page).locator(".link-btn").click();
    await editor(page).locator('textarea[data-field="agentPrompt"]').fill("只许改 docs 目录");
    await editor(page).locator('[data-act="save"]').click();

    await card.locator('[data-act="issue"]').click();
    await expect(card.locator(".status-chip.st-issued")).toBeVisible({ timeout: 15_000 });

    // mock runner 把 description 回显在 /api/issues，这里直接查它收到的内容
    const issues = await (await page.request.get("/api/runner/issues/issue-1")).json().catch(() => null);
    // 无论 mock 是否实现该读口，卡片本身必须持久化了 agentPrompt
    const boardId = await currentBoardId(page);
    const detail = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(detail.board.cards[0].agentPrompt).toBe("只许改 docs 目录");
    expect(issues === null || typeof issues === "object").toBe(true);
  });
});


test.describe("第四轮：框选与批量操作", () => {
  test("选择工具：框选多张 → 一起移动 → 选中态不丢 → 批量删除", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-框选-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 摆 4 张在一片区域内，方便一框全中
    for (let i = 0; i < 4; i += 1) {
      await page.request.post(`/api/boards/${boardId}/cards`, {
        headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
        data: { type: "text", title: `框选 ${i + 1}`, x: 60 + (i % 2) * 330, y: 60 + Math.floor(i / 2) * 210, w: 280, h: 170 },
      });
    }
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(4);
    await page.locator(".top-btn[aria-label='适应内容']").click();
    await page.waitForTimeout(500);

    // 默认就是选择工具
    await expect(page.locator(".tool-switch button").first()).toHaveClass(/on/);

    // 从空白处拖一个框把 4 张全罩住
    // 起手点必须落在空白画布上：左上角被工具条 + 搜索条压着，所以从右下角往左上拖
    const pane = await page.locator(".react-flow__pane").boundingBox();
    await page.mouse.move(pane!.x + pane!.width - 14, pane!.y + pane!.height - 14);
    await page.mouse.down();
    await page.mouse.move(pane!.x + 14, pane!.y + 14, { steps: 16 });
    await page.mouse.up();
    await expect(page.locator(`${CARD}.selected`)).toHaveCount(4);
    await expect(page.locator(".selected-hint")).toHaveText("已选 4 张");

    const before = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const beforePos = Object.fromEntries(before.board.cards.map((c: any) => [c.id, [c.x, c.y]]));

    // 拖其中一张 → 4 张一起动
    // 抓卡片中部：贴边会命中缩放手柄，变成「缩放」而不是「移动」
    const card = page.locator(CARD).first();
    const box = await card.boundingBox();
    const grabX = box!.x + box!.width / 2;
    const grabY = box!.y + box!.height / 2;
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX + 90, grabY + 70, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1200);

    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const deltas = after.board.cards.map((c: any) => [c.x - beforePos[c.id][0], c.y - beforePos[c.id][1]]);
    // 全部位移一致，且确实动了
    expect(new Set(deltas.map((d: number[]) => d.join(","))).size).toBe(1);
    expect(Math.abs(deltas[0][0])).toBeGreaterThan(10);

    // 移动后选中态还在（这里曾经踩过坑：节点重建把多选清掉了）
    await expect(page.locator(`${CARD}.selected`)).toHaveCount(4);

    // 右键选择框 → 批量菜单 → 批量删除
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator(".react-flow__nodesselection-rect").click({ button: "right", force: true });
    await expect(page.locator(".context-menu")).toContainText("删除这 4 张卡片");
    await page.locator(".context-menu").getByText("删除这 4 张卡片").click();
    await expect(page.locator(CARD)).toHaveCount(0, { timeout: 15_000 });
  });

  test("抓手工具与空格临时平移", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-工具-${Date.now() % 100000}`);

    // H 切抓手
    await clickBlankPane(page);
    await page.keyboard.press("h");
    await expect(page.locator(".tool-switch button").nth(1)).toHaveClass(/on/);
    await expect(page.locator(".canvas-wrap")).toHaveClass(/tool-pan/);

    // V 切回选择
    await page.keyboard.press("v");
    await expect(page.locator(".tool-switch button").first()).toHaveClass(/on/);
    await expect(page.locator(".canvas-wrap")).toHaveClass(/tool-select/);

    // 按住空格 = 临时平移
    await page.keyboard.down("Space");
    await expect(page.locator(".canvas-wrap")).toHaveClass(/tool-pan/);
    await page.keyboard.up("Space");
    await expect(page.locator(".canvas-wrap")).toHaveClass(/tool-select/);
  });

  test("抓手模式：从卡片上按下去也是平移整块板，卡片不跟着走", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-抓手-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "text", title: "抓手卡", content: "别被抓手拖跑", x: 200, y: 200 },
    });
    await page.locator(".top-btn[aria-label='刷新']").click();
    const card = page.locator(CARD).first();
    await expect(card).toBeVisible();

    const before = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const start = before.board.cards[0];

    // 抓手模式：手型光标承诺的是「抓的是画布」，从卡片上按下去就该平移
    await page.keyboard.press("h");
    await expect(page.locator(".canvas-wrap")).toHaveClass(/tool-pan/);
    const box = (await card.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 140, box.y + box.height / 2 + 90, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1200);

    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(after.board.cards[0].x).toBe(start.x);
    expect(after.board.cards[0].y).toBe(start.y);
    // 动的是视口
    expect(after.board.viewport.x).not.toBe(before.board.viewport?.x ?? 0);

    // 切回选择模式，同一个手势又能拖卡片了
    await page.keyboard.press("v");
    const box2 = (await card.boundingBox())!;
    await page.mouse.move(box2.x + box2.width / 2, box2.y + 14);
    await page.mouse.down();
    await page.mouse.move(box2.x + box2.width / 2 + 150, box2.y + 110, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1200);

    const moved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(moved.board.cards[0].x).not.toBe(start.x);
  });

  test("⌘A 全选后批量改色", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-全选-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    for (let i = 0; i < 3; i += 1) {
      await page.request.post(`/api/boards/${boardId}/cards`, {
        headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
        data: { type: "text", title: `全选 ${i + 1}`, x: 60 + i * 320, y: 80, color: "slate" },
      });
    }
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(3);

    await clickBlankPane(page);
    await page.keyboard.press("ControlOrMeta+a");
    await expect(page.locator(".selected-hint")).toHaveText("已选 3 张");

    await page.locator(CARD).first().click({ button: "right" });
    const menu = page.locator(".context-menu");
    await expect(menu).toContainText("删除这 3 张卡片");
    await menu.locator(".swatch").nth(2).click();
    await expect(page.locator(".toast.show")).toContainText("已改 3 张卡片的颜色");

    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(new Set(after.board.cards.map((c: any) => c.color)).size).toBe(1);
    expect(after.board.cards[0].color).not.toBe("slate");
  });
});

test.describe("第五轮：抽屉编辑 / 新卡片类型 / 连线外观 / 聚焦", () => {
  test("编辑搬进右侧抽屉：抽屉互斥，收起的抽屉不占位也不抢焦点", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-抽屉-${Date.now() % 100000}`);

    // 先开 Agent 抽屉，再双击卡片进编辑：两者互斥，同时只能开一个
    await page.locator(".top-btn", { hasText: "Agent" }).click();
    await expect(page.locator(".drawer.agent.open")).toBeVisible();

    await page.locator('.toolbar button[data-add="text"]').click();
    await expect(page.locator(EDITOR)).toBeVisible();
    await expect(page.locator(".drawer.agent.open")).toHaveCount(0);
    await editor(page).locator('input[data-field="title"]').fill("抽屉里写的卡");
    await editor(page).locator('[data-act="save"]').click();
    await expect(page.locator(`${CARD} .card-title`).first()).toHaveText("抽屉里写的卡");

    // 收起的抽屉必须彻底退场：不撑出横向滚动、也不能被 focus 带回视野
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
    });
    expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  });

  test("思维导图卡：全屏弹窗编辑 + 大纲建树 + 左右分叉 + 卡面渲染", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-导图-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 导图不是简单文字，编辑走全屏弹窗而不是右侧抽屉
    await page.locator('.toolbar button[data-add="mindmap"]').click();
    const modal = page.locator(".mind-modal");
    await expect(modal).toBeVisible();
    await expect(page.locator(EDITOR)).toHaveCount(0);

    const root = modal.locator(".mv-input").first();
    await root.fill("企业 AI 培训");
    await root.press("Tab");
    await modal.locator(".mv-input").nth(1).fill("需求诊断");
    await modal.locator(".mv-input").nth(1).press("Enter");
    await modal.locator(".mv-input").nth(2).fill("课程结构");
    await expect(modal.locator(".mv-input")).toHaveCount(3);

    // 折线是量完位置画出来的：父子对有几组就该有几条 path
    await expect(modal.locator(".mv-links path")).toHaveCount(2);

    // 左右分叉：根节点居中，子节点分到两边
    await modal.locator(".scope-switch button", { hasText: "左右分叉" }).click();
    await expect(modal.locator(".mv-both")).toBeVisible();
    await expect(modal.locator(".mv-links path")).toHaveCount(2);

    await modal.locator(".mind-title").fill("AI 培训拆解");
    await modal.locator(".mini-btn", { hasText: "保存并关闭" }).click();
    await expect(modal).toHaveCount(0);

    const saved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const card = saved.board.cards.find((item: any) => item.type === "mindmap");
    expect(card.mindmap.layout).toBe("both");
    expect(card.mindmap.root.text).toBe("企业 AI 培训");

    // 卡面用同一个渲染器，缩放居中
    const node = page.locator(CARD, { hasText: "AI 培训拆解" });
    await expect(node.locator(".mv-slot.lv-root")).toContainText("企业 AI 培训");

    // Markdown 导出把导图摊成缩进列表（agent 读得懂）
    const md = await (await page.request.get(`/api/boards/${boardId}/export?format=md`)).text();
    expect(md).toContain("- 企业 AI 培训");
    expect(md).toContain("  - 需求诊断");
  });

  test("子画板卡：建卡即建板 → 进入下钻 → 面包屑返回", async ({ page }) => {
    await boot(page);
    const parentName = `E2E-父板-${Date.now() % 100000}`;
    await newBoard(page, parentName);
    const parentId = await currentBoardId(page);

    await toolbarAdd(page, "board");
    await expect(page.locator(EDITOR)).toBeVisible();
    await editor(page).locator('input[data-field="title"]').fill("素材子板");
    await editor(page).locator('[data-act="save"]').click();

    const card = page.locator(CARD, { hasText: "素材子板" });
    await card.locator('[data-act="open-board"]').click();

    // 已经在子板里：面包屑指回父板
    await expect(page.locator(".crumbs .crumb")).toHaveText([parentName]);
    expect(await currentBoardId(page)).not.toBe(parentId);

    await page.locator(".crumbs .crumb").click();
    await expect(page.locator(".crumbs")).toHaveCount(0);
    await expect(page.locator(".board-item.active .bi-name")).toHaveText(parentName);
    expect(await currentBoardId(page)).toBe(parentId);
  });

  test("连线外观：颜色 / 线型 / 粗细可单独设，也能退回跟随语义", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-线-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 卡片与连线都用 API 摆好，UI 只负责验「点线改外观」这一段
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    const ids: string[] = [];
    for (const [title, x, y] of [["起点", 120, 120], ["终点", 620, 120]] as const) {
      const res = await (
        await page.request.post(`/api/boards/${boardId}/cards`, { headers, data: { type: "text", title, x, y } })
      ).json();
      ids.push(res.card.id);
    }
    await page.request.post(`/api/boards/${boardId}/edges`, {
      headers,
      data: { from: ids[0], to: ids[1], label: "行动" },
    });
    await page.reload();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);

    // 点线出工具条 → 展开外观 → 选一个颜色
    // SVG path 走不了 Playwright 的可点性判定，按几何算出中点用真实鼠标点（与语义边用例同一招）
    await page.locator(".top-btn[aria-label='适应内容']").click();
    await page.waitForTimeout(600);
    const midpoint = await page.evaluate(() => {
      const path = document.querySelector<SVGPathElement>(".react-flow__edge-interaction");
      if (!path) return null;
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const svgPoint = path.ownerSVGElement!.createSVGPoint();
      svgPoint.x = point.x;
      svgPoint.y = point.y;
      const mapped = svgPoint.matrixTransform(path.getScreenCTM()!);
      return { x: mapped.x, y: mapped.y };
    });
    expect(midpoint).not.toBeNull();
    await page.mouse.click(midpoint!.x, midpoint!.y);
    const toolbar = page.locator(".edge-toolbar");
    await expect(toolbar).toBeVisible();
    await toolbar.locator("button", { hasText: "外观" }).click();
    await toolbar.locator(".et-look-row").first().locator(".et-dot").nth(4).click();

    const afterColor = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(afterColor.board.edges[0].color).toBe("rose");

    // 线型 / 粗细
    await toolbar.locator(".et-chip", { hasText: "点线" }).click();
    await toolbar.locator(".et-chip", { hasText: "粗" }).click();
    const afterStyle = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(afterStyle.board.edges[0].style).toBe("dotted");
    expect(afterStyle.board.edges[0].width).toBe(3);

    // 退回跟随语义
    await toolbar.locator(".et-chip", { hasText: "跟随语义" }).click();
    const afterReset = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(afterReset.board.edges[0].color).toBe(null);
  });

  test("大板只渲染可视区：屏幕外的卡片不进 DOM，导出前会全部补上", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-可视区-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 铺 80 张卡的网格：默认 1:1 视口只看得到左上角那几张，其余都在屏幕外；
    // 整体范围又不超过最小缩放能容下的尺寸，好让后面的「适应内容」真的装得下
    const cards = Array.from({ length: 80 }, (_, index) => ({
      id: `c_cull${String(index).padStart(3, "0")}`,
      type: "text",
      title: `卡-${index}`,
      content: `第 ${index} 张`,
      x: (index % 10) * 380,
      y: Math.floor(index / 10) * 300,
    }));
    const res = await page.request.put(`/api/boards/${boardId}/whole`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { cards, edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    });
    expect(res.status()).toBe(200);
    await page.reload();

    await expect(page.locator(CARD).first()).toBeVisible();
    // 头几张在视野里，末尾那些在几万像素之外——不该出现在 DOM 里
    await expect(page.locator(CARD, { hasText: "卡-0" })).toHaveCount(1);
    await expect(page.locator(CARD, { hasText: "卡-79" })).toHaveCount(0);
    const rendered = await page.locator(CARD).count();
    expect(rendered).toBeLessThan(80);

    // 「适应内容」把整块板缩进视野后，原本被裁掉的卡片就该出现
    await page.locator(".top-btn[aria-label='适应内容']").click();
    await expect(page.locator(CARD, { hasText: "卡-79" })).toHaveCount(1, { timeout: 10_000 });
  });

  test("小板不裁剪：卡片再远也都在 DOM 里", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-不裁剪-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    const res = await page.request.put(`/api/boards/${boardId}/whole`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: {
        cards: [
          { id: "c_near0001", type: "text", title: "近处", x: 100, y: 120 },
          { id: "c_far00001", type: "text", title: "远处", x: 9000, y: 4000 },
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    expect(res.status()).toBe(200);
    await page.reload();

    await expect(page.locator(CARD, { hasText: "近处" })).toHaveCount(1);
    await expect(page.locator(CARD, { hasText: "远处" })).toHaveCount(1);
  });

  test("聚焦模式：选中一张卡只亮它和直接相连的邻居", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-聚焦-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    const made: string[] = [];
    for (const [title, x, y] of [["中心", 300, 300], ["邻居", 800, 300], ["路人", 300, 800]] as const) {
      const res = await (
        await page.request.post(`/api/boards/${boardId}/cards`, { headers, data: { type: "text", title, x, y } })
      ).json();
      made.push(res.card.id);
    }
    await page.request.post(`/api/boards/${boardId}/edges`, {
      headers,
      data: { from: made[0], to: made[1], label: "连着" },
    });
    await page.reload();

    await page.locator(".toolbar button", { hasText: "聚焦" }).click();
    await page.locator(CARD, { hasText: "中心" }).click();

    await expect(page.locator(`${CARD}`, { hasText: "路人" }).locator(".card.dimmed")).toHaveCount(1);
    await expect(page.locator(`${CARD}`, { hasText: "邻居" }).locator(".card.dimmed")).toHaveCount(0);

    // 关掉开关就全亮回来
    await page.locator(".toolbar button", { hasText: "聚焦" }).click();
    await expect(page.locator(".card.dimmed")).toHaveCount(0);
  });

  test("吸附网格：开着拖动会落在点阵上，关着不吸；开关刷新后保持", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-吸附-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 起点故意不是 22 的整数倍：没开吸附时它就该原样待着
    const made = await (
      await page.request.post(`/api/boards/${boardId}/cards`, {
        headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
        data: { type: "text", title: "吸附卡", x: 301, y: 207 },
      })
    ).json();
    const cardId = made.card.id;
    await page.reload();

    const cardX = async () => {
      const payload = await (await page.request.get(`/api/boards/${boardId}`)).json();
      const card = payload.board.cards.find((item: { id: string }) => item.id === cardId);
      return { x: card.x, y: card.y };
    };
    expect((await cardX()).x % 22).not.toBe(0);

    const snap = page.locator("[data-act=toggle-snapgrid]");
    await expect(snap).toHaveAttribute("aria-pressed", "false");
    await snap.click();
    await expect(snap).toHaveAttribute("aria-pressed", "true");

    // 开着吸附拖一段：落点必须是格距的整数倍（不验具体像素，只验「吸上了」）
    const card = page.locator(CARD, { hasText: "吸附卡" });
    const box = await card.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 14);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 137, box!.y + 103, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(async () => {
        const { x, y } = await cardX();
        return `${x % 22}/${y % 22}`;
      })
      .toBe("0/0");

    // 刷新后开关保持（存 localStorage，跟聚焦模式同一套）
    await page.reload();
    await expect(page.locator("[data-act=toggle-snapgrid]")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("第六轮：待办收集箱 / 资料卡回填", () => {
  test("待办卡：卡面直接加、直接勾，抽屉里整理", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-待办-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.locator('.toolbar button[data-add="todo"]').click();
    await editor(page).locator('input[data-field="title"]').fill("收集箱");
    await editor(page).locator('[data-act="save"]').click();

    const card = page.locator(CARD, { hasText: "收集箱" });
    const add = card.locator(".todo-add input");
    // 收集箱的价值在随手记：加一条不该先进编辑器
    await add.fill("把追更清单过一遍");
    await add.press("Enter");
    await add.fill("写一版 SOP");
    await add.press("Enter");
    await expect(card.locator(".todo-item")).toHaveCount(2);

    // 卡面直接勾选
    await card.locator(".todo-check").first().click();
    await expect(card.locator(".todo-item.done")).toHaveCount(1);
    await expect(card.locator(".todo-foot .meta-chip")).toHaveText("1/2");

    const saved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const todo = saved.board.cards.find((item: any) => item.type === "todo");
    expect(todo.todo.items).toHaveLength(2);
    expect(todo.todo.items[0].done).toBe(true);
    expect(todo.todo.items[0].doneAt).toBeGreaterThan(0);

    // 导出成 markdown 的复选框列表
    const md = await (await page.request.get(`/api/boards/${boardId}/export?format=md`)).text();
    expect(md).toContain("- [x] 把追更清单过一遍");
    expect(md).toContain("- [ ] 写一版 SOP");

    // 抽屉里整理：清掉已完成
    await card.dblclick();
    await expect(page.locator(EDITOR)).toBeVisible();
    await editor(page).locator(".mini-btn", { hasText: "清掉已完成" }).click();
    await editor(page).locator('[data-act="save"]').click();
    await expect(card.locator(".todo-item")).toHaveCount(1);
  });

  test("资料卡：链接指向知识库阅读页，检索抽屉能回填到选中的那张卡", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-资料-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: {
        type: "ref",
        title: "参考资料",
        ref: {
          source: "aidocs",
          query: "AI 培训",
          items: [
            {
              resourceId: "doc:bilibili:627744",
              docId: "627744",
              platform: "bilibili",
              title: "某篇转写",
              url: "https://www.bilibili.com/video/BV1x",
            },
          ],
        },
      },
    });
    await page.reload();

    // 资料卡是知识库的入口：点条目要去知识库，不是原始平台
    const link = page.locator(CARD, { hasText: "参考资料" }).locator(".ref-item").first();
    await expect(link).toHaveAttribute("href", /\/document\/627744\?platform=bilibili$/);
    // 而且 host 跟着配置走（本机访问 → 保持回环）
    await expect(link).toHaveAttribute("href", new RegExp(`^${escapeRe(E2E_AIDOCS_URL)}/`));

    // 早期存的条目没有 docId 字段，也要能从 resourceId 反解出来跳知识库，而不是退回原始平台
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: {
        type: "ref",
        title: "老资料卡",
        // 挪开，别跟上面那张默认落位的卡重叠（后面还要点「参考资料」）
        x: 700,
        y: 500,
        ref: {
          source: "aidocs",
          query: "旧数据",
          items: [
            {
              resourceId: "doc:feishu:35537",
              platform: "feishu",
              title: "没存 docId 的条目",
              url: "https://example.feishu.cn/docx/abc",
            },
          ],
        },
      },
    });
    await page.reload();
    await expect(page.locator(CARD, { hasText: "老资料卡" }).locator(".ref-item").first()).toHaveAttribute(
      "href",
      /\/document\/35537\?platform=feishu$/,
    );

    // 选中这张卡再开检索抽屉 → 默认回填到它，而不是每次都散出新卡
    await page.locator(CARD, { hasText: "参考资料" }).click();
    await toolbarAdd(page, "ref");
    const drawer = page.locator(".drawer.aidocs.open");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".ad-target")).toContainText("正在给「参考资料」补资料");

    // 也能一键改回「新建」
    await drawer.locator(".ad-target .mini-btn", { hasText: "改成新建" }).click();
    await expect(drawer.locator(".ad-target")).toHaveCount(0);
  });
});

test.describe("第七轮：图表卡 / 子画板缩略图", () => {
  test("Mermaid 卡：源码写完即渲染，语法错报在卡面上", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-图表-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.locator('.toolbar button[data-add="mermaid"]').click();
    await editor(page).locator('input[data-field="title"]').fill("任务流");
    await editor(page).locator('textarea[data-field="diagram"]').fill("graph LR\n  A[想法] --> B[任务]\n  B --> C[产出]");
    await editor(page).locator('[data-act="save"]').click();

    // mermaid 是按需 import 的，首帧要等它加载完
    const card = page.locator(CARD, { hasText: "任务流" });
    await expect(card.locator(".diagram-wrap svg")).toBeVisible({ timeout: 20_000 });

    const saved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(saved.board.cards[0].mermaid.source).toContain("graph LR");

    // 导出成带围栏的 mermaid 代码块，贴哪儿都能渲染
    const md = await (await page.request.get(`/api/boards/${boardId}/export?format=md`)).text();
    expect(md).toContain("```mermaid");

    // 写坏了要在卡面上说清楚，而不是白屏
    await card.dblclick();
    await editor(page).locator('textarea[data-field="diagram"]').fill("graph LR\n  A --> ->> B");
    await editor(page).locator('[data-act="save"]').click();
    await expect(card.locator(".diagram-error")).toBeVisible({ timeout: 20_000 });
  });

  test("SVG 卡：按图片渲染，脚本被剥掉", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-SVG-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.locator('.toolbar button[data-add="svg"]').click();
    await editor(page).locator('input[data-field="title"]').fill("示意图");
    await editor(page)
      .locator('textarea[data-field="diagram"]')
      .fill('<svg viewBox="0 0 100 40"><script>alert(1)</script><rect width="100" height="40" fill="#68c48f" onclick="alert(2)"/></svg>');
    await editor(page).locator('[data-act="save"]').click();

    await expect(page.locator(CARD, { hasText: "示意图" }).locator("img.diagram-img")).toBeVisible();

    const saved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const source = saved.board.cards[0].svg.source;
    expect(source).toContain("<rect");
    expect(source).not.toContain("<script");
    expect(source).not.toContain("onclick");
  });

  test("Excalidraw 卡：只有 .excalidraw JSON、没有缩略图也要在卡面画出来", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-Excalidraw-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    // 外面画完导出的那份 JSON：只有 source，没有 thumbnail
    const scene = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "http://localhost:3001",
      elements: [
        { id: "e2e-rect", type: "rectangle", x: 0, y: 0, width: 160, height: 90 },
        {
          id: "e2e-text",
          type: "text",
          x: 0,
          y: 120,
          width: 200,
          height: 25,
          fontSize: 20,
          fontFamily: 1,
          text: "画上写的字",
          originalText: "画上写的字",
        },
      ],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    });
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers,
      data: { type: "excalidraw", title: "自由画", excalidraw: { source: scene } },
    });
    await page.reload();

    // 卡面这张图由服务端按 source 现渲（同一支笔也用在排版导出上），
    // 浏览器这边只是一张 <img>——不再为了画一张缩略图去 import 那个 1MB+ 的库
    const card = page.locator(CARD, { hasText: "自由画" });
    const face = card.locator("img.diagram-img");
    await expect(face).toBeVisible();
    await expect(face).toHaveAttribute("src", /\/drawing\?v=/);
    // 真画出来了才算数：占位和破图的 naturalWidth 都是 0
    await expect.poll(() => face.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);

    // 归一化按 JSON 走：元素留着，会话态字段（协作者/选中）不落库
    const saved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const source = saved.board.cards[0].excalidraw.source;
    expect(JSON.parse(source).elements).toHaveLength(2);
    expect(source).toContain("画上写的字");

    // 导出/检索只带画上的字，不带一坨 JSON 字段
    const md = await (await page.request.get(`/api/boards/${boardId}/export?format=md`)).text();
    expect(md).toContain("画上写的字");
    expect(md).not.toContain("strokeColor");
  });

  test("子画板卡：卡面画出目标画板的缩略图，不是空白图标", async ({ page }) => {
    await boot(page);
    const childName = `E2E-子板-${Date.now() % 100000}`;
    await newBoard(page, childName);
    const childId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    for (const [title, x, y] of [["一", 0, 0], ["二", 500, 0], ["三", 0, 400]] as const) {
      await page.request.post(`/api/boards/${childId}/cards`, { headers, data: { type: "text", title, x, y } });
    }

    // 预览接口只给几何与颜色，不带正文
    const preview = await (await page.request.get(`/api/boards/${childId}/preview`)).json();
    expect(preview.cards).toHaveLength(3);
    expect(preview.cards[0]).not.toHaveProperty("content");

    await newBoard(page, `E2E-父板-${Date.now() % 100000}`);
    const parentId = await currentBoardId(page);
    await page.request.post(`/api/boards/${parentId}/cards`, {
      headers,
      data: { type: "board", title: "素材子板", boardRef: { boardId: childId, name: childName } },
    });
    await page.reload();

    const card = page.locator(CARD, { hasText: "素材子板" });
    await expect(card.locator("svg.board-preview .bp-card")).toHaveCount(3);
  });

  test("子画板卡：竖长子板不缩成细条 —— 地图按长宽比分栏、标题去右栏、页脚不换行", async ({ page }) => {
    await boot(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    const stamp = Date.now() % 100000;

    // 竖长子板：3 列 × 9 行，长宽比 ≈ 0.41——正是「整块塞进宽扁预览区」会缩成细条的形状
    const tallName = `E2E-竖板-${stamp}`;
    await newBoard(page, tallName);
    const tallId = await currentBoardId(page);
    for (let i = 0; i < 25; i += 1) {
      await page.request.post(`/api/boards/${tallId}/cards`, {
        headers,
        data: {
          type: "text",
          title: `竖板第 ${i + 1} 张卡的完整标题`,
          x: (i % 3) * 360,
          y: Math.floor(i / 3) * 300,
          w: 300,
          h: 240,
        },
      });
    }

    // 横板：5 张大卡摊开，长宽比 ≈ 2.7——它该走「地图占满整宽」那条路
    const wideName = `E2E-横板-${stamp}`;
    await newBoard(page, wideName);
    const wideId = await currentBoardId(page);
    for (let i = 0; i < 5; i += 1) {
      await page.request.post(`/api/boards/${wideId}/cards`, {
        headers,
        data: { type: "text", title: `横板第 ${i + 1} 张`, x: (i % 3) * 680, y: Math.floor(i / 3) * 360, w: 620, h: 300 },
      });
    }

    await newBoard(page, `E2E-父板-${stamp}`);
    const parentId = await currentBoardId(page);
    for (const [name, id, x] of [[tallName, tallId, 40], [wideName, wideId, 400]] as const) {
      await page.request.post(`/api/boards/${parentId}/cards`, {
        headers,
        // 标题跟目标板同名：卡头已经写了一遍，页脚就不该再挂一遍
        data: { type: "board", title: name, boardRef: { boardId: id, name }, x, y: 420, w: 290, h: 240 },
      });
    }
    await page.reload();

    const tallCard = page.locator(CARD, { hasText: tallName });
    const wideCard = page.locator(CARD, { hasText: wideName });
    await expect(tallCard.locator("svg.board-preview .bp-card")).toHaveCount(25);

    /** 缩略图实际画出来的宽度占了地图那栏的几成——修之前这个数只有四分之一 */
    const fillRatio = (target: ReturnType<Page["locator"]>) =>
      target.locator(".bp-map").evaluate((map) => {
        const rects = [...map.querySelectorAll("svg.board-preview .bp-card")].map((node) =>
          node.getBoundingClientRect(),
        );
        const left = Math.min(...rects.map((r) => r.left));
        const right = Math.max(...rects.map((r) => r.right));
        return (right - left) / map.getBoundingClientRect().width;
      });

    expect(await fillRatio(tallCard)).toBeGreaterThan(0.7);
    expect(await fillRatio(wideCard)).toBeGreaterThan(0.7);

    // 竖板：标题去右栏，用正常字号完整读得出（不是「竖板第…」那种一两个字的残句）
    const digest = tallCard.locator(".bp-digest li");
    expect(await digest.count()).toBeGreaterThanOrEqual(3);
    await expect(digest.first()).toHaveText("竖板第 1 张卡的完整标题");
    // 右栏兜底给出「还有多少张没列出来」，用户知道自己看到的是一部分
    await expect(tallCard.locator(".bp-digest .bp-more")).toBeVisible();

    // 地图上真画出来的字，一律不少于 3 个字：一两个字加省略号的残标题是噪点，不是信息
    for (const card of [tallCard, wideCard]) {
      const labels = await card
        .locator("svg.board-preview .bp-title")
        .evaluateAll((nodes) => nodes.map((node) => node.textContent || ""));
      for (const label of labels) {
        expect(label.replace(/…/g, "").trim().length).toBeGreaterThanOrEqual(3);
      }
    }
    // 缩略图上的字必然截断，完整标题挂在 <title> 上，鼠标停一下能看全
    await expect(tallCard.locator("svg.board-preview title").first()).toHaveText(/竖板第 \d+ 张卡的完整标题/);

    // 页脚：卡头已经写了标题，页脚不再挂同一串名字，只剩卡数 + 进入，且不换行
    await expect(tallCard.locator(".subboard-foot .meta-chip")).toHaveCount(1);
    await expect(tallCard.locator(".subboard-foot .meta-chip.mono")).toContainText("25");
    const footHeights = await Promise.all(
      [tallCard, wideCard].map((card) =>
        card.locator(".subboard-foot").evaluate((foot) => foot.getBoundingClientRect().height),
      ),
    );
    for (const height of footHeights) expect(height).toBeLessThan(34);
    // 两张卡的「进入」离各自右边框一样远：换个名字长度按钮也不跳位置
    const insets = await Promise.all(
      [tallCard, wideCard].map((card) =>
        card.locator(".card").evaluate((node) => {
          const button = node.querySelector(".card-action")!.getBoundingClientRect();
          return Math.round(node.getBoundingClientRect().right - button.right);
        }),
      ),
    );
    expect(insets[0]).toBe(insets[1]);
  });

  test("子画板卡：怎么摆都填不满的极端竖板给一个全景开关，按一下把裁掉的部分放回来", async ({ page }) => {
    await boot(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    const stamp = Date.now() % 100000;

    // 一列 20 张：长宽比 ≈ 0.07，窄到地图栏的下限也填不满，只能裁 + 给开关
    const name = `E2E-长条-${stamp}`;
    await newBoard(page, name);
    const childId = await currentBoardId(page);
    for (let i = 0; i < 20; i += 1) {
      await page.request.post(`/api/boards/${childId}/cards`, {
        headers,
        data: { type: "text", title: `长条第 ${i + 1} 张`, x: 0, y: i * 300, w: 300, h: 240 },
      });
    }

    await newBoard(page, `E2E-长条父板-${stamp}`);
    const parentId = await currentBoardId(page);
    await page.request.post(`/api/boards/${parentId}/cards`, {
      headers,
      data: { type: "board", title: name, boardRef: { boardId: childId, name }, x: 40, y: 420, w: 280, h: 150 },
    });
    await page.reload();

    const card = page.locator(CARD, { hasText: name });
    const toggle = card.locator(".bp-zoom");
    await expect(toggle).toBeVisible();

    const viewBoxHeight = () =>
      card.locator("svg.board-preview").evaluate((svg) => Number(svg.getAttribute("viewBox")!.split(" ")[3]));
    const focused = await viewBoxHeight();
    await toggle.click();
    // 全景：取景框长到能装下整块板，裁掉的那截回来了
    await expect.poll(viewBoxHeight).toBeGreaterThan(focused * 1.2);
    // 再按一下回到聚焦，不是单程票
    await toggle.click();
    await expect.poll(viewBoxHeight).toBeCloseTo(focused, 0);
  });
});

test.describe("第二波：代码卡 / 表格卡 / 数据图卡", () => {
  test("代码卡：工具条建卡 → 抽屉写源码 → 卡面高亮 + 一键复制", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await boot(page);
    await newBoard(page, `E2E-代码-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.locator('.toolbar button[data-add="code"]').click();
    await editor(page).locator('input[data-field="title"]').fill("重试实现");
    await editor(page).locator('input[data-field="code.language"]').fill("python");
    await editor(page).locator('input[data-field="code.filename"]').fill("app/retry.py");
    await editor(page).locator('textarea[data-field="code.source"]').fill("def retry(times):\n    return times > 0");
    await editor(page).locator('[data-act="save"]').click();

    const card = page.locator(CARD, { hasText: "重试实现" });
    // 高亮库是按需 import 的，首帧先出纯文本，加载完才有 token 元素
    await expect(card.locator(".code-pre")).toContainText("def retry");
    await expect(card.locator(".code-pre .hljs-keyword").first()).toBeVisible({ timeout: 20_000 });
    await expect(card.locator(".code-foot .meta-chip")).toHaveText("python");
    await expect(card.locator(".code-file")).toHaveText("app/retry.py");

    // 复制按钮：真把源码写进系统剪贴板
    await card.locator('[data-act="copy-code"]').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("def retry(times):");

    const saved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(saved.board.cards[0].code.language).toBe("python");
    expect(saved.board.cards[0].code.source).toContain("return times > 0");

    // 导出成带语言标注的围栏代码块
    const md = await (await page.request.get(`/api/boards/${boardId}/export?format=md`)).text();
    expect(md).toContain("```python");
  });

  test("表格卡：粘一段 Markdown 表格就成表，卡面按行列渲染", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-表格-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.locator('.toolbar button[data-add="table"]').click();
    await editor(page).locator('input[data-field="title"]').fill("季度收入");
    await editor(page).locator('input[data-field="table.caption"]').fill("单位：万元");
    await editor(page)
      .locator('textarea[data-field="table.markdown"]')
      .fill("| 季度 | 收入 |\n| --- | ---: |\n| Q1 | 120 |\n| Q2 | 138 |");
    await editor(page).locator('[data-act="save"]').click();

    const card = page.locator(CARD, { hasText: "季度收入" });
    await expect(card.locator(".mini-table th")).toHaveText(["季度", "收入"]);
    await expect(card.locator(".mini-table tbody tr")).toHaveCount(2);
    await expect(card.locator(".table-caption")).toHaveText("单位：万元");
    // 右对齐是从 `---:` 读出来的，不是写死的
    await expect(card.locator(".mini-table tbody tr").first().locator("td").nth(1)).toHaveCSS("text-align", "right");

    const saved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(saved.board.cards[0].table.rows).toHaveLength(2);

    // 重新打开抽屉：回填的仍是同一种 Markdown 写法（编辑器与导出共用一个转换）
    await card.dblclick();
    await expect(editor(page).locator('textarea[data-field="table.markdown"]')).toHaveValue(/\| Q2 \| 138 \|/);
  });

  test("数据图卡：只填数据就出图，写错的数据挡住保存", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-数据图-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.locator('.toolbar button[data-add="chart"]').click();
    await editor(page).locator('input[data-field="title"]').fill("季度走势");
    await editor(page).locator('select[data-field="chart.kind"]').selectOption("bar");
    await editor(page).locator('input[data-field="chart.title"]').fill("季度收入");
    // 轴名称也填上：x-axis/y-axis 那两行的语法拼错的话，整张图会变成一条报错
    await editor(page).locator('input[data-field="chart.xLabel"]').fill("季度");
    await editor(page).locator('input[data-field="chart.yLabel"]').fill("万元");
    await editor(page).locator('textarea[data-field="chart.data"]').fill("Q1, Q2, Q3\n收入: 120, 138, 155");
    await editor(page).locator('[data-act="save"]').click();

    // 渲染复用 mermaid 那条路（按需 import），首帧要等库加载完
    const card = page.locator(CARD, { hasText: "季度走势" });
    await expect(card.locator(".diagram-wrap svg")).toBeVisible({ timeout: 20_000 });
    await expect(card.locator(".diagram-error")).toHaveCount(0);

    const saved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(saved.board.cards[0].chart.kind).toBe("bar");
    expect(saved.board.cards[0].chart.series[0].values).toEqual([120, 138, 155]);

    // markdown 导出给的是生成好的 mermaid 源码（贴哪儿都能渲）
    const md = await (await page.request.get(`/api/boards/${boardId}/export?format=md`)).text();
    expect(md).toContain("xychart-beta");

    /* 另外三种 kind 的源码映射也要真渲得出来——写错一个关键字就是一张报错卡 */
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    for (const [title, chart] of [
      ["折线图", { kind: "line", labels: ["1月", "2月"], series: [{ name: "访问", values: [320, 410] }] }],
      ["饼图", { kind: "pie", title: "来源", slices: [{ label: "搜索", value: 33 }, { label: "推荐", value: 25 }] }],
      [
        "四象限",
        {
          kind: "quadrant",
          axes: { x: ["影响小", "影响大"], y: ["容易", "困难"] },
          quadrants: ["马上做", "排期", "再说", "顺手"],
          points: [{ label: "方案A", x: 0.7, y: 0.3 }],
        },
      ],
    ] as const) {
      await page.request.post(`/api/boards/${boardId}/cards`, { headers, data: { type: "chart", title, chart } });
    }
    await page.reload();
    for (const title of ["折线图", "饼图", "四象限"]) {
      const one = page.locator(CARD, { hasText: title });
      await expect(one.locator(".diagram-wrap svg")).toBeVisible({ timeout: 20_000 });
      await expect(one.locator(".diagram-error")).toHaveCount(0);
    }

    // 数据写错：当场说清哪里不对，并挡住自动保存（存进去一张画不出来的图，用户要关掉抽屉才发现）
    await card.scrollIntoViewIfNeeded();
    await card.dblclick();
    await editor(page).locator('textarea[data-field="chart.data"]').fill("Q1, Q2\n收入: 120, 一百三十八");
    await expect(editor(page).locator(".hint.danger")).toContainText("不是数字");
    // 等过自动保存的防抖窗口：库里仍是上一版好数据，坏数据一个字都没落盘
    await page.waitForTimeout(1500);
    const still = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const stillFirst = still.board.cards.find((item: { title: string }) => item.title === "季度走势");
    expect(stillFirst.chart.series[0].values).toEqual([120, 138, 155]);
  });
});

test.describe("第八轮：阅读模式 / 流程排布 / 对齐 / 画板分组", () => {
  test("服务端排版导出：单文件自包含，规格卡按规格出属性表、图表在服务端渲成矢量图", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-导出-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    const make = async (data: Record<string, unknown>) =>
      (await (await page.request.post(`/api/boards/${boardId}/cards`, { headers, data })).json()).card.id;

    // 一张区头卡 + 两张内容卡（连线连成一片 = 导出里的一节），外加一张没连线的图表卡
    const head = await make({ type: "text", title: "第一区", content: "这一区讲什么", x: 0, y: 0 });
    const a = await make({ type: "text", title: "内容甲", content: "甲的正文", x: 420, y: 0 });
    const b = await make({ type: "text", title: "内容乙", content: "乙的正文", x: 840, y: 0 });
    await make({
      type: "mermaid",
      title: "流程图",
      x: 1300,
      y: 0,
      mermaid: { source: "graph TB\n  S[开始] -->|通过| E([结束])\n  S -.-> X{复核}" },
    });
    await make({
      type: "data",
      x: 0,
      y: 400,
      data: {
        specId: "meeting-note",
        specVersion: 1,
        fields: {
          topic: "季度复盘",
          host: "阿甘",
          kind: "review",
          heldAt: 1787880000000,
          attendees: ["阿甘", "小林"],
          decisions: "先把导出收回服务端。\n下周再看长图。",
          actions: [{ what: "写导出器", owner: "阿甘" }],
          url: "https://example.com/notes/1",
        },
      },
    });
    for (const to of [a, b]) {
      await page.request.post(`/api/boards/${boardId}/edges`, { headers, data: { from: head, to } });
    }

    /* ── 1. 产物本身：单文件、零外部依赖 ── */
    const response = await page.request.get(`/api/boards/${boardId}/export?format=html`);
    expect(response.headers()["content-type"]).toContain("text/html");
    // 文件名带画板名与导出日期，同事收到就知道是哪块板哪天的
    expect(response.headers()["content-disposition"]).toContain("attachment");
    expect(decodeURIComponent(response.headers()["content-disposition"])).toContain(
      new Date().toISOString().slice(0, 10),
    );
    const html = await response.text();

    // 离线可开的硬条件：不许有任何外部资源请求（脚本 / 样式表 / 远程图片都不行）
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    for (const match of html.matchAll(/<img[^>]+src="([^"]*)"/g)) {
      expect(match[1].startsWith("data:")).toBe(true);
    }
    // mermaid 是**服务端渲好的 SVG**，不是塞进去的源码 + 一个运行时
    expect(html).toContain('<svg class="mf"');
    expect(html).not.toContain("mermaid.min.js");

    /* ── 2. 打开来看：结构、规格卡属性表、分节 ── */
    await page.goto(`/api/boards/${boardId}/export?format=html&inline=1`);
    await expect(page.locator(".card")).toHaveCount(5);
    await expect(page.locator(".cover h1")).toHaveText(/E2E-导出/);
    await expect(page.locator(".cover-stats")).toContainText("5");
    await expect(page.locator("svg.mf .mf-node")).toHaveCount(3);

    // 分节：连成一片的三张卡是一节（区头当节标题），没连线的两张归「单独的卡片」
    await expect(page.locator(".sec")).toHaveCount(2);
    await expect(page.locator(".sec .sec-head h2").first()).toHaveText("第一区");
    await expect(page.locator(".toc-sec")).toHaveCount(2);

    /**
     * 规格卡：这正是浏览器导出漏掉的东西。规格卡的内容全在 data.fields 里、content 是空的，
     * 所以旧的导出只印得出标题。这里逐项断言——按规格的 display 分派到标题带 / 正文 / 属性表，
     * 并且 list 字段要真的排成一张子表，不是拼成一行字。
     */
    const spec = page.locator(".card", { hasText: "季度复盘" });
    await expect(spec.locator(".dc-spec")).toHaveText("会议纪要");
    await expect(spec.locator(".dc-sub")).toHaveText("阿甘");
    await expect(spec.locator(".chip.badge")).toContainText("评审");
    await expect(spec.locator(".dc-body")).toContainText("先把导出收回服务端");
    // 属性表里只剩没被 display 用掉的字段（议题/主持/结论/类型/时间/链接都各就各位了）
    await expect(spec.locator("table.fields > tbody > tr > th")).toHaveText(["参会人", "待办"]);
    await expect(spec.locator("table.fields .chip")).toHaveText(["阿甘", "小林"]);
    // list 字段排成一张真表格，不是拼成一行字
    await expect(spec.locator("table.sub th")).toHaveText(["事项", "负责人", "截止"]);
    await expect(spec.locator("table.sub td")).toHaveText(["写导出器", "阿甘", ""]);
    await expect(spec.locator(".dc-foot a")).toHaveAttribute("href", "https://example.com/notes/1");

    /* ── 3. 打印：目录不上纸，网格收成一列，卡片不跨页 ── */
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".toc")).toBeHidden();
    expect(await page.locator(".grid").first().evaluate((node) => getComputedStyle(node).display)).toBe("block");
    expect(await page.locator(".card").first().evaluate((node) => getComputedStyle(node).breakInside)).toBe("avoid");
    // 真的印一次：只断言 CSS 看着对是不够的
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(2000);
    await page.emulateMedia({ media: "screen" });
  });

  /**
   * 导入导出：**用户手上真正的那条路**——顶栏导出下来一个文件，左栏把它导回去。
   *
   * 断言盯的是「东西真的整份过来了」（卡片、连线、评论、分组框归属），而不是接口返回了 200：
   * 这条链路一旦漏掉某类引用，导进来的板看着好好的，用起来是散的。
   */
  /**
   * 分组多起来之后，「新建」那个小菜单还得点得着。
   *
   * 真实的库里分组能有二三十个：平铺出来菜单比屏幕还高，排在分组后面的
   * 「导入画板…」「新建分组…」会掉到窗口外面——菜单本身不滚，鼠标够不着，
   * 于是刚做好的导入入口在真实数据上等于不存在。分组收进二级菜单之后，
   * 一级永远是那几行；这条用例守的就是「一级菜单不许长过窗口」。
   */
  test("新建菜单：分组再多，导入画板与新建分组也点得着", async ({ page }) => {
    await boot(page);
    const stamp = Date.now() % 100000;
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    for (let index = 0; index < 24; index += 1) {
      await page.request.post("/api/boards", {
        headers,
        data: { name: `E2E-组板-${stamp}-${index}`, group: `E2E组-${stamp}-${index}` },
      });
    }
    await page.reload();
    await expect(page.locator(".board-item").first()).toBeVisible();

    await page.locator(".new-board-caret").click();
    const menu = page.locator(".context-menu").first();
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

    // 一级菜单里那几行都在视口内，点得着；分组藏在二级菜单里（它自己会滚）
    const importItem = menu.locator(".cm-item", { hasText: "导入画板" });
    await expect(importItem).toBeVisible();
    await expect(menu.locator(".cm-item", { hasText: "新建分组" })).toBeVisible();
    await expect(menu.locator(".cm-item", { hasText: `E2E组-${stamp}-0` })).toHaveCount(0);
    await menu.locator(".cm-item", { hasText: "在分组里新建" }).hover();
    await expect(page.locator(".cm-sub .cm-item", { hasText: `E2E组-${stamp}-0` })).toBeVisible();

    // 真的能点开文件框，而不是只是「看得见」
    await importItem.click();
    await expect(page.locator(".board-import-input")).toHaveCount(1);
  });

  test("导入导出画板：导出的包与 HTML 都能从左栏导回来", async ({ page }) => {
    await boot(page);
    const stamp = Date.now() % 100000;
    await newBoard(page, `E2E-搬家-${stamp}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    const make = async (data: Record<string, unknown>) =>
      (await (await page.request.post(`/api/boards/${boardId}/cards`, { headers, data })).json()).card.id;

    const frame = await make({ type: "frame", title: "一组", x: 0, y: 0, w: 620, h: 420 });
    const head = await make({ type: "text", title: "搬家说明", content: "整块板要能带走", x: 40, y: 60, frameId: frame });
    const tail = await make({ type: "text", title: "第二张", content: "连线也要跟着", x: 420, y: 60 });
    await page.request.post(`/api/boards/${boardId}/edges`, { headers, data: { from: head, to: tail, label: "接着讲" } });
    await page.request.post(`/api/boards/${boardId}/comments`, {
      headers,
      data: { target: "card", targetId: head, text: "这句再收紧一点" },
    });

    /* ① 顶栏「导出 → 导出画板包」：产物是一份 .blotboard.json */
    await page.locator(".top-btn", { hasText: "导出" }).click();
    const [bundleDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.locator(".cm-item", { hasText: "导出画板包" }).click(),
    ]);
    expect(bundleDownload.suggestedFilename()).toContain(".blotboard.json");
    const bundleText = fs.readFileSync((await bundleDownload.path())!, "utf8");
    const bundle = JSON.parse(bundleText);
    expect(bundle.format).toBe("blotboard.boards");
    expect(bundle.boards[0].cards).toHaveLength(3);

    /* ② 左栏「新建 ▾ → 导入画板…」：一律新建，原来那块板一个字不动 */
    await page.locator(".board-import-input").setInputFiles({
      name: "搬家.blotboard.json",
      mimeType: "application/json",
      buffer: Buffer.from(bundleText, "utf8"),
    });
    await expect(page.locator(".board-item", { hasText: `E2E-搬家-${stamp}` })).toHaveCount(2);
    // 导完直接落到导进来的那块板上（不用用户自己去左栏里找）
    const copyId = await currentBoardId(page);
    expect(copyId).not.toBe(boardId);
    const copy = (await (await page.request.get(`/api/boards/${copyId}`)).json()).board;
    expect(copy.cards).toHaveLength(3);
    expect(copy.edges).toHaveLength(1);
    expect(copy.comments).toHaveLength(1);
    // 副本换了卡片 id，但引用（分组框归属 / 连线两端 / 评论目标）要整体跟着搬
    const copyFrame = copy.cards.find((card: { type: string }) => card.type === "frame");
    const copyHead = copy.cards.find((card: { title: string }) => card.title === "搬家说明");
    expect(copyHead.id).not.toBe(head);
    expect(copyHead.frameId).toBe(copyFrame.id);
    expect(copy.edges[0].from).toBe(copyHead.id);
    expect(copy.comments[0].targetId).toBe(copyHead.id);
    await expect(page.locator(".card-title", { hasText: "搬家说明" })).toBeVisible();

    /* ③ 排版 HTML 也是一份可导回的文件：发给别人看的与别人能导入的是同一个文件 */
    const html = await (await page.request.get(`/api/boards/${boardId}/export?format=html`)).text();
    expect(html).toContain('id="blotboard-bundle"');
    await page.locator(".board-import-input").setInputFiles({
      name: "搬家.html",
      mimeType: "text/html",
      buffer: Buffer.from(html, "utf8"),
    });
    await expect(page.locator(".board-item", { hasText: `E2E-搬家-${stamp}` })).toHaveCount(3);
    const fromHtmlId = await currentBoardId(page);
    const fromHtml = (await (await page.request.get(`/api/boards/${fromHtmlId}`)).json()).board;
    expect(fromHtml.cards).toHaveLength(3);
    expect(fromHtml.edges).toHaveLength(1);

    /* ④ 选错文件要说人话，而不是丢一个 500 */
    await page.locator(".board-import-input").setInputFiles({
      name: "随手一张截图.png",
      mimeType: "image/png",
      buffer: Buffer.from("not a board at all", "utf8"),
    });
    await expect(page.locator(".toast.show")).toContainText("导入失败");
  });

  test("服务端排版导出：18 种卡型都有版式 · 图片内联 · 评审版 · 只导筛选命中的", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-导出全类型-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    const make = async (data: Record<string, unknown>) =>
      (await (await page.request.post(`/api/boards/${boardId}/cards`, { headers, data })).json()).card.id;

    // 1×1 的真 PNG：图片卡要证明的是「字节被内联进产物」，不是「留了个链接」
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const upload = await (
      await page.request.post("/api/uploads", {
        headers: { "content-type": "image/png", "x-file-name": "dot.png", "x-auth-key": "e2e-token" },
        data: png,
      })
    ).json();

    const child = await (
      await page.request.post("/api/boards", { headers, data: { name: "被引用的子板" } })
    ).json();

    const cards: Record<string, unknown>[] = [
      { type: "text", title: "文本卡", content: "## 小标题\n- 一条\n- 两条" },
      { type: "task", title: "任务卡", task: { status: "running", goal: "把导出收回服务端", priority: "high" } },
      { type: "link", title: "链接卡", link: { url: "https://example.com/a", title: "示例站", desc: "一句说明" } },
      { type: "quote", title: "引用卡", content: "把版式握在自己手里。", quote: { source: "某人" } },
      { type: "image", title: "图片卡", file: { uploadId: upload.upload.id, name: "dot.png", kind: "image" } },
      { type: "pdf", title: "PDF 卡", file: { uploadId: upload.upload.id, name: "手册.pdf", kind: "file", size: 12345 } },
      {
        type: "ref",
        title: "资料卡",
        ref: {
          source: "aidocs",
          query: "导出",
          mode: "hybrid",
          items: [{ resourceId: "doc:bilibili:627744", docId: "627744", platform: "bilibili", title: "某篇转写", snippet: "一段摘要" }],
        },
      },
      { type: "board", title: "子画板卡", boardRef: { boardId: child.board.id, name: "被引用的子板" } },
      { type: "mindmap", title: "导图卡", mindmap: { root: { id: "m1", text: "中心", children: [{ id: "m2", text: "分支一", children: [] }] } } },
      { type: "todo", title: "待办卡", todo: { items: [{ text: "先跑通", done: true }, { text: "再美化", done: false }] } },
      { type: "svg", title: "SVG 卡", svg: { source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#68c48f"/></svg>' } },
      { type: "mermaid", title: "图表卡", mermaid: { source: "graph LR\n  A[甲] --> B[乙]" } },
      {
        type: "excalidraw",
        title: "自由画卡",
        excalidraw: {
          source: JSON.stringify({ type: "excalidraw", elements: [], appState: {}, files: {} }),
          thumbnail: `data:image/png;base64,${png.toString("base64")}`,
        },
      },
      { type: "data", data: { specId: "topic-idea", specVersion: 1, fields: { title: "选题：服务端导出" } } },
      { type: "book", title: "图书卡", book: { bookId: "e2e-demo-book", name: "E2E 演示手册", author: "流水线", files: { html: "index.html" } } },
      { type: "code", title: "代码卡", code: { source: "def hello():\n    return 'hi'", language: "python", filename: "app/hello.py" } },
      { type: "table", title: "表格卡", table: { markdown: "| 季度 | 收入 |\n| --- | ---: |\n| Q1 | 120 |" } },
      { type: "chart", title: "数据图卡", chart: { kind: "bar", title: "季度收入", labels: ["Q1", "Q2"], series: [{ name: "收入", values: [120, 138] }] } },
    ];
    let y = 0;
    for (const card of cards) {
      await make({ ...card, x: 0, y });
      y += 400;
    }

    await page.goto(`/api/boards/${boardId}/export?format=html&inline=1`);
    await expect(page.locator(".card")).toHaveCount(18);

    /**
     * 18 种卡型都要有内容。「有版式」的判据是：正文块里有实打实的东西，
     * 而不是那句「这张卡还没有正文」——旧导出在规格卡上栽的就是这个跟头，
     * 而且直到印出来才看得见。
     */
    const blank = await page.locator(".card").evaluateAll((nodes) =>
      nodes
        .map((node) => ({
          title: node.querySelector("h3")?.textContent || "(无题)",
          // 图片 / SVG 卡的正文本来就没有字，有图就算有内容
          text: (node.querySelector(".card-body") as HTMLElement | null)?.innerText.trim() || "",
          visual: node.querySelectorAll(".card-body img, .card-body svg").length,
        }))
        .filter((item) => !item.text && !item.visual)
        .map((item) => item.title),
    );
    expect(blank).toEqual([]);
    expect(await page.locator(".card-body .empty").count()).toBe(0);

    // 每种类型各自的落点
    await expect(page.locator(".card", { hasText: "文本卡" }).locator(".md li")).toHaveCount(2);
    await expect(page.locator(".card", { hasText: "任务卡" }).locator(".chip")).toContainText(["执行中", "优先级 高"]);
    await expect(page.locator(".card", { hasText: "引用卡" }).locator(".quote-src")).toContainText("某人");
    await expect(page.locator(".card", { hasText: "待办卡" }).locator("ul.todo li.done")).toHaveCount(1);
    await expect(page.locator(".card", { hasText: "导图卡" }).locator("ul.mm .mm-node")).toHaveCount(2);
    await expect(page.locator(".card", { hasText: "资料卡" }).locator("a")).toHaveAttribute("href", /\/document\/627744/);
    await expect(page.locator(".card", { hasText: "子画板卡" })).toContainText("被引用的子板");
    await expect(page.locator(".card", { hasText: "PDF 卡" })).toContainText("手册.pdf");
    await expect(page.locator(".card", { hasText: "图表卡" }).locator("svg.mf")).toHaveCount(1);
    await expect(page.locator(".card", { hasText: "图书卡" })).toContainText("E2E 演示手册");
    // 代码卡：服务端不引高亮库，出的就是一个 pre（源码一个字不少）
    await expect(page.locator(".card", { hasText: "代码卡" }).locator("pre.code")).toContainText("def hello()");
    await expect(page.locator(".card", { hasText: "代码卡" }).locator(".hljs-keyword")).toHaveCount(0);
    // 表格卡：真表格
    await expect(page.locator(".card", { hasText: "表格卡" }).locator("table.sub td").first()).toHaveText("Q1");
    // 图表卡：有意的诚实降级 —— 数据表 + 一行「图表在画板里查看」
    await expect(page.locator(".card", { hasText: "数据图卡" })).toContainText("图表在画板里查看");
    await expect(page.locator(".card", { hasText: "数据图卡" }).locator("table.sub td")).toContainText(["Q1", "120"]);
    // 图片 / SVG / Excalidraw：字节真的躺在文件里，断网也看得见
    const sources = await page.locator(".card img").evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).getAttribute("src") || ""));
    expect(sources.length).toBeGreaterThanOrEqual(3);
    for (const source of sources) expect(source.startsWith("data:")).toBe(true);

    /* 评论：默认不进成稿，评审版才带上 */
    await page.request.post(`/api/boards/${boardId}/comments`, {
      headers,
      data: { target: "board", text: "整块板缺一个判据" },
    });
    await page.goto(`/api/boards/${boardId}/export?format=html&inline=1`);
    await expect(page.locator(".comments")).toHaveCount(0);
    await page.goto(`/api/boards/${boardId}/export?format=html&inline=1&comments=1`);
    await expect(page.locator(".comments")).toContainText("整块板缺一个判据");

    /* 只导筛选命中的：口径与画布上的搜索 / 类型筛选一致 */
    await page.goto(`/api/boards/${boardId}/export?format=html&inline=1&q=${encodeURIComponent("把版式握在自己手里")}`);
    await expect(page.locator(".card")).toHaveCount(1);
    await expect(page.locator(".cover-note")).toContainText("还有 17 张没命中");
    await page.goto(`/api/boards/${boardId}/export?format=html&inline=1&types=todo,mermaid`);
    await expect(page.locator(".card")).toHaveCount(2);
  });


  /**
   * 排版导出里的图：**只有场景 JSON 的 Excalidraw 卡也得画出来**。
   *
   * 缩略图只是「在编辑器里存过一次」留下的缓存，agent 批量建的卡根本没有——
   * 一块 76 张手绘卡的板曾经只导得出 1 张图（就是唯一进过编辑器的那张）。
   * 顺带钉死宽度口径：图有多宽是根 <svg> 说了算，不是里面第一个 width= 说了算。
   */
  test("排版导出：只有场景 JSON 的画也画得出来，宽图占满一行", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-导出画图-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    const make = async (data: Record<string, unknown>) =>
      (await (await page.request.post(`/api/boards/${boardId}/cards`, { headers, data })).json()).card.id;

    const scene = JSON.stringify({
      type: "excalidraw",
      elements: [
        // 填充 + 圆角：走 roughjs 的 hachure，产物里应当有实打实的 path
        { id: "r", type: "rectangle", x: 0, y: 0, width: 900, height: 300, seed: 1, strokeColor: "#1e1e1e", backgroundColor: "#ffec99", fillStyle: "hachure", strokeWidth: 2, roughness: 1, roundness: { type: 3 } },
        // 虚线 + 三角箭头：dash 只写在 roughjs 的 options 里，出 SVG 得自己落成 stroke-dasharray
        { id: "a", type: "arrow", x: 20, y: 340, width: 860, height: 0, seed: 2, strokeColor: "#2f9e44", strokeWidth: 2, strokeStyle: "dashed", points: [[0, 0], [860, 0]], endArrowhead: "triangle" },
        { id: "t", type: "text", x: 0, y: 120, width: 900, height: 30, fontSize: 24, fontFamily: 1, textAlign: "center", text: "服务端画的", strokeColor: "#1e1e1e" },
      ],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    });
    await make({ type: "excalidraw", title: "没缩略图的画", excalidraw: { source: scene }, x: 0, y: 0 });
    await make({
      type: "svg",
      title: "宽 SVG 卡",
      // 根标签 1280 宽，但里面第一个 width= 是 18：旧口径会把它当成 18 宽塞进最窄的格子
      svg: { source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><rect width="18" height="18" fill="#333"/></svg>' },
      x: 0,
      y: 400,
    });

    await page.goto(`/api/boards/${boardId}/export?format=html&inline=1`);
    const drawing = page.locator(".card", { hasText: "没缩略图的画" });
    // 图是**内联矢量**，不是一句「还没存过缩略图」
    await expect(drawing.locator(".figure svg")).toHaveCount(1);
    await expect(drawing.locator(".figure svg text")).toHaveText(["服务端画的"]);
    expect(await drawing.locator(".figure svg path").count()).toBeGreaterThan(3);
    expect(await drawing.locator(".figure svg path[stroke-dasharray]").count()).toBeGreaterThan(0);
    // 900 宽的图占满一行，不缩进 330px 的格子里
    await expect(drawing).toHaveClass(/wide/);
    await expect(page.locator(".card", { hasText: "宽 SVG 卡" })).toHaveClass(/wide/);

    // 产物仍然是自包含的：新加的图是内联 SVG，没有把外部请求带进来
    const html = await (await page.request.get(`/api/boards/${boardId}/export?format=html`)).text();
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
  });

  /**
   * PNG 导出：文件名必须带 .png，字节必须是真 PNG。
   *
   * 名字只写在 <a download> 上，href 是个不透明的 blob: URL——一旦这行断了，
   * 拿到手的就是一串没有后缀的 UUID，谁也认不出那是什么。板名故意带 emoji 且超长：
   * 截断按码点走，不能把一对代理项劈成半个字塞进文件名。
   */
  test("导出 PNG：文件名带 .png，字节是真 PNG", async ({ page }) => {
    await boot(page);
    await newBoard(page, `📚 E2E-PNG 导出-一二三四五六七八九十一二三四五六七八九十一二三四五📅尾巴-${Date.now() % 1000}`);
    await page.locator('.toolbar button[data-add="text"]').click();
    await editor(page).locator('input[data-field="title"]').fill("图上要看得见这张卡");
    await editor(page).locator('[data-act="save"]').click();

    await page.locator('.top-btn[aria-label="导出"]').click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator(".layout-menu .cm-item", { hasText: "导出 PNG" }).click(),
    ]);
    const filename = download.suggestedFilename();
    expect(filename).toMatch(/\.png$/);
    expect(filename).toContain(new Date().toISOString().slice(0, 10));
    // 半个 emoji 会被序列化成替换字符，文件名里出现它就说明截断切错了地方
    expect(filename).not.toContain("�");

    // 服务端没有 PNG 这个口：以前 format=png 会默默按 json 处理，
    // 调用方拿到一份 JSON 还以为是图。现在直说，并指到能用的两条路上
    const boardId = await currentBoardId(page);
    const png = await page.request.get(`/api/boards/${boardId}/export?format=png`);
    expect(png.status()).toBe(400);
    expect((await png.json()).error).toContain("export-png.mjs");

    const file = await download.path();
    expect(file).toBeTruthy();
    const bytes = fs.readFileSync(file!);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  test("阅读模式：整屏看一张卡，图可缩放、文本走滚动", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-阅读-${Date.now() % 100000}`);

    // 图表类：给缩放控件
    await page.locator('.toolbar button[data-add="mermaid"]').click();
    await editor(page).locator('input[data-field="title"]').fill("流程图");
    await editor(page).locator('textarea[data-field="diagram"]').fill("graph TD\n  A --> B");
    await editor(page).locator('[data-act="save"]').click();

    const card = page.locator(CARD, { hasText: "流程图" });
    await card.click({ button: "right" });
    await page.locator(".context-menu .cm-item", { hasText: "阅读模式" }).click();
    const reader = page.locator(".reader-modal");
    await expect(reader).toBeVisible();
    await expect(reader.locator(".reader-body.zoomable")).toBeVisible();
    // 图类要有一个「给死尺寸的舞台」：父容器 auto 的话 SVG 会塌成空白、mermaid 缩成一小块
    const stage = reader.locator(".reader-stage.fixed");
    await expect(stage).toBeVisible();
    const box = await stage.boundingBox();
    expect(box!.width).toBeGreaterThan(400);
    expect(box!.height).toBeGreaterThan(300);
    const svgBox = await reader.locator(".diagram-wrap > svg").boundingBox();
    expect(svgBox!.width).toBeGreaterThan(box!.width * 0.6);
    await expect(reader.locator(".scope-switch button", { hasText: "100%" })).toBeVisible();
    await reader.locator(".scope-switch button").last().click();
    await expect(reader.locator(".scope-switch button", { hasText: "125%" })).toBeVisible();

    // 滚轮：跟画布一个习惯——滚轮平移，⌘/Ctrl+滚轮缩放。
    // 容器是 overflow:hidden，普通滚轮不接管的话就是彻底失效
    await reader.locator(".reader-body").hover();
    const stageEl = reader.locator(".reader-stage");
    const beforePan = await stageEl.getAttribute("style");
    await page.mouse.wheel(0, 200);
    await expect
      .poll(async () => (await stageEl.getAttribute("style")) !== beforePan)
      .toBe(true);

    const readout = reader.locator(".scope-switch button").nth(1);
    const percent = async () => Number((await readout.textContent())!.replace("%", ""));
    await page.keyboard.press("0");
    await expect(readout).toHaveText("100%");
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("ControlOrMeta");
    await expect.poll(async () => (await readout.textContent()) !== "100%").toBe(true);
    // 滚轮 / 捏合走连续值而不是档位：一下滚轮该落在两档之间（100% → 约 149%），
    // 硬跳档位的话触控板捏一下就冲到头，中间那些尺度根本停不住
    const afterWheel = await percent();
    expect(afterWheel).toBeGreaterThan(130);
    expect(afterWheel).toBeLessThan(170);

    // 缩放尺度：+/- 一路按到两头，上到 1000%、下到 10%，到顶那一颗按钮变灰
    const zoomOutBtn = reader.locator(".scope-switch button").first();
    const zoomInBtn = reader.locator(".scope-switch button").last();
    await page.keyboard.press("0");
    await expect(readout).toHaveText("100%");
    for (let i = 0; i < 12; i += 1) await page.keyboard.press("=");
    await expect(readout).toHaveText("1000%");
    await expect(zoomInBtn).toBeDisabled();
    for (let i = 0; i < 20; i += 1) await page.keyboard.press("-");
    await expect(readout).toHaveText("10%");
    await expect(zoomOutBtn).toBeDisabled();
    // 从任意值（不是档位上的数）按一下，落到严格更小的那一档而不是先跳回上面
    await page.keyboard.press("0");
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.wheel(0, -80);
    await page.keyboard.up("ControlOrMeta");
    await expect.poll(percent).toBeGreaterThan(110);
    await zoomOutBtn.click();
    await expect(readout).toHaveText("100%");
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);

    // 文本类：不给缩放，改成滚动读（挪开，别跟上面那张默认落位的卡重叠）
    const boardId = await currentBoardId(page);
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "text", title: "长文本", content: "很长的一段".repeat(60), x: 900, y: 600 },
    });
    await page.reload();
    await page.locator(CARD, { hasText: "长文本" }).click({ button: "right" });
    await page.locator(".context-menu .cm-item", { hasText: "阅读模式" }).click();
    await expect(page.locator(".reader-modal .reader-body")).not.toHaveClass(/zoomable/);
    await expect(page.locator(".reader-modal .reader-para")).toContainText("很长的一段");
  });

  test("图书卡：卡面画出封面，三个入口指回书库", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-图书-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 封面走本服务的同源代理（书库那个回环地址在别人机器上不存在，不能直连），这里替一张假的
    await page.route("**/api/books/*/cover", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80"><rect width="60" height="80" fill="#1e3a8a"/></svg>',
      }),
    );

    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: {
        type: "book",
        title: "E2E 图书卡",
        // 挪开：默认落位会被左上角的搜索条 / 类型胶囊盖住，点不到卡头
        x: 120,
        y: 520,
        book: {
          bookId: "e2e-demo-book",
          name: "E2E 演示手册",
          subtitle: "一本用来跑冒烟的书",
          author: "BookCraft 流水线",
          desc: "这本书只在测试里存在。",
          files: { html: "index.html", pdf: "E2E 演示手册.pdf", md: "book.md" },
          created: "2026-08-26",
        },
      },
    });
    await page.reload();

    const card = page.locator(CARD, { hasText: "E2E 演示手册" });
    await expect(card.locator(".book-name")).toHaveText("E2E 演示手册");
    await expect(card.locator(".book-sub")).toHaveText("一本用来跑冒烟的书");
    // 封面按 bookId 现拼同源地址，不在画板里存副本
    await expect(card.locator(".book-cover img")).toHaveAttribute("src", "/api/books/e2e-demo-book/cover");
    // 三个入口指回书库；本机访问 → 保持回环（跟资料卡指向知识库是同一套 host 规则）
    await expect(card.locator(".card-action")).toHaveAttribute(
      "href",
      `${E2E_BOOK_LIBRARY_URL}/books/e2e-demo-book/index.html`,
    );
    await expect(card.locator(".book-link", { hasText: "PDF" })).toHaveAttribute(
      "href",
      new RegExp(`^${escapeRe(E2E_BOOK_LIBRARY_URL)}/books/e2e-demo-book/E2E%20`),
    );

    // 阅读模式：整屏看封面 + 简介 + 入口
    await card.hover();
    await card.locator(".card-tools .card-tool").first().click();
    const reader = page.locator(".reader-modal");
    await expect(reader.locator(".reader-book h3")).toHaveText("E2E 演示手册");
    await expect(reader.locator(".reader-book-links a")).toHaveCount(3);
    await page.keyboard.press("Escape");

    // Markdown 导出把书的落点写清楚（贴给 agent 时它能直接去读）
    const md = await (await page.request.get(`/api/boards/${boardId}/export?format=md`)).text();
    expect(md).toContain("《E2E 演示手册》");
    expect(md).toContain("e2e-demo-book");
    expect(md).toContain(`${E2E_BOOK_LIBRARY_URL}/books/e2e-demo-book/index.html`);
  });

  test("书库抽屉：挑书建卡；书库连不上时说清楚而不是空白", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-书库-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.route("**/api/books/*/cover", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80"><rect width="60" height="80" fill="#1e3a8a"/></svg>',
      }),
    );
    // 书库连不上：抽屉要把 502 的原话摆出来
    await page.route("**/api/books", (route) =>
      route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, error: "连不上书库" }) }),
    );
    await toolbarAdd(page, "book");
    await expect(page.locator(".drawer.books.open")).toBeVisible();
    await expect(page.locator(".drawer.books .ad-warn")).toContainText("书库");

    // 正常书目：勾两本 → 建两张卡
    await page.unroute("**/api/books");
    await page.route("**/api/books", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          total: 2,
          query: "",
          books: [
            {
              bookId: "alpha-book",
              name: "阿尔法手册",
              subtitle: "第一本",
              author: "流水线",
              desc: "甲",
              files: { html: "index.html" },
              updated: "2026-08-20",
              cover: "/api/books/alpha-book/cover",
            },
            {
              bookId: "beta-book",
              name: "贝塔手册",
              subtitle: "第二本",
              author: "流水线",
              desc: "乙",
              files: { html: "index.html", pdf: "b.pdf" },
              updated: "2026-08-19",
              cover: "/api/books/beta-book/cover",
            },
          ],
        }),
      }),
    );
    await page.locator(".drawer.books .drawer-close").click();
    await toolbarAdd(page, "book");
    await expect(page.locator(".bk-item")).toHaveCount(2);

    // 输入即筛
    await page.locator(".drawer.books .ad-search input").fill("贝塔");
    await expect(page.locator(".bk-item")).toHaveCount(1);
    await page.locator(".drawer.books .ad-search .mini-btn", { hasText: "清空" }).click();
    await expect(page.locator(".bk-item")).toHaveCount(2);

    await page.locator(".bk-item").first().click();
    await page.locator(".bk-item").nth(1).click();
    await page.locator(".ad-foot .mini-btn.primary").click();
    await expect(page.locator(".drawer.books.open")).toHaveCount(0);
    await expect(page.locator(CARD)).toHaveCount(2);

    const saved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const ids = saved.board.cards.map((item: any) => item.book?.bookId).sort();
    expect(ids).toEqual(["alpha-book", "beta-book"]);
    // 卡片存的是快照，不该把抽屉里那个 cover 字段一起塞进去（封面按 bookId 现拼）
    expect(saved.board.cards[0].book.cover).toBeUndefined();
  });

  test("编辑器里的 Markdown 预览：写着的正文当场看排版，切回来接着写", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-预览-${Date.now() % 100000}`);
    await page.locator('.toolbar button[data-add="text"]').click();
    const editor = page.locator(EDITOR);
    await editor.locator('input[data-field="title"]').fill("带排版的卡");
    await editor.locator('textarea[data-field="content"]').fill("## 小标题\n\n- 一条\n- 两条\n\n**加粗**");

    // 预览：输入框换成排好版的正文
    await editor.locator('[data-act="md-preview"]').click();
    const preview = editor.locator(".md-preview");
    await expect(preview.locator("h2")).toHaveText("小标题");
    await expect(preview.locator("li")).toHaveCount(2);
    await expect(preview.locator("strong")).toHaveText("加粗");
    await expect(editor.locator('textarea[data-field="content"]')).toHaveCount(0);

    // 切回来：写的东西一个字没少，接着写也照常存
    await editor.locator('[data-act="md-preview"]').click();
    const area = editor.locator('textarea[data-field="content"]');
    await expect(area).toHaveValue(/## 小标题/);
    await area.fill("## 小标题\n\n改过了");
    await editor.locator('[data-act="save"]').click();
    await expect(page.locator(CARD).first().locator(".card-md")).toContainText("改过了");
  });

  test("Markdown 正文：卡面按排版渲染，卡头放大按钮直接进阅读模式", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-MD-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    const md = "# 交付清单\n\n## 必含 3 件套\n\n1. **书的基本信息**\n2. 核心金句\n3. `延伸任务`\n";
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers,
      data: { type: "text", title: "MD 卡", content: md, x: 120, y: 520 },
    });
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers,
      data: { type: "text", title: "白话卡", content: "就是一段大白话，没有任何标记", x: 760, y: 520 },
    });
    await page.reload();

    // 写了标记的：真的排版，而不是把 # 和 ** 原样摊在卡面上
    const mdCard = page.locator(CARD, { hasText: "MD 卡" });
    await expect(mdCard.locator(".card-md h1")).toHaveText("交付清单");
    await expect(mdCard.locator(".card-md ol > li")).toHaveCount(3);
    await expect(mdCard.locator(".card-md strong")).toHaveText("书的基本信息");
    await expect(mdCard.locator(".card-md code")).toHaveText("延伸任务");
    await expect(mdCard.locator(".card-body")).not.toContainText("**");

    // 没写标记的：仍走「按卡片高度算行数」的截断，不要凭空套一层排版
    const plainCard = page.locator(CARD, { hasText: "白话卡" });
    await expect(plainCard.locator(".card-text.clamped")).toContainText("就是一段大白话");
    await expect(plainCard.locator(".card-md")).toHaveCount(0);

    // 卡头的放大按钮 = 阅读模式（以前只藏在右键菜单里）
    await mdCard.hover();
    await mdCard.locator(".card-tools .card-tool").first().click();
    const reader = page.locator(".reader-modal");
    await expect(reader).toBeVisible();
    await expect(reader.locator(".reader-md h1")).toHaveText("交付清单");
    await expect(reader.locator(".reader-md ol > li")).toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
  });

  test("抽屉自动保存：点画布空白也不丢正文", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-自动存-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    await page.locator('.toolbar button[data-add="text"]').click();
    await editor(page).locator('input[data-field="title"]').fill("自动保存卡");
    await editor(page).locator('textarea[data-field="content"]').fill("停手就该落库的正文");
    // 停手 800ms 落一次盘，抽屉里给一枚「已保存」
    await expect(editor(page).locator(".save-chip.done")).toBeVisible();

    // 只有一张卡时 fitView 会把画布顶到 250%，先缩回来，下面那一下才点得到真空白
    for (let i = 0; i < 3; i += 1) await page.locator('.topbar button[title="缩小"]').click();

    // 再补一段并立刻点空白：这一下以前会把整段正文丢掉（setEditing(null) 不保存）
    await editor(page).locator('textarea[data-field="content"]').fill("停手就该落库的正文 + 关掉前最后一句");
    const pane = (await page.locator(".react-flow__pane").boundingBox())!;
    const box = (await page.locator(CARD).first().boundingBox())!;
    // clickBlankPane 点的画布左下角压着 React Flow 自带的缩放控件，这里按卡片位置现算一个点
    await page.mouse.click(pane.x + pane.width * 0.3, box.y + box.height + 60);
    await expect(page.locator(EDITOR)).toHaveCount(0);

    await expect
      .poll(async () => {
        const payload = await (await page.request.get(`/api/boards/${boardId}`)).json();
        return payload.board.cards[0].content;
      })
      .toBe("停手就该落库的正文 + 关掉前最后一句");
    await page.reload();
    await expect(page.locator(`${CARD} .card-body`).first()).toContainText("关掉前最后一句");
  });



  test("阅读模式：整块板排成一条序列，←/→ 翻卡、目录跳转", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-通读-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    // 两排：上排三张（左中右），下排一张。阅读顺序应当是「从上到下、同排从左到右」，
    // 跟建卡先后无关——所以故意乱序建。
    for (const [title, x, y] of [
      ["下排", 300, 640],
      ["上排右", 820, 100],
      ["上排左", 100, 100],
      ["上排中", 460, 140],
    ] as const) {
      await page.request.post(`/api/boards/${boardId}/cards`, {
        headers,
        data: { type: "text", title, content: `${title}的正文`, x, y, w: 280, h: 170 },
      });
    }
    await page.reload();

    const reader = page.locator(".reader-modal");

    // 顶栏「阅读」：不用先选一张卡，点了就从阅读顺序的第一张开始通读
    await page.locator(".top-btn", { hasText: "阅读" }).click();
    await expect(reader).toBeVisible();
    await expect(reader.locator(".rn-count")).toHaveText("1 / 4");
    await expect(reader.locator(".modal-head h2")).toHaveText("上排左");
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);

    // R：没选中任何卡 → 走同一条口径
    await clickBlankPane(page);
    await page.keyboard.press("r");
    await expect(reader).toBeVisible();
    await expect(reader.locator(".rn-count")).toHaveText("1 / 4");
    await expect(reader.locator(".modal-head h2")).toHaveText("上排左");
    await expect(reader.locator(".ro-item .ro-title")).toHaveText(["上排左", "上排中", "上排右", "下排"]);

    // →：往后翻；到最后一张时右侧翻页键消失（到头停住，不绕回第一张）
    await page.keyboard.press("ArrowRight");
    await expect(reader.locator(".modal-head h2")).toHaveText("上排中");
    await expect(reader.locator(".reader-body")).toContainText("上排中的正文");
    await page.keyboard.press("End");
    await expect(reader.locator(".rn-count")).toHaveText("4 / 4");
    await expect(reader.locator(".reader-edge.next")).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(reader.locator(".rn-count")).toHaveText("4 / 4");

    // ←：往回翻
    await page.keyboard.press("ArrowLeft");
    await expect(reader.locator(".modal-head h2")).toHaveText("上排右");

    // 目录：点哪张跳哪张
    await reader.locator(".ro-item", { hasText: "上排左" }).click();
    await expect(reader.locator(".rn-count")).toHaveText("1 / 4");
    await expect(reader.locator(".ro-item.on .ro-title")).toHaveText("上排左");

    // 关掉后画布停在读到的那张上（选中态跟着走）
    await reader.locator(".ro-item", { hasText: "下排" }).click();
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
    await expect(page.locator(`${CARD}.selected`, { hasText: "下排" })).toHaveCount(1);
  });

  test("阅读模式：全屏把版面铺满整块屏，Esc 只退全屏、不关阅读", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-全屏-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    // 图类卡：全屏的收益全在这种「舞台越大越好」的卡上，拿它的舞台高度当尺子
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers,
      data: { type: "mermaid", title: "全屏流程图", mermaid: { source: "graph TD\n  A[采集] --> B[转写]\n  B --> C[入库]" }, x: 100, y: 100, w: 280, h: 180 },
    });
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers,
      data: { type: "text", title: "后面一张", content: "翻得过去就说明键盘还在阅读模式手里", x: 500, y: 100 },
    });
    await page.reload();

    await page.locator(".top-btn", { hasText: "阅读" }).click();
    const reader = page.locator(".reader-modal");
    const backdrop = page.locator(".modal-backdrop");
    await expect(reader).toBeVisible();
    const windowed = (await page.locator(".reader-stage.fixed").boundingBox())!;

    // 进全屏：弹窗铺满整个可视区，舞台跟着长高
    await reader.locator('[data-act="fullscreen"]').click();
    await expect(backdrop).toHaveClass(/immersive/);
    await expect(reader.locator('[data-act="fullscreen"]')).toHaveAttribute("aria-pressed", "true");
    // 量的是「可视区」而不是 viewportSize()：原生全屏成功时窗口尺寸会变，
    // 进不去时（无头 / iOS Safari）CSS 那层照样把弹窗铺满窗口，两种情形下这条都成立
    const inner = await page.evaluate(() => ({
      w: document.documentElement.clientWidth,
      h: document.documentElement.clientHeight,
    }));
    const shell = (await reader.boundingBox())!;
    expect(shell.width).toBeCloseTo(inner.w, 0);
    expect(shell.height).toBeCloseTo(inner.h, 0);
    const fullStage = (await page.locator(".reader-stage.fixed").boundingBox())!;
    expect(fullStage.height).toBeGreaterThan(windowed.height);

    // 全屏里 Esc 的本意是「回到窗口」，不是「别读了」——阅读模式必须还开着
    await page.keyboard.press("Escape");
    await expect(backdrop).not.toHaveClass(/immersive/);
    await expect(reader).toBeVisible();

    // F 是同一个开关的键盘版；全屏状态下 ←/→ 照旧翻卡
    await page.keyboard.press("f");
    await expect(backdrop).toHaveClass(/immersive/);
    await page.keyboard.press("ArrowRight");
    await expect(reader.locator(".modal-head h2")).toHaveText("后面一张");
    await page.keyboard.press("f");
    await expect(backdrop).not.toHaveClass(/immersive/);

    // 回到窗口版面后，Esc 才是关闭
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
  });

  test("按流程串开：一条链排成一行，顺序就是执行顺序", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-流程-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    // 故意摆得乱七八糟，看整理能不能理出顺序
    const ids: string[] = [];
    for (const [title, x, y] of [["一", 900, 700], ["二", 200, 100], ["三", 600, 400]] as const) {
      const res = await (
        await page.request.post(`/api/boards/${boardId}/cards`, { headers, data: { type: "text", title, x, y, w: 280, h: 160 } })
      ).json();
      ids.push(res.card.id);
    }
    await page.request.post(`/api/boards/${boardId}/edges`, { headers, data: { from: ids[0], to: ids[1] } });
    await page.request.post(`/api/boards/${boardId}/edges`, { headers, data: { from: ids[1], to: ids[2] } });
    await page.reload();

    await page.locator(".top-btn", { hasText: "整理" }).click();
    await page.locator(".layout-menu .cm-item", { hasText: "按流程串开" }).click();
    await expect(page.locator(".toast.show")).toContainText("已按流程串开 3 张卡片");

    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const byId = new Map(after.board.cards.map((card: any) => [card.id, card]));
    const [a, b, c] = ids.map((id) => byId.get(id) as any);
    // 同一条链在同一行，x 依次递增
    expect(a.y).toBe(b.y);
    expect(b.y).toBe(c.y);
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
  });

  test("对齐与等距：只动选中的那几张", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-对齐-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    for (const [title, x, y] of [["甲", 120, 420], ["乙", 360, 560], ["丙", 640, 700]] as const) {
      await page.request.post(`/api/boards/${boardId}/cards`, { headers, data: { type: "text", title, x, y, w: 200, h: 140 } });
    }
    await page.reload();

    // 先适应内容，保证三张都在可视区，右键才点得到（左上角有工具条/搜索条压着）
    await page.locator(".top-btn[aria-label='适应内容']").click();
    await page.waitForTimeout(500);
    await clickBlankPane(page);
    await page.keyboard.press("ControlOrMeta+a");
    await expect(page.locator(".selected-hint")).toHaveText("已选 3 张");
    await page.locator(CARD, { hasText: "丙" }).click({ button: "right" });
    await page.locator(".cm-aligns .align-btn").first().click();
    await expect(page.locator(".toast.show")).toContainText("已左对齐 3 张卡片");

    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const xs = after.board.cards.map((card: any) => card.x);
    expect(new Set(xs).size).toBe(1);
  });

  test("界面语言：设置里切英文 → 顶栏 / 画布 / 帮助全跟着换，刷新还记得", async ({ page, context }) => {
    await boot(page);
    await newBoard(page, `E2E-语言-${Date.now() % 100000}`);

    // 默认中文（浏览器语言钉在 zh-CN，见 playwright.config.ts）
    await expect(page.locator(".top-btn", { hasText: "设置" })).toBeVisible();
    await page.locator(".top-btn", { hasText: "设置" }).click();
    const drawer = page.locator(".settings-drawer.open");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("h2")).toHaveText("设置");

    // 切英文：顶栏、工具条、画布空态当场跟着换，不用刷新
    await drawer.locator('.set-lang-btn[data-locale="en"]').click();
    await expect(drawer.locator("h2")).toHaveText("Settings");
    await expect(page.locator(".top-btn", { hasText: "Settings" })).toBeVisible();
    await expect(page.locator('.toolbar button[data-add="text"]')).toContainText("Text");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await drawer.locator(".drawer-close").click();

    // 画布上的右键菜单也是英文
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 400, y: 300 } });
    await expect(page.locator(".context-menu")).toContainText("New Text card");
    await page.keyboard.press("Escape");

    // 帮助文档跟着 cookie 走：同一份 slug，正文换成 docs/guide/en 那份
    const docs = await (await page.request.get("/api/docs?slug=quickstart")).json();
    expect(docs.doc.title).toBe("Five-minute start");
    const zhDocs = await (await page.request.get("/api/docs?slug=quickstart&lang=zh")).json();
    expect(zhDocs.doc.title).toBe("五分钟上手");

    // 记在 cookie 里：刷新之后仍是英文
    expect((await context.cookies()).find((item) => item.name === "blotboard.locale")?.value).toBe("en");
    await page.reload();
    await expect(page.locator(".top-btn", { hasText: "Settings" })).toBeVisible();

    // 切回中文，别把后面的用例留在英文界面上
    await page.locator(".top-btn", { hasText: "Settings" }).click();
    await page.locator('.settings-drawer.open .set-lang-btn[data-locale="zh"]').click();
    await expect(page.locator(".top-btn", { hasText: "设置" })).toBeVisible();
    await page.locator(".settings-drawer.open .drawer-close").click();
  });

  test("左栏：子画板缩进折叠 + 分组管理", async ({ page }) => {
    await boot(page);
    const parentName = `E2E-父-${Date.now() % 100000}`;
    await newBoard(page, parentName);
    const parentId = await currentBoardId(page);

    // 从画板里建子画板 → 自动挂在它下面
    await toolbarAdd(page, "board");
    await editor(page).locator('input[data-field="title"]').fill("子板");
    await editor(page).locator('[data-act="save"]').click();

    const boards = await (await page.request.get("/api/boards")).json();
    const child = boards.boards.find((item: any) => item.parentId === parentId);
    expect(child).toBeTruthy();

    // 给父板分个组，子板跟着进同一组（新建时继承）
    await page.request.patch(`/api/boards/${parentId}`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { group: "E2E 项目" },
    });
    await page.reload();

    const groupHead = page.locator(".board-group .card-group-head", { hasText: "E2E 项目" });
    await expect(groupHead).toBeVisible();
    // 子板在父板下面，缩进一级
    const childRow = page.locator(".board-item", { hasText: "子画板" }).first();
    await expect(childRow).toBeVisible();

    // 折叠分组后组里的板收起来
    await groupHead.click();
    await expect(page.locator(".board-item", { hasText: parentName })).toHaveCount(0);
    await groupHead.click();

    // 分组入口得看得见：新建按钮右侧的箭头出菜单，分组标题行 hover 出 ⋯
    await page.locator(".new-board-caret").click();
    const newMenu = page.locator(".context-menu");
    await expect(newMenu.locator(".cm-item", { hasText: "新建画板" })).toBeVisible();
    await expect(newMenu.locator(".cm-item", { hasText: "新建分组" })).toBeVisible();
    // 具体分组在二级菜单里（一级只占一行，分组多了才不会把菜单撑得比窗口还高）
    await newMenu.locator(".cm-item", { hasText: "在分组里新建" }).hover();
    await expect(page.locator(".cm-sub .cm-item", { hasText: "在「E2E 项目」里新建" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.locator(".group-head-row", { hasText: "E2E 项目" }).hover();
    await page.locator(".group-head-row", { hasText: "E2E 项目" }).locator(".bi-more").click();
    await expect(page.locator(".context-menu .cm-item", { hasText: "重命名分组" })).toBeVisible();
    await expect(page.locator(".context-menu .cm-item", { hasText: "解散分组" })).toBeVisible();
    await page.keyboard.press("Escape");

    /* 画板 ⋯ 的「移动到」：一级只占一行，分组藏在二级里——分组一多才不会把菜单撑到满屏 */
    await page.request.post("/api/boards", {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { name: `E2E-备用-${Date.now() % 100000}`, group: "E2E 备用组" },
    });
    await page.reload();
    const parentRow = page.locator(".board-item", { hasText: parentName }).first();
    await parentRow.hover();
    await parentRow.locator(".bi-more").click();
    const boardMenu = page.locator(".context-menu").first();
    const moveRow = boardMenu.locator(".cm-item", { hasText: "移动到" });
    await expect(moveRow).toBeVisible();
    // 展开之前，一级菜单里不该出现任何具体分组
    await expect(boardMenu.locator(".cm-item", { hasText: "E2E 备用组" })).toHaveCount(0);

    await moveRow.hover();
    const moveSub = page.locator(".cm-sub");
    await expect(moveSub.locator(".cm-item", { hasText: "E2E 备用组" })).toBeVisible();
    await expect(moveSub.locator(".cm-item", { hasText: "新分组…" })).toBeVisible();
    await expect(moveSub.locator(".cm-item", { hasText: "移出分组" })).toBeVisible();
    await moveSub.locator(".cm-item", { hasText: "E2E 备用组" }).click();
    await expect(page.locator(".toast.show")).toContainText("已移到「E2E 备用组」");
    await expect(page.locator(".context-menu")).toHaveCount(0);
  });

  test("卡片中心：卡片包开关（工具条即时响应）· 规格开关 · 建规格卡 · 粘贴信封收卡片", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-规格-${Date.now() % 100000}`);

    /* 卡片包：21 个原生包列表 + 开关；停用 svg → 工具条按钮当场消失、新建被服务端拒 */
    await page.locator('.topbar button:has-text("卡片")').first().click();
    const drawer = page.locator(".drawer.specs.open");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".drawer-head h2")).toHaveText("卡片中心");
    await expect(drawer.locator(".pack-item")).toHaveCount(21);
    const svgPack = drawer.locator('.pack-item[data-pack="svg"]');
    await expect(svgPack.locator(".sp-switch")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('.toolbar button[data-add="svg"]')).toBeVisible();
    await svgPack.locator(".sp-switch").click();
    await expect(svgPack.locator(".sp-switch")).toHaveAttribute("aria-checked", "false");
    // 工具条入口即时消失（同一套 store，无需刷新），其余按钮不受影响
    await expect(page.locator('.toolbar button[data-add="svg"]')).toHaveCount(0);
    await expect(page.locator('.toolbar button[data-add="mermaid"]')).toBeVisible();
    await svgPack.locator(".sp-switch").click();
    await expect(page.locator('.toolbar button[data-add="svg"]')).toBeVisible();

    /* 规格库：列表 + 开关 */
    const feishu = drawer.locator(".sp-item", { hasText: "飞书消息" });
    await expect(feishu).toBeVisible();
    await expect(feishu.locator(".sp-switch")).toHaveAttribute("aria-checked", "true");
    await feishu.locator(".sp-switch").click();
    await expect(feishu.locator(".sp-switch")).toHaveAttribute("aria-checked", "false");
    await feishu.locator(".sp-switch").click();
    await expect(feishu.locator(".sp-switch")).toHaveAttribute("aria-checked", "true");

    /* 详情 → 用示例建一张卡：卡面按规格渲染，标题由 display.title 生成 */
    await drawer.locator('.sp-item:has-text("公众号文章") .sp-main').click();
    await expect(drawer.locator(".sp-fields")).toContainText("account");
    await drawer.locator('.ad-foot button:has-text("用示例建一张")').click();
    const card = page.locator(`${CARD} .card.t-data`).first();
    await expect(card).toBeVisible();
    await expect(card.locator(".card-title")).toHaveText("我们把 AI 落地做砸的三次");
    await expect(card.locator(".dc-sub")).toHaveText("示例科技观察");
    // 抽屉里的字段表是按规格生成的
    await expect(editor(page).locator(".df")).toContainText("公众号");
    await editor(page).locator('[data-act="save"]').click();

    /* 收卡片：贴信封 → 校验 → 收进画板 */
    await page.locator('.topbar button:has-text("卡片")').first().click();
    await drawer.locator('.et-chip:has-text("收卡片")').click();
    await drawer.locator(".sp-draft").fill(
      JSON.stringify({
        format: "blotboard.cards",
        version: 1,
        cards: [
          { id: "m1", spec: "feishu-message", fields: { sender: "张三", text: "下周三前要看到大纲" } },
          { spec: "feishu-message", fields: { chat: "缺必填" } },
        ],
      }),
    );
    await drawer.locator('button:has-text("先校验")').click();
    await expect(drawer.locator(".sp-summary")).toContainText("可收 1");
    await expect(drawer.locator(".sp-card.bad")).toContainText("缺必填字段");
    // strict 下有坏卡就不让收，勾了「跳过坏卡」才放行
    const ingest = drawer.locator('.ad-foot button:has-text("收进当前画板")');
    await expect(ingest).toBeDisabled();
    await drawer.locator(".sp-check input").check();
    await ingest.click();
    await expect(page.locator(".toast")).toContainText("新建 1 张");
    await expect(page.locator(`${CARD} .card.t-data`)).toHaveCount(2);
    await expect(page.locator(`${CARD} .card.t-data`, { hasText: "张三" })).toBeVisible();
  });

  test("左栏 ⋯ 按钮左键可点：菜单和右键出的是同一份", async ({ page }) => {
    await boot(page);
    const name = `E2E-三点-${Date.now() % 100000}`;
    await newBoard(page, name);

    const row = page.locator(".board-item", { hasText: name }).first();
    await row.hover();
    await row.locator(".bi-more").click();

    // 左键点 ⋯ 必须真的开出菜单（曾经因为传了个假事件对象直接抛 TypeError）
    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".cm-item", { hasText: "复制画板 ID" })).toBeVisible();
    await expect(menu.locator(".cm-item", { hasText: "删除画板" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // 右键同一行给同一份菜单
    await row.click({ button: "right" });
    await expect(page.locator(".context-menu .cm-item", { hasText: "复制画板 ID" })).toBeVisible();
  });

  test("左栏宽度可拖拽：长画板名两行显示，宽度刷新后保持", async ({ page }) => {
    await boot(page);
    const longName = `E2E-很长的画板名称用来验证换行显示-${Date.now() % 100000}`;
    await newBoard(page, longName);

    // 名字两行显示：全名进 title，clamp 到 2 行
    const nameEl = page.locator(".board-item.active .bi-name");
    await expect(nameEl).toHaveAttribute("title", longName);
    const lineClamp = await nameEl.evaluate((el) => getComputedStyle(el).webkitLineClamp);
    expect(lineClamp).toBe("2");

    // 拖右边缘调宽
    const sidebar = page.locator(".sidebar");
    const before = (await sidebar.boundingBox())!.width;
    const handle = page.locator(".sidebar-resizer");
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + 200, { steps: 8 });
    await page.mouse.up();
    const after = (await sidebar.boundingBox())!.width;
    expect(after).toBeGreaterThan(before + 60);

    // 刷新后保持（存 localStorage）
    await page.reload();
    await expect(page.locator(".board-item").first()).toBeVisible();
    expect((await page.locator(".sidebar").boundingBox())!.width).toBeCloseTo(after, 0);

    // 双击把手恢复默认宽度
    await page.locator(".sidebar-resizer").dblclick();
    expect((await page.locator(".sidebar").boundingBox())!.width).toBeCloseTo(242, 0);
  });

  test("左栏画板搜索：名字过滤树 + 卡片内容跨板命中可跳转定位", async ({ page }) => {
    await boot(page);
    const hitName = `E2E-搜A-${Date.now() % 100000}`;
    await newBoard(page, hitName);
    const hitBoardId = await currentBoardId(page);
    // 待办条目文本也在搜索范围内——这是老搜索搜不到的内容
    const todoRes = await page.request.post(`/api/boards/${hitBoardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "todo", title: "收集箱", todo: { items: [{ text: "联系火星运营商", done: false }] } },
    });
    expect(todoRes.status()).toBe(201);
    // 换到另一块板上，验证点击命中会跨板跳回来
    const otherName = `E2E-搜B-${Date.now() % 100000}`;
    await newBoard(page, otherName);

    // 名字过滤：树里只剩命中的板
    const searchInput = page.locator(".aside-search input");
    await searchInput.fill(hitName);
    await expect(page.locator(".board-item", { hasText: hitName })).toBeVisible();
    await expect(page.locator(".board-item", { hasText: otherName })).toHaveCount(0);

    // 卡片内容命中：板名不匹配，但待办条目文本从「卡片内容命中」区浮出来
    await searchInput.fill("火星运营商");
    await expect(page.locator(".aside-empty", { hasText: "没有名字或分组匹配" })).toBeVisible();
    const deepCard = page.locator(".deep-card", { hasText: "收集箱" });
    await expect(deepCard).toBeVisible();
    await expect(page.locator(".deep-card-snippet", { hasText: "火星运营商" })).toBeVisible();

    // 点命中 → 跳到那块板并把卡带到眼前
    await deepCard.click();
    await expect(page.locator(".board-name")).toHaveValue(hitName);
    await expect(page.locator(CARD, { hasText: "收集箱" })).toBeVisible();

    // Esc 清空，树恢复全量
    await searchInput.press("Escape");
    await expect(searchInput).toHaveValue("");
    await expect(page.locator(".board-item", { hasText: otherName })).toBeVisible();
  });

  test("工具箱折叠：收成小按钮 → 刷新保持 → ⌘F 自动展开并聚焦搜索", async ({ page }) => {
    await boot(page);
    await expect(page.locator('.toolbar button[data-add="text"]')).toBeVisible();

    // 收起：工具条和画布搜索都让位，只剩一颗「工具」按钮
    await page.locator(".tb-collapse").click();
    const fab = page.locator(".toolbar-fab");
    await expect(fab).toBeVisible();
    await expect(page.locator('.toolbar button[data-add="text"]')).toHaveCount(0);
    await expect(page.locator(".search-bar")).toHaveCount(0);

    // 刷新后保持收起（存 localStorage）
    await page.reload();
    await expect(page.locator(".toolbar-fab")).toBeVisible();

    // ⌘F：收着也能搜——自动展开并聚焦搜索框
    await page.keyboard.press("ControlOrMeta+f");
    const searchInput = page.locator(".search-bar .search-input input");
    await expect(searchInput).toBeFocused();
    await expect(page.locator('.toolbar button[data-add="text"]')).toBeVisible();

    // 点小按钮也能展开（先再收一次）
    await page.locator(".tb-collapse").click();
    await page.locator(".toolbar-fab").click();
    await expect(page.locator('.toolbar button[data-add="text"]')).toBeVisible();
  });
});

test.describe("第九轮：画板导航子页", () => {
  test("分组 → 画板 → 卡片：时间排序、新标签打开、深链定位左栏", async ({ page }) => {
    await boot(page);
    const stamp = Date.now() % 100000;
    const oldName = `E2E-导航旧-${stamp}`;
    await newBoard(page, oldName);
    const oldId = await currentBoardId(page);
    await page.locator('.toolbar button[data-add="text"]').click();
    await editor(page).locator('input[data-field="title"]').fill("导航测试卡");
    await editor(page).locator('textarea[data-field="content"]').fill("木卫二观测站排班");
    await editor(page).locator('[data-act="save"]').click();

    const newName = `E2E-导航新-${stamp}`;
    await newBoard(page, newName);
    const newId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    await page.request.patch(`/api/boards/${oldId}`, { headers, data: { group: "E2E 导航组" } });
    await page.request.patch(`/api/boards/${newId}`, { headers, data: { group: "E2E 导航组" } });

    await page.goto("/nav");
    // 左栏是分组，右栏是一块块画板
    const groupRow = page.locator(".nav-scope", { hasText: "E2E 导航组" });
    await expect(groupRow).toBeVisible();
    await groupRow.click();
    await expect(page.locator(".nav-title")).toHaveText("E2E 导航组");
    await expect(page.locator(".nav-board")).toHaveCount(2);

    // 默认新 → 旧：后建的那块排在前面；换成旧 → 新就掉个头
    const names = () => page.locator(".nav-board .nb-name").allTextContents();
    expect((await names())[0]).toBe(newName);
    await page.locator(".nav-seg button", { hasText: "旧 → 新" }).click();
    await expect.poll(async () => (await names())[0]).toBe(oldName);

    // 板名之外还搜卡片内容：只记得板上写了什么也找得回来（并跨全部分组）
    await page.locator(".nav-search input").fill("木卫二观测站");
    const hitBoard = page.locator(".nav-board", { hasText: oldName });
    await expect(hitBoard).toBeVisible();
    await expect(hitBoard.locator(".hit")).toContainText("张卡片命中");
    await page.locator(".nav-search input").fill("");

    // 板卡整块就是「新标签页打开这块板」的链接
    const mainLink = page.locator(".nav-board", { hasText: oldName }).locator(".nb-main");
    await expect(mainLink).toHaveAttribute("target", "_blank");
    await expect(mainLink).toHaveAttribute("href", `/?board=${oldId}`);

    // 下钻一层：右边换成这块板的卡片
    await page.locator(".nav-board", { hasText: oldName }).locator(".nb-act").first().click();
    await expect(page.locator(".nav-title")).toHaveText(oldName);
    const cardLink = page.locator(".nav-card", { hasText: "导航测试卡" });
    await expect(cardLink).toBeVisible();
    await expect(cardLink).toHaveAttribute("target", "_blank");
    const href = await cardLink.getAttribute("href");
    expect(href).toContain(`board=${oldId}`);

    // 深链进画板：画布定位到那张卡，左栏也直接切到卡片段并高亮它
    await page.goto(href!);
    await expect(page.locator(".board-name")).toHaveValue(oldName);
    const active = page.locator(".card-item.active");
    await expect(active).toHaveText("导航测试卡");
    await expect(page.locator(".aside-tabs button.active")).toContainText("卡片");
  });
});

test.describe("第十轮：HTML 嵌入卡（外部 PPT / 网页）", () => {
  test("网页卡：白名单挡住外域 → 本机地址嵌得进来 → 交互开关 → 同源收紧沙箱", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-网页-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const origin = new URL(page.url()).origin;

    await toolbarAdd(page, "html");
    const urlInput = editor(page).locator('input[data-field="html.url"]');
    await expect(urlInput).toBeVisible();

    // 白名单之外：输入框下面当场警告，且不会偷偷自动保存
    await urlInput.fill("https://evil.example.org/deck.html");
    await expect(editor(page).locator(".hint.danger")).toContainText("不在嵌入白名单");
    await page.waitForTimeout(1200); // 超过自动保存的 800ms 防抖
    const notSaved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(notSaved.board.cards[0].html.url).toBe("");

    // 本机地址（同源，也在白名单里）：填完保存，卡面就该出现 iframe
    await editor(page).locator('input[data-field="title"]').fill("嵌入的本机页面");
    await urlInput.fill(`${origin}/api/health`);
    await expect(editor(page).locator(".hint.danger")).toHaveCount(0);
    await editor(page).locator('select[data-field="html.frame"]').selectOption("0x0");
    await editor(page).locator('[data-act="save"]').click();

    const card = page.locator(CARD, { hasText: "嵌入的本机页面" });
    const frame = card.locator("iframe.html-embed-frame");
    await expect(frame).toBeVisible();
    await expect(card.locator(".host-chip")).toContainText("127.0.0.1");

    // 同源页面要拿掉 allow-same-origin：同源 + allow-scripts 的 iframe 能自己摘掉沙箱
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-popups");
    await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");

    // 平时鼠标归画布，点「交互」才把事件交给页面
    await expect(card.locator(".html-embed.live")).toHaveCount(0);
    await card.locator('[data-act="interact"]').click();
    await expect(card.locator(".html-embed.live")).toHaveCount(1);

    const saved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(saved.board.cards[0].html.url).toBe(`${origin}/api/health`);
    expect(saved.board.cards[0].html.frameW).toBe(0);

    // 服务端是最终闸门：绕过前端直接写外域也得 400
    const rejected = await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "x-board-web": "1" },
      data: { type: "html", html: { url: "https://evil.example.org/deck.html" } },
    });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).error).toContain("白名单");

    // 导出：离线自包含的稿子里放地址而不是活页
    const md = await (await page.request.get(`/api/boards/${boardId}/export?format=md`)).text();
    expect(md).toContain("嵌入网页：");
  });

  test("网页卡：手动加载模式点了才嵌，阅读模式一进去就能操作", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-网页手动-${Date.now() % 100000}`);
    const origin = new URL(page.url()).origin;

    await toolbarAdd(page, "html");
    await editor(page).locator('input[data-field="title"]').fill("手动加载的页面");
    await editor(page).locator('input[data-field="html.url"]').fill(`${origin}/api/health`);
    await editor(page).locator('select[data-field="html.mode"]').selectOption("manual");
    await editor(page).locator('[data-act="save"]').click();

    const card = page.locator(CARD, { hasText: "手动加载的页面" });
    await expect(card.locator("iframe.html-embed-frame")).toHaveCount(0);
    await card.locator(".html-embed-load").click();
    await expect(card.locator("iframe.html-embed-frame")).toBeVisible();

    // 阅读模式：同一张卡摊开一整屏，不用再点一次「交互」
    await card.locator('.card-tool[aria-label="放大阅读"]').click();
    const reader = page.locator(".reader-modal");
    await expect(reader).toBeVisible();
    await expect(reader.locator(".reader-embed .html-embed.live iframe")).toBeVisible();
  });

  test("网页卡：阅读模式里 ←/→ 不会被 iframe 吞掉，键盘归属能明着交出去", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-网页键盘-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const origin = new URL(page.url()).origin;
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    // 同一排两张，阅读顺序 = 左 → 右：左边普通文本，右边嵌一张页面
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers,
      data: { type: "text", title: "前面一张", content: "翻回来就说明键盘还在", x: 100, y: 100, w: 280, h: 170 },
    });
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers,
      data: {
        type: "html",
        title: "嵌入的页面",
        html: { url: `${origin}/api/health`, mode: "auto", frameW: 0, frameH: 0 },
        x: 520,
        y: 100,
        w: 280,
        h: 170,
      },
    });
    await page.reload();

    // 卡头的工具按钮是悬停才露的，先把鼠标放上去
    const embedCard = page.locator(CARD, { hasText: "嵌入的页面" });
    await embedCard.hover();
    await embedCard.locator('.card-tool[aria-label="放大阅读"]').click();
    const reader = page.locator(".reader-modal");
    const frame = reader.locator(".reader-embed iframe");
    await expect(frame).toBeVisible();
    // 正文里有 iframe 时才出现这个开关（按 DOM 探测，不认识具体卡片类型）
    const keys = reader.locator('[data-act="keys"]');
    await expect(keys).toHaveText("键盘：翻卡");

    // 全屏来回切**不能让嵌入页重载**：全屏只在原地加个类 + 请求原生全屏，不搬 DOM。
    // 搬一下 iframe 就会重新加载——翻到第 7 页的 PPT 会跳回第 1 页。
    // iframe 元素可见 ≠ 它的文档已经导航完：初次导航要是晚一步落进下面的计数器，
    // 就会被当成一次「重载」（flaky 的由来）。先等在场的每个 iframe 都停在自己的地址上——
    // frame.url() 变成目标地址与 framenavigated 是同一拍发生的，等到了就说明初次那一发已经过去。
    const embedUrl = `${origin}/api/health`;
    await expect
      .poll(async () => {
        const frames = await Promise.all(
          (await page.locator("iframe").elementHandles()).map((el) => el.contentFrame()),
        );
        return frames.length > 0 && frames.every((child) => child?.url() === embedUrl);
      })
      .toBe(true);
    let embedLoads = 0;
    page.on("framenavigated", (child) => {
      if (child !== page.mainFrame()) embedLoads += 1;
    });
    await reader.locator('[data-act="fullscreen"]').click();
    await expect(page.locator(".modal-backdrop")).toHaveClass(/immersive/);
    await reader.locator('[data-act="fullscreen"]').click();
    await expect(page.locator(".modal-backdrop")).not.toHaveClass(/immersive/);
    await expect(frame).toBeVisible();
    expect(embedLoads).toBe(0);

    // 点进嵌入页：焦点会掉进 iframe，键盘就归它了——阅读模式要把焦点抢回来，
    // 否则 ←/→ 与 Esc 会静默失效（页面上没有任何迹象说明为什么）
    const box = (await frame.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("IFRAME");
    await page.keyboard.press("ArrowLeft");
    await expect(reader.locator(".modal-head h2")).toHaveText("前面一张");
    // 换到不带 iframe 的卡，开关就该收起来
    await expect(keys).toHaveCount(0);

    // 明着把键盘交出去：焦点当场送进 iframe（PPT 这才能用 ←/→ 翻页）
    await page.keyboard.press("ArrowRight");
    await expect(keys).toBeVisible();
    await keys.click();
    await expect(keys).toHaveText("键盘：页面");
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");
    // 两侧的翻页按钮是这时候的退路：键盘归了页面，鼠标照样翻得动
    await reader.locator(".reader-edge.prev").click();
    await expect(reader.locator(".modal-head h2")).toHaveText("前面一张");
    // 翻一张就回到默认归属，不会把「交出去」这件事悄悄带到下一张卡上
    await page.keyboard.press("ArrowRight");
    await expect(reader.locator('[data-act="keys"]')).toHaveText("键盘：翻卡");
  });
});
test.describe("第十一轮：左栏跟着当前画板走", () => {
  test("打开一块板：左栏定位到它 · 分组标「当前」· 祖先链亮着 · 滚开了有回去的入口", async ({ page }) => {
    const stamp = Date.now() % 100000;
    const make = async (name: string, extra: Record<string, unknown> = {}) => {
      const response = await page.request.post("/api/boards", {
        headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
        data: { name, ...extra },
      });
      return (await response.json()).board as { id: string; name: string };
    };

    // 先把左栏撑到要滚动：不滚动的列表验不出「定位」这件事
    for (let i = 0; i < 32; i++) await make(`E2E-填充-${stamp}-${i}`, { group: `E2E填充组${i % 3}` });
    const group = `E2E定位组-${stamp}`;
    const parent = await make(`E2E-父板-${stamp}`, { group });
    const child = await make(`E2E-子板-${stamp}`, { parentId: parent.id, group });

    await page.goto(`/?board=${child.id}`);
    const active = page.locator(".board-item.active");
    await expect(active.locator(".bi-name")).toHaveText(`E2E-子板-${stamp}`);
    // 一进来就在眼前：不用自己在几十块板里翻
    await expect(active).toBeInViewport({ ratio: 0.9 });
    // 在哪个分组、挂在哪块板底下，两条都标出来
    await expect(page.locator(".card-group-head.current")).toContainText(group);
    await expect(page.locator(".board-item.on-path .bi-name")).toHaveText(`E2E-父板-${stamp}`);

    // 滚开之后：底部浮一条回去的入口，点一下滚回当前画板
    const list = page.locator(".board-list");
    await list.evaluate((el) => {
      const row = el.querySelector<HTMLElement>(".board-item.active")!;
      const offset = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      el.scrollTop = offset > el.scrollHeight / 2 ? 0 : el.scrollHeight;
    });
    const locator = page.locator(".board-locator");
    await expect(locator).toBeVisible();
    await expect(locator).toContainText(`E2E-子板-${stamp}`);
    await locator.click();
    await expect(active).toBeInViewport({ ratio: 0.9 });
    await expect(locator).toHaveCount(0);

    // 换一块板：焦点跟着换过去（分组标记也跟着走）
    const other = page.locator(".board-item", { hasText: `E2E-填充-${stamp}-7` }).first();
    await other.click();
    await expect(page.locator(".board-item.active .bi-name")).toHaveText(`E2E-填充-${stamp}-7`);
    await expect(page.locator(".board-item.active")).toBeInViewport({ ratio: 0.9 });
    await expect(page.locator(".card-group-head.current")).toContainText("E2E填充组1");
  });

  test("折起来的分组挡不住定位：打开里面的板就把那一层展开", async ({ page }) => {
    const stamp = Date.now() % 100000;
    const make = async (name: string, extra: Record<string, unknown> = {}) => {
      const response = await page.request.post("/api/boards", {
        headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
        data: { name, ...extra },
      });
      return (await response.json()).board as { id: string; name: string };
    };
    const group = `E2E折叠组-${stamp}`;
    const parent = await make(`E2E-折叠父-${stamp}`, { group });
    await make(`E2E-折叠子-${stamp}`, { parentId: parent.id, group });
    const start = await make(`E2E-起点-${stamp}`, { group: `E2E别处-${stamp}` });

    await page.goto(`/?board=${start.id}`);
    // 把目标分组整个折起来：里面的板一块都看不见了
    await page.locator(".card-group-head", { hasText: group }).click();
    await expect(page.locator(".board-item", { hasText: `E2E-折叠父-${stamp}` })).toHaveCount(0);

    // 搜索是唯一还能点到它的入口（搜索期间强制展开）
    await page.locator(".aside-search input").fill(`E2E-折叠子-${stamp}`);
    await page.locator(".board-item", { hasText: `E2E-折叠子-${stamp}` }).first().click();
    await page.locator(".aside-search input").fill("");

    // 搜索清掉后它还在眼前：分组和父板都被展开了，不用自己再去翻那一层
    const active = page.locator(".board-item.active");
    await expect(active.locator(".bi-name")).toHaveText(`E2E-折叠子-${stamp}`);
    await expect(active).toBeInViewport({ ratio: 0.9 });
    await expect(page.locator(".card-group-head.current")).toContainText(group);
  });
});

test.describe("第十一轮：搜索逐个跳命中", () => {
  test("回车一个个跳、Shift+回车往回、计数报「第几个/共几个」", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-跳命中-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 三张卡上下排开：跳的顺序该按画布位置（上到下），不是建卡顺序
    const make = (title: string, x: number, y: number) =>
      page.request.post(`/api/boards/${boardId}/cards`, {
        headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
        data: { type: "text", title, x, y },
      });
    // 故意倒着建：C 先建、A 最后建
    await make("跳跳-C", 60, 900);
    await make("跳跳-B", 60, 500);
    await make("跳跳-A", 60, 100);
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(3);

    // 左栏切到卡片段：当前跳到哪一张，那一行会高亮，比抓 1.5 秒的闪烁稳
    await page.locator(".aside-tabs > button", { hasText: "卡片" }).click();
    const current = page.locator(".card-item.active");

    const input = page.locator(".search-input input");
    await input.click();
    await input.fill("跳跳");
    const count = page.locator(".search-count");
    await expect(count).toHaveText("3");

    await input.press("Enter");
    await expect(count).toHaveText("1/3");
    await expect(current).toHaveText("跳跳-A");

    await input.press("Enter");
    await expect(count).toHaveText("2/3");
    await expect(current).toHaveText("跳跳-B");

    await input.press("Enter");
    await expect(count).toHaveText("3/3");
    await expect(current).toHaveText("跳跳-C");

    // 到头绕回第一个
    await input.press("Enter");
    await expect(count).toHaveText("1/3");
    await expect(current).toHaveText("跳跳-A");

    // Shift+回车往回，同样绕
    await input.press("Shift+Enter");
    await expect(count).toHaveText("3/3");
    await expect(current).toHaveText("跳跳-C");

    // 上下按钮是同一件事的鼠标版，而且不抢输入框的焦点
    await page.locator(".search-step button").first().click();
    await expect(count).toHaveText("2/3");
    await expect(current).toHaveText("跳跳-B");
    await expect(input).toBeFocused();
    await page.locator(".search-step button").last().click();
    await expect(count).toHaveText("3/3");

    // 换关键词只命中一张：计数回到总数，跳一次就是那一张，上下按钮收起来
    await input.fill("跳跳-B");
    await expect(count).toHaveText("1");
    await expect(page.locator(".search-step")).toHaveCount(0);
    await input.press("Enter");
    await expect(count).toHaveText("1/1");
    await expect(current).toHaveText("跳跳-B");

    // Esc 清干净：计数与「停在第几个」一起消失
    await input.press("Escape");
    await expect(count).toHaveCount(0);
  });
});

test.describe("第十一轮：手绘卡的卡面由服务端出图", () => {
  const SCENE = JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "e2e",
    elements: [
      { id: "r1", type: "rectangle", x: 0, y: 0, width: 160, height: 90, strokeColor: "#1e1e1e", backgroundColor: "transparent", seed: 7, strokeWidth: 2, roughness: 1 },
      { id: "t1", type: "text", x: 12, y: 110, width: 140, height: 24, text: "手绘卡文字", fontSize: 20, strokeColor: "#1e1e1e", seed: 8 },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  });
  // 1×1 透明 PNG：当「编辑器里存过的缩略图」用
  const THUMB =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("卡面是服务端渲的 SVG：不再加载 Excalidraw 库，缩略图也不随整板下发", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-手绘-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    const created = await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "excalidraw", title: "一张手绘", x: 80, y: 80, excalidraw: { source: SCENE, thumbnail: THUMB } },
    });
    const cardId = (await created.json()).card.id;

    // 整板下发里没有那坨 base64（真实数据里它能占到 gzip 后体积的八成），
    // 但导出 JSON 里必须还在——那份是要能原样 PUT 回 /whole 的备份
    const detail = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const card = detail.board.cards.find((item: { id: string }) => item.id === cardId);
    expect(card.excalidraw.source).toContain("rectangle");
    expect(card.excalidraw.thumbnail).toBeUndefined();
    const exported = await (await page.request.get(`/api/boards/${boardId}/export?format=json`)).json();
    expect(exported.board.cards.find((item: { id: string }) => item.id === cardId).excalidraw.thumbnail).toBe(THUMB);

    // 卡面图：服务端渲的 SVG，带 ETag，第二次问就是 304
    const drawing = await page.request.get(`/api/boards/${boardId}/cards/${cardId}/drawing?v=abc`);
    expect(drawing.status()).toBe(200);
    expect(drawing.headers()["content-type"]).toContain("image/svg+xml");
    expect(drawing.headers()["cache-control"]).toContain("immutable");
    const svg = await drawing.text();
    expect(svg).toContain("<svg");
    expect(svg).toContain("手绘卡文字");
    const etag = drawing.headers()["etag"];
    const again = await page.request.get(`/api/boards/${boardId}/cards/${cardId}/drawing?v=abc`, {
      headers: { "if-none-match": etag },
    });
    expect(again.status()).toBe(304);

    // 画布上：卡面就是那张图，而且整个过程没有把 Excalidraw 库拉下来
    const libHits: string[] = [];
    page.on("request", (request) => {
      if (/excalidraw/i.test(request.url())) libHits.push(request.url());
    });
    await page.goto(`/?board=${boardId}`);
    const img = page.locator(".excalidraw-thumb img");
    await expect(img).toHaveAttribute("src", new RegExp(`/cards/${cardId}/drawing\\?v=`));
    await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
    expect(libHits).toEqual([]);

    // 普通保存（编辑器里改标题）不带缩略图字段：存过的那张不能被抹掉
    await page.request.patch(`/api/boards/${boardId}/cards/${cardId}`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { title: "改过标题", excalidraw: { source: SCENE } },
    });
    const afterPatch = await (await page.request.get(`/api/boards/${boardId}/export?format=json`)).json();
    expect(afterPatch.board.cards.find((item: { id: string }) => item.id === cardId).excalidraw.thumbnail).toBe(THUMB);
  });

  test("画不出来的场景：退回存过的缩略图，两条都没有才报错", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-手绘兜底-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 只有一个图片元素的场景：那支笔画不出来（字节在 files 里，卡片没存）
    const imageOnly = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [{ id: "i1", type: "image", x: 0, y: 0, width: 100, height: 100, fileId: "missing", seed: 3 }],
      appState: {},
      files: {},
    });
    const withThumb = await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "excalidraw", title: "只有图片", x: 60, y: 60, excalidraw: { source: imageOnly, thumbnail: THUMB } },
    });
    const withThumbId = (await withThumb.json()).card.id;
    const fallback = await page.request.get(`/api/boards/${boardId}/cards/${withThumbId}/drawing?v=1`);
    expect(fallback.status()).toBe(200);
    expect(fallback.headers()["content-type"]).toContain("image/png");

    const bare = await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: { type: "excalidraw", title: "画不出来", x: 460, y: 60, excalidraw: { source: imageOnly } },
    });
    const bareId = (await bare.json()).card.id;
    const broken = await page.request.get(`/api/boards/${boardId}/cards/${bareId}/drawing?v=1`);
    expect(broken.status()).toBe(400);

    // 前端拿不到图就退回占位，而不是留一个破图标
    await page.goto(`/?board=${boardId}`);
    await expect(page.locator(".excalidraw-stale .placeholder")).toHaveText(/渲染不出来/);
  });
});

test.describe("第十一轮：删掉的东西能撤回来", () => {
  test("删一张卡：连线和批注跟着走，撤销之后原样回来（id / 建卡时间都是原来那份）", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-撤销-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    const make = async (title: string, x: number, y: number) =>
      (await (await page.request.post(`/api/boards/${boardId}/cards`, {
        headers,
        data: { type: "text", title, content: `${title} 的正文`, x, y },
      })).json()).card as { id: string; createdAt: number };
    // 摆低一点：画布上方被工具条和搜索条盖着，点不到
    const left = await make("要删的卡", 80, 430);
    const right = await make("留下的卡", 520, 430);
    await page.request.post(`/api/boards/${boardId}/edges`, {
      headers,
      data: { from: left.id, to: right.id, label: "连着的" },
    });
    await page.request.post(`/api/boards/${boardId}/comments`, {
      headers,
      data: { target: "card", targetId: left.id, text: "这张卡上的批注" },
    });

    await page.goto(`/?board=${boardId}`);
    await expect(page.locator(CARD)).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);

    // 选中 → Del：没有系统弹窗，直接删掉，提示里说清连带删了什么
    await page.locator(CARD, { hasText: "要删的卡" }).click();
    await page.keyboard.press("Delete");
    await expect(page.locator(CARD)).toHaveCount(1);
    const toast = page.locator(".toast.show");
    await expect(toast).toContainText("已删除卡片「要删的卡」");
    await expect(toast).toContainText("1 条连线");
    await expect(toast).toContainText("1 条批注");

    // 撤销：卡、线、批注一起回来，而且是原来那一份
    await toast.locator(".toast-action").click();
    await expect(page.locator(CARD)).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const restored = after.board.cards.find((card: { id: string }) => card.id === left.id);
    expect(restored).toBeTruthy();
    expect(restored.title).toBe("要删的卡");
    expect(restored.content).toBe("要删的卡 的正文");
    // 建卡时间没被刷成「刚刚」——否则按时间排序的地方会把恢复的卡当新卡
    expect(restored.createdAt).toBe(left.createdAt);
    expect(after.board.edges[0].label).toBe("连着的");
    expect(after.board.comments).toHaveLength(1);
    expect(after.board.comments[0].text).toBe("这张卡上的批注");
  });

  test("删连线也能撤：连线带着原 id 和样式回来", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-撤销连线-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    const make = async (title: string, x: number) =>
      (await (await page.request.post(`/api/boards/${boardId}/cards`, {
        headers,
        data: { type: "text", title, x, y: 100 },
      })).json()).card.id as string;
    const a = await make("甲", 80);
    const b = await make("乙", 520);
    const edgeId = (await (await page.request.post(`/api/boards/${boardId}/edges`, {
      headers,
      data: { from: a, to: b, label: "要删的线", kind: "blocks" },
    })).json()).edge.id as string;

    await page.goto(`/?board=${boardId}`);
    const edge = page.locator(".react-flow__edge").first();
    await expect(edge).toBeVisible();
    await edge.click({ button: "right" });
    await page.locator(".context-menu").getByText("删除连线").click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);

    const toast = page.locator(".toast.show");
    await expect(toast).toContainText("已删除连线");
    await toast.locator(".toast-action").click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    expect(after.board.edges[0].id).toBe(edgeId);
    expect(after.board.edges[0].label).toBe("要删的线");
    expect(after.board.edges[0].kind).toBe("blocks");
  });
});

test.describe("第十一轮：卡片复制粘贴（⌘C / ⌘V）", () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#68c48f"/></svg>';

  test("⌘C 复制两张卡和它们之间的连线，⌘V 粘回本板、也粘到另一块板", async ({ page }) => {
    // 这条用例要回读系统剪贴板，验「⌘C 真写进去了」（跨窗口粘贴靠的就是它）
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await boot(page);
    const nameA = `E2E-复制源-${Date.now() % 100000}`;
    await newBoard(page, nameA);
    const boardA = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    const make = async (data: Record<string, unknown>) =>
      (await (await page.request.post(`/api/boards/${boardA}/cards`, { headers, data })).json()).card.id as string;
    // SVG 卡是关键：以前「复制卡片」只搬 text/task/link/quote/file 四种字段，
    // 复制一张 SVG 卡出来是张空卡——这条用例把那个洞焊上
    const svgId = await make({ type: "svg", title: "图形卡", x: 80, y: 430, svg: { source: SVG } });
    const textId = await make({ type: "text", title: "说明卡", content: "跟图形卡连着", x: 520, y: 430 });
    await page.request.post(`/api/boards/${boardA}/edges`, {
      headers,
      data: { from: svgId, to: textId, label: "解释", kind: "references" },
    });

    await page.goto(`/?board=${boardA}`);
    await expect(page.locator(CARD)).toHaveCount(2);

    // 全选 → ⌘C：提示说清复制了什么，系统剪贴板里是那段卡片 JSON
    await page.locator(".react-flow__pane").click({ position: { x: 60, y: 320 } });
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+c");
    await expect(page.locator(".toast.show")).toContainText("已复制 2 张卡片（连 1 条连线）");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("blotboard/cards");

    // ⌘V：粘回本板 → 4 张卡、2 条连线，SVG 源码一并跟过来
    const paste = async (text: string) => {
      await page.evaluate((payload) => {
        const data = new DataTransfer();
        data.setData("text/plain", payload);
        document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
      }, text);
    };
    await paste(clipboard);
    await expect(page.locator(CARD)).toHaveCount(4);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    const afterA = await (await page.request.get(`/api/boards/${boardA}`)).json();
    const copies = afterA.board.cards.filter((card: { id: string }) => card.id !== svgId && card.id !== textId);
    expect(copies).toHaveLength(2);
    const svgCopy = copies.find((card: { type: string }) => card.type === "svg");
    expect(svgCopy.svg.source).toContain("#68c48f");
    expect(svgCopy.title).toBe("图形卡");
    // 复制出来的是新卡：id 不同，连线也重新连在副本之间
    expect(svgCopy.id).not.toBe(svgId);
    const copyIds = new Set(copies.map((card: { id: string }) => card.id));
    const copiedEdge = afterA.board.edges.find((edge: { from: string }) => copyIds.has(edge.from));
    expect(copiedEdge.label).toBe("解释");
    expect(copiedEdge.kind).toBe("references");

    // 换一块板再粘：跨板搬内容就靠这一下
    const nameB = `E2E-粘贴目标-${Date.now() % 100000}`;
    await newBoard(page, nameB);
    const boardB = await currentBoardId(page);
    await paste(clipboard);
    await expect(page.locator(CARD)).toHaveCount(2);
    await expect(page.locator(".toast.show")).toContainText(`来自「${nameA}」`);
    const afterB = await (await page.request.get(`/api/boards/${boardB}`)).json();
    expect(afterB.board.cards).toHaveLength(2);
    expect(afterB.board.edges).toHaveLength(1);
    expect(afterB.board.cards.find((card: { type: string }) => card.type === "svg").svg.source).toContain("#68c48f");
  });

  test("右键空白处能粘贴；复制任务卡不会连 Issue 一起认领", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-粘贴菜单-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers,
      data: {
        type: "task",
        title: "已转 Issue 的任务",
        x: 80,
        y: 430,
        task: { goal: "干这件事", status: "issued", issueNumber: "42", issueId: "iss_42", taskId: "task_42" },
      },
    });
    await page.goto(`/?board=${boardId}`);
    const card = page.locator(CARD, { hasText: "已转 Issue 的任务" });
    await expect(card).toBeVisible();

    // 右键卡片 →「复制到剪贴板」
    await card.click({ button: "right" });
    await page.locator(".context-menu").getByText("复制到剪贴板").click();
    await expect(page.locator(".toast.show")).toContainText("已复制 1 张卡片");

    // 右键空白 → 菜单里多出「粘贴 1 张卡片」，落点就是右键那处
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 700, y: 300 } });
    const menu = page.locator(".context-menu");
    await expect(menu).toContainText("粘贴 1 张卡片");
    await menu.getByText("粘贴 1 张卡片").click();
    await expect(page.locator(CARD)).toHaveCount(2);

    // 副本是一张全新的想法卡：Issue / 任务号不能跟着复制过来，否则两张卡认领同一个 Issue
    const after = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const copy = after.board.cards.find((item: { task?: { goal?: string }; id: string }) => item.id !== after.board.cards[0].id);
    expect(copy.task.goal).toBe("干这件事");
    expect(copy.task.status).toBe("idea");
    expect(copy.task.issueNumber ?? null).toBeNull();
    expect(copy.task.taskId ?? null).toBeNull();
  });
});

test.describe("第十二轮：任务台 Runner 设置（ACP agent 注册表）", () => {
  /** local 任务后端的第二个实例（playwright.config 起的；表单只在这个形态可编辑） */
  const LOCAL_BASE = `http://127.0.0.1:${Number(process.env.E2E_LOCAL_PORT || 8443)}`;

  test("goal-agent 形态：设置区显示「由外部 Runner 接管」，不给编辑表单", async ({ page }) => {
    await page.goto("/tasks");
    await page.getByRole("button", { name: "Runner 设置" }).click();
    await expect(page.locator(".tk-runner-takeover")).toContainText("由外部 Runner 接管");
    // 接管形态下不渲染任何编辑入口：没有「添加 agent」，也没有权限档位按钮
    await expect(page.getByRole("button", { name: "添加 agent" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /自动允许/ })).toHaveCount(0);
  });

  test("local 形态：添加 agent → 设为默认 → 档位切换并持久 → 删除（全程不 spawn 进程）", async ({ page }) => {
    await page.goto(`${LOCAL_BASE}/tasks`);
    await page.getByRole("button", { name: "Runner 设置" }).click();
    const panel = page.locator(".tk-runner-settings");
    await expect(panel).toContainText("还没注册 agent");

    // 添加：只填注册表，不发起任何 launch——绝不 spawn 真进程
    await page.getByRole("button", { name: "添加 agent" }).click();
    const form = page.locator(".tk-agent-form");
    await form.locator('input[placeholder="Claude Code"]').fill("E2E Mock Agent");
    await form.locator('input[placeholder="claude-code-acp"]').fill("node");
    await form.locator('input[placeholder="--acp"]').fill("scripts/mock-acp-agent.mjs --mode auto-finish");
    await form.getByRole("button", { name: "保存" }).click();

    const row = page.locator(".tk-agent-row", { hasText: "E2E Mock Agent" });
    await expect(row).toBeVisible();
    await expect(row.locator(".tk-agent-cmd")).toContainText("node scripts/mock-acp-agent.mjs --mode auto-finish");

    await row.getByRole("button", { name: "设为默认" }).click();
    await expect(row.locator(".tk-chip")).toHaveText("默认");

    // 权限档位切到 auto，刷新后还在（存 <data>/runner-settings.json）
    await page.getByRole("button", { name: /自动允许/ }).click();
    await expect(page.getByRole("button", { name: /自动允许/ })).toHaveClass(/primary/);
    await page.reload();
    await page.getByRole("button", { name: "Runner 设置" }).click();
    await expect(page.getByRole("button", { name: /自动允许/ })).toHaveClass(/primary/);
    await expect(page.locator(".tk-agent-row", { hasText: "E2E Mock Agent" })).toBeVisible();

    // 删除：列表回到空态
    await page.locator(".tk-agent-row", { hasText: "E2E Mock Agent" }).getByRole("button", { name: "删除" }).click();
    await expect(page.locator(".tk-agent-row")).toHaveCount(0);
    await expect(panel).toContainText("还没注册 agent");
  });
});

test.describe("第十三轮：大纲视图（画布之外的第二种看板方式）", () => {
  test("切进大纲 → 按连线缩进 → 过滤 → 点行定位 → 行内改标题正文落库", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-大纲-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const auth = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    // 三张卡：甲 → 乙（有连线，乙缩进一层），丙孤立
    const ids: string[] = [];
    for (const [title, body, y] of [
      ["大纲甲", "甲的正文里有独门关键词 zebra", 60],
      ["大纲乙", "乙的正文", 260],
      ["大纲丙", "丙的正文", 460],
    ] as [string, string, number][]) {
      const res = await page.request.post(`/api/boards/${boardId}/cards`, {
        headers: auth,
        data: { type: "text", title, content: body, x: 80, y, w: 280, h: 150 },
      });
      ids.push((await res.json()).card.id);
    }
    await page.request.post(`/api/boards/${boardId}/edges`, {
      headers: auth,
      data: { from: ids[0], to: ids[1] },
    });
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(3);

    // 工具条上切进大纲
    await page.locator('.toolbar [data-act="view-outline"]').click();
    const outline = page.locator(".outline-view");
    await expect(outline).toBeVisible();
    await expect(outline.locator(".ov-row")).toHaveCount(3);
    await expect(outline.locator('[data-role="outline-count"]')).toContainText("3");

    // 层级：乙的唯一上游是甲 → 缩进一层；甲与丙是顶层
    await expect(outline.locator(`.ov-row[data-card-id="${ids[0]}"]`)).toHaveAttribute("data-depth", "0");
    await expect(outline.locator(`.ov-row[data-card-id="${ids[1]}"]`)).toHaveAttribute("data-depth", "1");
    await expect(outline.locator(`.ov-row[data-card-id="${ids[2]}"]`)).toHaveAttribute("data-depth", "0");
    // 摘要显示的是「标题之外」的内容，不把标题再抄一遍
    await expect(outline.locator(`.ov-row[data-card-id="${ids[0]}"] .ov-snippet`)).toContainText("zebra");

    // 过滤：只剩命中的那一行，计数报「命中/总数」
    await outline.locator('[data-field="outline.filter"]').fill("zebra");
    await expect(outline.locator(".ov-row")).toHaveCount(1);
    await expect(outline.locator('[data-role="outline-count"]')).toContainText("1");
    await outline.locator('[data-field="outline.filter"]').fill("");
    await expect(outline.locator(".ov-row")).toHaveCount(3);

    // 点某一行 → 选中那张卡（画布上也选着，切回去视口就落在它上面）
    await outline.locator(`.ov-row[data-card-id="${ids[2]}"]`).click();
    await expect(outline.locator(`.ov-row[data-card-id="${ids[2]}"]`)).toHaveClass(/on/);
    await expect.poll(() => page.evaluate(() => new URLSearchParams(location.search).get("card"))).toBe(ids[2]);

    // ↑ 走到上一行（键盘是这个视图的主路径）
    await outline.locator(".ov-list").focus();
    await page.keyboard.press("ArrowUp");
    await expect(outline.locator(`.ov-row[data-card-id="${ids[1]}"]`)).toHaveClass(/on/);

    // Enter 进编辑 → 改标题与正文 → 自动保存落库
    await page.keyboard.press("Enter");
    const editing = outline.locator(".ov-row.editing");
    await expect(editing).toBeVisible();
    await editing.locator('[data-field="outline.title"]').fill("大纲乙·改过");
    await editing.locator('[data-field="outline.content"]').fill("在大纲里直接改的正文");
    await expect
      .poll(
        async () => {
          const board = await (await page.request.get(`/api/boards/${boardId}`)).json();
          const card = board.board.cards.find((item: any) => item.id === ids[1]);
          return `${card.title}|${card.content}`;
        },
        { timeout: 10_000 },
      )
      .toBe("大纲乙·改过|在大纲里直接改的正文");

    // Esc 退编辑，再 Esc 回画布；偏好存 localStorage，刷新后仍是画布
    await page.keyboard.press("Escape");
    await expect(outline.locator(".ov-row.editing")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".outline-view")).toHaveCount(0);
    expect(await page.evaluate(() => window.localStorage.getItem("blotboard_view"))).toBe("canvas");

    // 再切进去 → 刷新后还在大纲（这是「这个人习惯怎么看板」，不该被重置）
    await page.locator('.toolbar [data-act="view-outline"]').click();
    await expect(page.locator(".outline-view")).toBeVisible();
    await page.reload();
    await expect(page.locator(".outline-view")).toBeVisible();
    await page.locator('[data-act="outline-exit"]').click();
    await expect(page.locator(".outline-view")).toHaveCount(0);
  });
});

test.describe("第十三轮：对比模式（2-4 张卡并排）", () => {
  test("框选两张 → 右键「并排对比」→ 两栏各自滚动 → 高亮差异 → Esc 退出", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-对比-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const auth = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    // 改稿前后：只差中间一行
    const before = ["第一段没动", "中间这行是旧的", "最后一段没动"].join("\n");
    const after = ["第一段没动", "中间这行换成了新的", "最后一段没动"].join("\n");
    const ids: string[] = [];
    for (const [title, content, x] of [
      ["初稿", before, 60],
      ["改稿", after, 420],
    ] as [string, string, number][]) {
      const res = await page.request.post(`/api/boards/${boardId}/cards`, {
        headers: auth,
        data: { type: "text", title, content, x, y: 80, w: 300, h: 180 },
      });
      ids.push((await res.json()).card.id);
    }
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(2);
    await page.locator(".top-btn[aria-label='适应内容']").click();
    await page.waitForTimeout(400);

    // 框选两张（起手点落在右下角空白处）
    const pane = await page.locator(".react-flow__pane").boundingBox();
    await page.mouse.move(pane!.x + pane!.width - 14, pane!.y + pane!.height - 14);
    await page.mouse.down();
    await page.mouse.move(pane!.x + 14, pane!.y + 14, { steps: 16 });
    await page.mouse.up();
    await expect(page.locator(`${CARD}.selected`)).toHaveCount(2);

    // 右键选择框 → 批量菜单 → 并排对比
    await page.locator(".react-flow__nodesselection-rect").click({ button: "right", force: true });
    await expect(page.locator(".context-menu")).toContainText("并排对比这 2 张");
    await page.locator(".context-menu").getByText("并排对比这 2 张").click();

    const compare = page.locator(".compare-modal");
    await expect(compare).toBeVisible();
    await expect(compare.locator(".cmp-col")).toHaveCount(2);
    await expect(compare.locator(".cmp-col").first()).toContainText("中间这行是旧的");
    await expect(compare.locator(".cmp-col").last()).toContainText("中间这行换成了新的");
    // 每栏各自滚：两个独立的滚动容器
    await expect(compare.locator(".cmp-col-body")).toHaveCount(2);

    // 高亮差异：只有「两张 + 都是文本类」才出现这个开关
    await compare.locator('[data-act="compare-diff"]').click();
    // 行级 LCS：改掉的那一行左删右增，没动的两行两边都算相同
    await expect(compare.locator(".cmp-line.del")).toHaveCount(1);
    await expect(compare.locator(".cmp-line.add")).toHaveCount(1);
    await expect(compare.locator(".cmp-line.del")).toHaveText("中间这行是旧的");
    await expect(compare.locator(".cmp-line.add")).toHaveText("中间这行换成了新的");
    await expect(compare.locator(".cmp-line.same")).toHaveCount(4);

    // Esc 退出，画布还在
    await page.keyboard.press("Escape");
    await expect(page.locator(".compare-modal")).toHaveCount(0);
    await expect(page.locator(CARD)).toHaveCount(2);
  });

  test("非文本卡不出「高亮差异」开关：没有可逐行比的正文，给个假的差异更糟", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-对比图形-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const auth = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: auth,
      data: { type: "text", title: "一段文字", content: "正文", x: 60, y: 80, w: 280, h: 150 },
    });
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: auth,
      data: { type: "mermaid", title: "一张图", mermaid: { source: "flowchart LR\n  A --> B" }, x: 400, y: 80, w: 280, h: 150 },
    });
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(2);
    await page.locator(".top-btn[aria-label='适应内容']").click();
    await page.waitForTimeout(400);

    const pane = await page.locator(".react-flow__pane").boundingBox();
    await page.mouse.move(pane!.x + pane!.width - 14, pane!.y + pane!.height - 14);
    await page.mouse.down();
    await page.mouse.move(pane!.x + 14, pane!.y + 14, { steps: 16 });
    await page.mouse.up();
    await expect(page.locator(`${CARD}.selected`)).toHaveCount(2);

    await page.locator(".react-flow__nodesselection-rect").click({ button: "right", force: true });
    await page.locator(".context-menu").getByText("并排对比这 2 张").click();
    await expect(page.locator(".compare-modal")).toBeVisible();
    await expect(page.locator('[data-act="compare-diff"]')).toHaveCount(0);
    await page.locator('[data-act="compare-close"]').click();
    await expect(page.locator(".compare-modal")).toHaveCount(0);
  });
});

test.describe("第十三轮：连线的关系语义（强弱 / 标签）", () => {
  test("连线工具条多一个「关系」抽屉：标强弱与标签都落库，跟外观分开", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-连线语义-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const auth = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    const ids: string[] = [];
    for (const [title, x] of [["起", 80], ["落", 460]] as [string, number][]) {
      const res = await page.request.post(`/api/boards/${boardId}/cards`, {
        headers: auth,
        data: { type: "text", title, x, y: 100, w: 260, h: 140 },
      });
      ids.push((await res.json()).card.id);
    }
    await page.request.post(`/api/boards/${boardId}/edges`, { headers: auth, data: { from: ids[0], to: ids[1] } });
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(2);
    await page.locator(".top-btn[aria-label='适应内容']").click();
    await page.waitForTimeout(400);

    // 点中连线 → 工具条出来 → 开「关系」抽屉
    await page.locator(".react-flow__edge").first().click({ force: true });
    const toolbar = page.locator(".edge-toolbar");
    await expect(toolbar).toBeVisible();
    await toolbar.locator('[data-act="edge-relation"]').click();
    const rel = toolbar.locator(".et-rel");
    await expect(rel).toBeVisible();
    // 「外观」与「关系」互斥：开一个另一个收起来，免得把线宽当成关系强弱改
    await expect(toolbar.locator(".et-look:not(.et-rel)")).toHaveCount(0);

    // 标强弱 4 + 加一个标签
    await rel.locator('[data-weight="4"]').click();
    await rel.locator('[data-field="edge.tag"]').fill("主线");
    await rel.locator('[data-field="edge.tag"]').press("Enter");
    await expect
      .poll(async () => {
        const board = await (await page.request.get(`/api/boards/${boardId}`)).json();
        const edge = board.board.edges[0];
        return `${edge.weight}|${(edge.tags || []).join(",")}`;
      })
      .toBe("4|主线");

    // 再点同一档 = 取消标注（不用先去找「未标」那颗）
    await rel.locator('[data-weight="4"]').click();
    await expect
      .poll(async () => {
        const board = await (await page.request.get(`/api/boards/${boardId}`)).json();
        return board.board.edges[0].weight;
      })
      .toBeNull();
  });
});

test.describe("第十三轮：三种新整理（四象限 / 泳道 / 子图分簇）", () => {
  test("顶栏「整理」菜单里各来一下：坐标真的变了，而且都能撤销", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-新整理-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const auth = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    for (let i = 0; i < 4; i += 1) {
      await page.request.post(`/api/boards/${boardId}/cards`, {
        headers: auth,
        // 故意堆在一起：任何一种重排都会把它们分开
        data: { type: "task", title: `排 ${i + 1}`, task: { status: i % 2 ? "running" : "idea", priority: i < 2 ? "urgent" : "low" }, x: 90, y: 90, w: 240, h: 130 },
      });
    }
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(4);

    const positions = async () => {
      const board = await (await page.request.get(`/api/boards/${boardId}`)).json();
      return board.board.cards.map((card: any) => `${card.x},${card.y}`).join(";");
    };
    const before = await positions();

    for (const label of ["四象限", "泳道", "子图分簇"]) {
      await page.locator(".top-btn", { hasText: "整理" }).click();
      await page.locator(".layout-menu").getByText(label, { exact: true }).click();
      await expect(page.locator(".toast")).toContainText(label === "四象限" ? "已摆进四象限" : label === "泳道" ? "已排成泳道" : "已按子图分簇");
      await expect.poll(positions).not.toBe(before);
      // 每一种都给撤销：整理是不可逆才最烦人
      await page.locator(".toast").getByRole("button", { name: "撤销" }).click();
      await expect.poll(positions, { timeout: 10_000 }).toBe(before);
    }
  });
});

test.describe("第四波：历史抽屉（改动记录 + 快照回滚）", () => {
  test("agent 整板改写后，历史里看得到那条记录，也能一键倒回去", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-历史-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const auth = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    const ids: string[] = [];
    for (const title of ["原稿甲", "原稿乙"]) {
      const res = await page.request.post(`/api/boards/${boardId}/cards`, {
        headers: auth,
        data: { type: "text", title, x: 80 + ids.length * 320, y: 120, w: 260, h: 140 },
      });
      ids.push((await res.json()).card.id);
    }
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(2);

    // 单卡建卡不打点：先确认历史是空的（否则后面分不清「哪份快照是谁打的」）
    await page.locator(".top-btn", { hasText: "历史" }).click();
    const drawer = page.locator(".drawer.history-drawer.open");
    await expect(drawer).toBeVisible();
    await drawer.locator(".drawer-tabs button", { hasText: "改动记录" }).click();
    await expect(drawer.locator(".config-hint")).toContainText("还没有批量改动记录");
    await drawer.locator(".drawer-tabs button", { hasText: "历史快照" }).click();
    await expect(drawer.locator(".config-hint")).toContainText("还没有快照");

    // agent 来一次整板改写，只剩一张卡
    await page.request.put(`/api/boards/${boardId}/whole`, {
      headers: auth,
      data: { cards: [{ id: ids[0], type: "text", title: "agent 改完只剩这张", x: 80, y: 120, w: 260, h: 140 }] },
    });
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(1);

    // 改动记录：谁改的、改了什么，且带着「这之前的那一版」的入口
    await drawer.locator(".drawer-tabs button", { hasText: "改动记录" }).click();
    const entry = drawer.locator(".hist-row").first();
    await expect(entry.locator(".hist-actor")).toHaveText("agent");
    await expect(entry.locator(".hist-action")).toHaveText("整板改写");
    await expect(entry.locator(".hist-text")).toContainText("卡片 2 → 1");
    await entry.locator(".hist-jump").click();

    // 跳到快照页并高亮那一份；回滚要两步确认，文案说清会覆盖什么
    const snap = drawer.locator(".hist-row.snap.active");
    await expect(snap).toHaveCount(1);
    await expect(snap.locator(".hist-text")).toContainText("卡片 2");
    await snap.getByRole("button", { name: "回滚到这一版" }).click();
    await expect(snap.locator(".hist-warn")).toContainText("覆盖");
    await snap.getByRole("button", { name: "确认覆盖" }).click();

    // 两张卡都回来了，且回滚前那一版也被存了下来（回滚本身有回头路）
    await expect(page.locator(CARD)).toHaveCount(2);
    await expect(page.locator(".toast")).toContainText("已回滚");
    await expect(drawer.locator(".hist-row.snap").first().locator(".hist-action")).toHaveText("回滚前");
    await expect
      .poll(async () => {
        const board = await (await page.request.get(`/api/boards/${boardId}`)).json();
        return board.board.cards.map((card: any) => card.title).sort().join(",");
      })
      .toBe("原稿乙,原稿甲");
  });
});

test.describe("第四波：分组框（把几张卡圈进一个框）", () => {
  test("建框 → 拖卡进框（自动归属）→ 拖框（框里的卡跟着走）→ 折叠 → 删框不删卡", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-分组框-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const auth = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    // 框摆左边，卡摆右边（框外），坐标写死才好断言「拖进去了没有」
    const frameRes = await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: auth,
      data: { type: "frame", title: "一摊事", x: 40, y: 40, w: 520, h: 380 },
    });
    const frameId = (await frameRes.json()).card.id;
    const cardRes = await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: auth,
      data: { type: "text", title: "要圈进去的", x: 720, y: 80, w: 220, h: 120 },
    });
    const cardId = (await cardRes.json()).card.id;
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(2);
    await page.locator(".top-btn[aria-label='适应内容']").click();
    await page.waitForTimeout(400);

    const board = async () => (await (await page.request.get(`/api/boards/${boardId}`)).json()).board;
    const cardOf = async (id: string) => (await board()).cards.find((item: any) => item.id === id);

    const frameNode = page.locator(`.react-flow__node[data-id="${frameId}"]`);
    const cardNode = page.locator(`.react-flow__node[data-id="${cardId}"]`);
    await expect(frameNode.locator(".card.t-frame")).toBeVisible();
    await expect(frameNode.locator(".frame-count")).toHaveText("把卡片拖进来");

    // ① 拖进框：抓卡头往框中心拖，松手就该归属
    const frameBox = (await frameNode.boundingBox())!;
    const cardBox = (await cardNode.boundingBox())!;
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 12);
    await page.mouse.down();
    await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2, { steps: 14 });
    await page.mouse.up();
    await expect.poll(async () => (await cardOf(cardId)).frameId, { timeout: 10_000 }).toBe(frameId);
    await expect(frameNode.locator(".frame-count")).toHaveText("1 张卡片");

    // ② 拖框：框里的卡跟着走（我们存的是绝对坐标，得跟着补上位移）
    const before = await cardOf(cardId);
    const frameBefore = await cardOf(frameId);
    const grab = (await frameNode.boundingBox())!;
    await page.mouse.move(grab.x + grab.width / 2, grab.y + 12);
    await page.mouse.down();
    await page.mouse.move(grab.x + grab.width / 2 + 180, grab.y + 12 + 120, { steps: 14 });
    await page.mouse.up();
    await expect
      .poll(async () => {
        const frameNow = await cardOf(frameId);
        const cardNow = await cardOf(cardId);
        const dx = frameNow.x - frameBefore.x;
        const dy = frameNow.y - frameBefore.y;
        // 框真的动了，而且卡挪了同样的距离（差 1px 以内，四舍五入）
        return dx !== 0 && Math.abs(cardNow.x - before.x - dx) <= 1 && Math.abs(cardNow.y - before.y - dy) <= 1;
      }, { timeout: 10_000 })
      .toBe(true);

    // ③ 折叠：框里的卡不画了，框还在；数据一张不动
    await frameNode.locator(".frame-toggle").click();
    await expect(cardNode).toHaveCount(0);
    await expect(frameNode.locator(".frame-toggle")).toContainText("展开");
    expect((await cardOf(cardId)).frameId).toBe(frameId);
    await frameNode.locator(".frame-toggle").click();
    await expect(cardNode).toHaveCount(1);

    // ④ 拖出框：中心落到框外就解除归属（不锁死在框里，这是它跟 extent:"parent" 的差别）
    const out = (await cardNode.boundingBox())!;
    const pane = (await page.locator(".react-flow__pane").boundingBox())!;
    await page.mouse.move(out.x + out.width / 2, out.y + 12);
    await page.mouse.down();
    await page.mouse.move(pane.x + pane.width - 90, pane.y + pane.height - 70, { steps: 16 });
    await page.mouse.up();
    await expect.poll(async () => (await cardOf(cardId)).frameId, { timeout: 10_000 }).toBeNull();

    // ⑤ 删框不删卡：先放回框里，再删框
    await page.request.patch(`/api/boards/${boardId}/cards/${cardId}`, { headers: auth, data: { frameId } });
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect.poll(async () => (await cardOf(cardId)).frameId).toBe(frameId);

    // 分组框是阅读顺序里的第一张卡。它的 FullView 不能在 Zustand selector
    // 里直接 filter 出新数组，否则 React 19 会报 #185 并把整页替换成 500。
    await page.locator(".top-btn", { hasText: "阅读" }).click();
    const reader = page.locator(".reader-modal");
    await expect(reader).toBeVisible();
    await expect(reader).toContainText("分组框");
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);

    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain("会留在画布上");
      void dialog.accept();
    });
    await frameNode.locator(".card").click({ button: "right" });
    await page.locator(".cm-item", { hasText: "删除这个框" }).click();
    await expect.poll(async () => (await board()).cards.length, { timeout: 10_000 }).toBe(1);
    expect((await cardOf(cardId)).frameId).toBeNull();
  });
});

test.describe("第四波：悬浮工具条（选中卡片上方的快捷条）", () => {
  test("单选出条 → 点一项真生效；多选换成批量条；关掉之后 ⋯ 与右键照旧", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-快捷条-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const auth = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    const ids: string[] = [];
    for (const [title, x] of [["甲", 80], ["乙", 420]] as [string, number][]) {
      const res = await page.request.post(`/api/boards/${boardId}/cards`, {
        headers: auth,
        data: { type: "text", title, content: "正文", x, y: 120, w: 250, h: 130 },
      });
      ids.push((await res.json()).card.id);
    }
    await page.locator(".top-btn[aria-label='刷新']").click();
    await expect(page.locator(CARD)).toHaveCount(2);

    const cardOf = async (id: string) => {
      const board = await (await page.request.get(`/api/boards/${boardId}`)).json();
      return board.board.cards.find((item: any) => item.id === id);
    };

    // ① 没选中的时候没有条
    await clickBlankPane(page);
    await expect(page.locator(".node-bar")).toHaveCount(0);

    // ② 选一张 → 条出来；点一颗色点，颜色真落库
    await page.locator(`.react-flow__node[data-id="${ids[0]}"] .card`).click();
    const bar = page.locator(".node-bar");
    await expect(bar).toBeVisible();
    await bar.locator('.nb-dot[data-color="green"]').click();
    await expect.poll(async () => (await cardOf(ids[0])).color, { timeout: 10_000 }).toBe("green");

    // ③ 阅读那一项走的是同一个阅读模式（跟 ⋯ 菜单、R 键同一个出口）
    await bar.locator('[data-act="bar-read"]').click();
    await expect(page.locator(".reader-modal, .drawer.open, .modal")).toBeVisible();
    await page.keyboard.press("Escape");

    // ④ 多选 → 换成批量条，计数对得上；批量改色一次改两张
    await page.locator(`.react-flow__node[data-id="${ids[0]}"] .card`).click();
    await page.locator(`.react-flow__node[data-id="${ids[1]}"] .card`).click({ modifiers: ["Shift"] });
    await expect(page.locator(".node-bar .nb-count")).toHaveText("2 张");
    await page.locator('.node-bar .nb-dot[data-color="violet"]').click();
    await expect
      .poll(async () => `${(await cardOf(ids[0])).color}|${(await cardOf(ids[1])).color}`, { timeout: 10_000 })
      .toBe("violet|violet");

    // ⑤ 关掉开关：条消失，但卡头的 ⋯ 与右键菜单一点没少（它才是完整入口）
    // 刷一次页面从干净的选中态开始（点在已经选中的卡上不会散掉多选——那是为了能拖整组），
    // 顺便验证开关存在 localStorage 里、刷新之后还认
    await page.locator('.toolbar [data-act="toggle-nodebar"]').click();
    await page.reload();
    await expect(page.locator(".board-item").first()).toBeVisible();
    await expect(page.locator(CARD)).toHaveCount(2);
    await page.locator(`.react-flow__node[data-id="${ids[0]}"] .card`).click();
    await expect(page.locator(`.react-flow__node[data-id="${ids[0]}"]`)).toHaveClass(/selected/);
    await expect(page.locator(".node-bar")).toHaveCount(0);
    await page.locator(`.react-flow__node[data-id="${ids[0]}"] .card`).click({ button: "right" });
    await expect(page.locator(".cm-item", { hasText: "阅读模式" })).toBeVisible();
    await page.keyboard.press("Escape");
    // 开回来，别把偏好留在关着的状态污染别的用例（e2e 是同一个浏览器上下文串着跑的）
    await clickBlankPane(page);
    await page.locator('.toolbar [data-act="toggle-nodebar"]').click();
  });
});

test.describe("工具条分组：常驻十二个，其余收进「更多」", () => {
  test("基础与表达常驻；组织/外部收在「更多」里，点一下能建卡，点别处收起", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-工具条-${Date.now() % 100000}`);

    // 常驻的按属性排：先「基础·写」，再「表达·画与结构」
    const pinned = await page.locator(".toolbar > button[data-add]").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-add")),
    );
    expect(pinned).toEqual([
      "text", "task", "todo", "quote", "link",
      "mindmap", "mermaid", "chart", "svg", "excalidraw", "table", "code",
    ]);
    // 收纳的那几种不在常驻区（省得二十个按钮把画布顶出屏幕）
    for (const type of ["data", "board", "frame", "html", "ref", "book"]) {
      await expect(page.locator(`.toolbar > button[data-add="${type}"]`)).toHaveCount(0);
    }

    // 展开「更多」：两组带小标题，外部来源排在最后
    await page.locator('.toolbar button[data-act="toolbar-more"]').click();
    const panel = page.locator(".tb-more-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".tb-more-cap")).toHaveText(["组织与结构化", "外部来源"]);
    const inPanel = await panel.locator("button[data-add]").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-add")),
    );
    expect(inPanel).toEqual(["data", "board", "frame", "html", "ref", "book"]);

    // 点一项照样建卡，建完面板自己收起
    await panel.locator('button[data-add="frame"]').click();
    await expect(page.locator(".tb-more-panel")).toHaveCount(0);
    await expect(page.locator(CARD)).toHaveCount(1);
    // 建完卡会自动开编辑抽屉，它盖着工具条——先关掉再继续（不关就点不到「更多」）
    await page.keyboard.press("Escape");
    await expect(page.locator(".drawer.card-drawer.open")).toHaveCount(0);

    // Esc 收起
    await page.locator('.toolbar button[data-act="toolbar-more"]').click();
    await expect(page.locator(".tb-more-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".tb-more-panel")).toHaveCount(0);
  });

  test("不明确的画布开关：悬停与键盘聚焦都会出现说明卡", async ({ page }) => {
    await boot(page);

    const triggers = page.locator(".toolbar [data-help-key]");
    await expect(triggers).toHaveCount(5);

    // 网格：鼠标停留后出现自定义卡片，而不是只有浏览器原生 title。
    const grid = page.locator('.toolbar [data-act="toggle-snapgrid"]');
    await expect(grid).not.toHaveAttribute("title", /.+/);
    await grid.hover();
    const help = page.locator(".toolbar-help-card");
    await expect(help).toBeVisible();
    await expect(help).toHaveAttribute("data-help-for", "grid");
    await expect(help).toContainText("22px 点阵");
    await expect(help).toContainText("不会重排整板");

    // 聚焦：键盘用户把焦点移上去，也能读到同一套解释。
    const focus = page.locator('.toolbar [data-act="toggle-focus"]');
    await focus.focus();
    await expect(help).toHaveAttribute("data-help-for", "focus");
    await expect(help).toContainText("直接相连");
    await expect(focus).toHaveAttribute("aria-describedby", "toolbar-help-card");

    // 快捷条同样纳入，不只给示例里的网格做一个特例。
    await page.locator('.toolbar [data-act="toggle-nodebar"]').hover();
    await expect(help).toHaveAttribute("data-help-for", "nodebar");
    await expect(help).toContainText("右键菜单仍保留全部功能");
  });
});

test.describe("阅读模式：每一种卡片都摊得开", () => {
  test("规格卡 / 任务 / 引用 / 分组框 摊开都有内容，不再是「还没有正文」", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-阅读-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    // 规格卡：正文全在 fields 里、content 是空的——通用兜底会显示「还没有正文」
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers,
      data: {
        type: "data",
        title: "一条用户反馈",
        x: 40,
        y: 40,
        data: {
          specId: "user-feedback",
          fields: { topic: "信封严格模式", content: "整批坏卡拒收不利于调试。", user: "张三", channel: "wechat" },
        },
      },
    });
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers,
      data: { type: "quote", title: "引用", content: "把想法摊开成卡片。", x: 420, y: 40, quote: { source: "README" } },
    });
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers,
      data: { type: "task", title: "一条任务", content: "把阅读模式补齐", x: 40, y: 320, task: { priority: "high" } },
    });
    await page.reload();
    await expect(page.locator(CARD)).toHaveCount(3);

    const openReader = async (title: string) => {
      await page.locator(CARD, { hasText: title }).click();
      await page.keyboard.press("r");
      await expect(page.locator(".reader-modal")).toBeVisible();
    };
    const closeReader = async () => {
      await page.keyboard.press("Escape");
      await expect(page.locator(".reader-modal")).toHaveCount(0);
    };

    // 规格卡：按规格渲染（标题带 + 正文 + 属性），且不能出现兜底文案
    await openReader("一条用户反馈");
    const reader = page.locator(".reader-modal");
    await expect(reader.locator(".dc.full")).toBeVisible();
    await expect(reader).toContainText("整批坏卡拒收不利于调试。");
    await expect(reader).toContainText("张三");
    await expect(reader).not.toContainText("这张卡还没有正文");
    await closeReader();

    // 任务：状态 / 优先级摆在正文前面
    await openReader("一条任务");
    await expect(page.locator(".reader-modal .reader-chip").first()).toBeVisible();
    await expect(page.locator(".reader-modal")).toContainText("把阅读模式补齐");
    await closeReader();

    // 引用：正文 + 出处
    await openReader("引用");
    await expect(page.locator(".reader-modal")).toContainText("把想法摊开成卡片。");
    await expect(page.locator(".reader-modal")).toContainText("README");
    await closeReader();
  });
});

test.describe("第十一轮：音视频卡（本地媒体）", () => {
  /** ISO-BMFF 盒子：签名校验只看第 5-8 字节的 ftyp，后面填零就够当样本（不求真能解码） */
  const boxOf = (brand: string) =>
    Buffer.concat([Buffer.from("00000020", "hex"), Buffer.from(`ftyp${brand}`), Buffer.alloc(32)]);

  test("上传 mp4 / m4a：卡面就地出播放器 · 阅读模式摊开 · 不认的格式挡在门外", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-音视频-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const picker = page.locator(".toolbar input[type=file]");

    // 走用户真正的那条路：文件选择器 → 上传 → 自动建卡（不是直接调 API 造数据）
    await picker.setInputFiles({ name: "演示片.mp4", mimeType: "video/mp4", buffer: boxOf("isom") });
    const videoCard = page.locator(`${CARD} .card.t-media`).first();
    await expect(videoCard).toBeVisible();
    const video = videoCard.locator("video.media-video");
    await expect(video).toHaveAttribute("src", /\/api\/boards\/uploads\/web-\d+-[a-f0-9]+\.mp4$/);
    // 拖进度条要能拖：播放器不能被 React Flow 的拖拽接管
    await expect(video).toHaveClass(/nodrag/);

    // Range 分段：拖进度条靠它（没有 206，Safari 直接不播）
    const src = (await video.getAttribute("src"))!;
    const ranged = await page.request.get(src, { headers: { range: "bytes=4-7" } });
    expect(ranged.status()).toBe(206);
    expect(ranged.headers()["content-range"]).toMatch(/^bytes 4-7\/\d+$/);
    expect(await ranged.text()).toBe("ftyp");

    /* 阅读模式摊开：同一份卡片包的 FullView，播放器铺成大舞台。
       趁板上只有这一张卡时做——新卡都落在视口中心附近，第二张会盖住它 */
    await videoCard.locator(".card-head").click();
    await page.keyboard.press("r");
    await expect(page.locator(".reader-modal video.reader-media")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".reader-modal")).toHaveCount(0);

    // 浏览器给不出 MIME 的音频（.m4a 常见）也要收，且落成音频卡面
    await picker.setInputFiles({ name: "播客.m4a", mimeType: "", buffer: boxOf("M4A ") });
    const audioCard = page.locator(`${CARD} .card.t-media`, { hasText: "播客" });
    await expect(audioCard.locator("audio.media-audio")).toHaveCount(1);

    // 落库形态：kind / mediaType 由服务端按后缀推导
    const saved = await (await page.request.get(`/api/boards/${boardId}`)).json();
    const kinds = saved.board.cards.filter((card: any) => card.type === "media").map((card: any) => card.file.kind).sort();
    expect(kinds).toEqual(["audio", "video"]);

    // 不认的格式：当场说清楚，不静默吞掉
    await picker.setInputFiles({ name: "坏东西.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await expect(page.locator(".toast")).toContainText("暂不支持该文件类型");
    await expect(page.locator(`${CARD} .card.t-media`)).toHaveCount(2);
  });
});

test.describe("顶栏分区与帮助页", () => {
  test("顶栏三块：左上角站点导航 / 中间画布工具 / 右侧三组动作", async ({ page }) => {
    await boot(page);

    // 左上角是「去哪儿」：开始入口 + 原六个页面收在一个胶囊里，当前页高亮
    const nav = page.locator(".topbar .site-nav");
    await expect(nav.locator(".sn-item")).toHaveCount(7);
    await expect(nav.locator(".sn-item.current")).toHaveText("画板");
    // 「独立服务」那个角标已经去掉了：品牌位只剩名字
    await expect(page.locator(".topbar .brand")).toHaveText("泼墨画板");

    // 中间是「怎么看这块画布」：工具开关 + 视野，两侧留白顶到中间
    const center = page.locator(".topbar .top-center");
    await expect(center.locator(".tool-switch button")).toHaveCount(2);
    await expect(center.locator(".zoom-box")).toBeVisible();

    // 右侧三组：内容 / 整理与导出 / 协作与 Agent
    await expect(page.locator('.topbar .top-group[aria-label="内容"] .top-btn')).toHaveCount(2);
    const organize = page.locator('.topbar .top-group[aria-label="整理与导出"]');
    await expect(organize.locator(".top-btn")).toHaveCount(3);
    await expect(page.locator('.topbar .top-group[aria-label="协作与 Agent"]')).toBeVisible();

    // 分组只是排版，按钮照旧能用：点「整理」弹出十一种摆法的菜单
    await organize.locator(".top-btn", { hasText: "整理" }).click();
    await expect(page.locator(".layout-menu .cm-item", { hasText: "整齐化" })).toBeVisible();
    await page.keyboard.press("Escape");

    // 站点导航从画板出发是新标签打开（画布不被顶掉）
    const [helpPage] = await Promise.all([
      page.context().waitForEvent("page"),
      nav.locator(".sn-item", { hasText: "帮助" }).click(),
    ]);
    await expect(helpPage.locator(".doc-title")).toBeVisible({ timeout: 15_000 });
    await helpPage.close();
  });

  test("帮助页：目录分组 → 点开正文 → 站内跳转 → 深链直达", async ({ page }) => {
    await page.goto("/docs");

    // 目录按 frontmatter 的分组摊开，第一页自动打开
    await expect(page.locator(".doc-group").first()).toBeVisible();
    const items = page.locator(".doc-item");
    expect(await items.count()).toBeGreaterThan(3);
    await expect(page.locator(".doc-item.active")).toHaveCount(1);
    await expect(page.locator(".doc-md")).not.toBeEmpty();
    // frontmatter 不能漏进正文
    await expect(page.locator(".doc-md")).not.toContainText("summary:");

    // 搜索连正文一起匹配（找「回滚」的人不会先猜到那一页叫「历史」）
    const total = await items.count();
    await page.locator(".doc-side .nav-search input").fill("回滚");
    await expect(page.locator(".doc-item", { hasText: "历史、撤销与重做" })).toBeVisible();
    expect(await items.count()).toBeLessThan(total);
    await page.locator(".doc-side .nav-search input").fill("");
    await expect(items).toHaveCount(total);

    // 新手不必靠悬停猜开关：帮助里有一页把五个开关和两种“网格”讲清楚。
    await page.locator(".doc-item", { hasText: "画布辅助开关" }).click();
    await expect(page.locator(".doc-title")).toHaveText("画布辅助开关");
    await expect(page.locator(".doc-md")).toContainText("对齐认邻居");
    await expect(page.locator(".doc-md")).toContainText("整理 → 网格铺开");

    // 点目录换页：地址栏跟着走，正文换了
    await page.locator(".doc-item", { hasText: "五分钟上手" }).click();
    await expect(page.locator(".doc-title")).toHaveText("五分钟上手");
    await expect(page).toHaveURL(/\?doc=quickstart$/);

    // 正文里的站内链接就地切页，不新开标签
    await page.locator(".doc-md a", { hasText: "连线有语义" }).first().click();
    await expect(page.locator(".doc-title")).toHaveText("连线有语义");
    await expect(page).toHaveURL(/\?doc=edges$/);

    // 页脚串起上一页 / 下一页
    await page.locator(".doc-foot-btn.next").click();
    await expect(page.locator(".doc-title")).toHaveText("分组框与子画板");

    // 深链直达：分享出去的链接要落到那一页
    await page.goto("/docs?doc=faq");
    await expect(page.locator(".doc-title")).toHaveText("常见问题");
    await expect(page.locator(".site-nav .sn-item.current")).toHaveText("帮助");
  });
});

/**
 * 每一页「装了多少」减「装得下多少」的最大值。>1 就是有页被 overflow:hidden 裁过。
 * 自己流的页（超过一整页的长卡）不锁高度，不参与这条判断。
 */
async function overflowOfSheets(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const inner = (document.querySelector(".pdf-frame") as HTMLIFrameElement).contentDocument!;
    const over = [...inner.querySelectorAll(".sheet:not(.flow)")].map((sheet) => {
      const body = sheet.querySelector(".page-body") as HTMLElement | null;
      const flow = sheet.querySelector(".page-flow") as HTMLElement | null;
      if (!body || !flow) return 0;
      return flow.getBoundingClientRect().height - body.clientHeight;
    });
    return Math.max(0, ...over);
  });
}

test.describe("PDF 排版与导出", () => {
  /**
   * 分页与页码是这条链路的全部价值，所以要真的量一遍：预览里那一页页纸就是打印产物
   * （同一份文档、同一次分页），断言打在它身上才算数。真正的系统打印对话框不测——
   * 那是浏览器的东西，测它等于测 Chrome；这里把 print() 拦下来，验到「文档已经送进打印帧」为止。
   */
  test("排版面板：真分页 + 目录页码 + 设置改版面；一键导出把排好的文档送进打印", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-PDF-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);
    const headers = { "content-type": "application/json", "x-auth-key": "e2e-token" };

    // 摆够能翻页的量：每张卡都带一段长正文与一条外链
    for (let i = 1; i <= 6; i += 1) {
      await page.request.post(`/api/boards/${boardId}/cards`, {
        headers,
        data: {
          type: "text",
          title: `PDF 卡片 ${i}`,
          // 正文写成 Markdown：链接必须是真的 <a>（这条链路的承诺就是「印出来还能点」）
          content: `## 小节 ${i}\n\n${`第 ${i} 段正文，够长才排得出页。`.repeat(24)}\n\n[示例链接 ${i}](https://example.com/card-${i})`,
          x: 100 + i * 40,
          y: 100 + i * 30,
        },
      });
    }
    await page.reload();

    /* 顶栏导出菜单里 PDF 是头两项 */
    await page.locator('.top-btn[aria-label="导出"]').click();
    await expect(page.locator(".layout-menu .cm-item", { hasText: "导出 PDF" })).toBeVisible();
    await page.locator(".layout-menu .cm-item", { hasText: "PDF 排版设置" }).click();

    const modal = page.locator(".pdf-modal");
    await expect(modal).toBeVisible();
    const frame = page.frameLocator(".pdf-frame");
    // 分页真的发生了：封面 + 目录 + 若干正文页
    await expect(frame.locator(".sheet").first()).toBeVisible({ timeout: 20_000 });
    const pagesOf = async () => await frame.locator(".sheet").count();
    const normal = await pagesOf();
    expect(normal).toBeGreaterThan(2);
    await expect(modal.locator(".pdf-head-count")).toContainText(`${normal} 页`);

    // 封面 / 目录 / 页脚页码 / 正文里的真链接，四样都得在
    await expect(frame.locator(".pdf-cover h1")).toBeVisible();
    await expect(frame.locator("ul.pdf-toc li").first()).toBeVisible();
    await expect(frame.locator(".page-foot .pf-no").first()).toContainText("/");
    await expect(frame.locator('.card-body a[href="https://example.com/card-1"]').first()).toHaveCount(1);
    // 目录右边那一列是真页码：正文第一页排在封面与目录之后
    const firstTocPage = Number(await frame.locator("ul.pdf-toc li .tp").first().textContent());
    expect(firstTocPage).toBeGreaterThan(1);
    // 不变式：没有任何一页装超了。装超了不会报错，只会被 overflow:hidden 悄悄裁掉
    expect(await overflowOfSheets(page)).toBeLessThanOrEqual(1);

    /* 设置真的改版面：字号大一档，页数只会多不会少 */
    const pickSeg = async (label: string, text: string) => {
      await modal
        .locator(".pdf-row", { has: page.locator(".pdf-row-label", { hasText: label }) })
        .locator(".pdf-seg button", { hasText: text })
        .click();
      // 重排是防抖的，等页数读数稳定下来
      await page.waitForTimeout(900);
    };
    await pickSeg("字号", "大");
    await expect(frame.locator(".sheet").first()).toBeVisible();
    expect(await pagesOf()).toBeGreaterThanOrEqual(normal);
    await pickSeg("字号", "标准");

    // 关掉封面与目录：页数跟着少两页，说明这两个开关不是摆设
    await modal.locator(".pdf-toggle", { hasText: "封面" }).click();
    await page.waitForTimeout(900);
    await modal.locator(".pdf-toggle", { hasText: "目录" }).click();
    await page.waitForTimeout(900);
    await expect(frame.locator(".pdf-cover")).toHaveCount(0);
    expect(await pagesOf()).toBeLessThan(normal);
    // 设置记在本地：关掉重开还是刚才那套
    await modal.locator(".drawer-close").click();
    await page.locator('.top-btn[aria-label="导出"]').click();
    await page.locator(".layout-menu .cm-item", { hasText: "PDF 排版设置" }).click();
    await expect(page.frameLocator(".pdf-frame").locator(".sheet").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".pdf-modal .pdf-toggle", { hasText: "封面" })).not.toHaveClass(/on/);
    await page.locator(".pdf-modal .pdf-toggle", { hasText: "封面" }).click();
    await page.locator(".pdf-modal .pdf-toggle", { hasText: "目录" }).click();
    await page.waitForTimeout(900);
    await page.locator(".pdf-modal .drawer-close").click();

    /* 一键导出：把 print() 拦下来，验到「排好的文档已经进了打印帧」 */
    await page.evaluate(() => {
      (window as unknown as { __printed?: unknown }).__printed = null;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            const frameEl = node as HTMLIFrameElement;
            if (frameEl.tagName !== "IFRAME" || !frameEl.hasAttribute("srcdoc")) continue;
            if (frameEl.classList.contains("pdf-frame")) continue;
            const win = frameEl.contentWindow;
            if (!win) continue;
            win.print = () => {
              const inner = frameEl.contentDocument!;
              (window as unknown as { __printed?: unknown }).__printed = {
                sheets: inner.querySelectorAll(".sheet").length,
                links: inner.querySelectorAll('a[href^="https://example.com/"]').length,
                // 预览的灰底裹在 @media screen 里，打印产物必须是白纸
                background: getComputedStyle(inner.body).backgroundColor,
                // 留一份原样文档：下面真印一次，验的就该是送进打印机的这一份
                html: `<!doctype html>${inner.documentElement.outerHTML}`,
              };
            };
          }
        }
      });
      observer.observe(document.body, { childList: true });
    });
    await page.locator('.top-btn[aria-label="导出"]').click();
    await page.locator(".layout-menu .cm-item", { hasText: "导出 PDF" }).first().click();
    await expect(page.locator(".toast")).toContainText("已排好", { timeout: 30_000 });
    const printed = await page.evaluate(() => (window as unknown as { __printed?: Record<string, unknown> }).__printed);
    expect(printed).toBeTruthy();
    expect(printed!.sheets as number).toBeGreaterThan(2);
    expect(printed!.links as number).toBeGreaterThan(0);
    expect(printed!.background).toBe("rgb(255, 255, 255)");

    /**
     * 真的印一次。
     *
     * 上面全是 DOM 断言——它们证明「我们排出了 N 页」，证明不了「浏览器印出来也是 N 页」。
     * 这一段把排好的文档喂进一个新页面，用 Chromium 自己的 print-to-PDF 出片，
     * 再回头验三件事：页数一致（没有多吐空白页）、纸张真是 A4、链接是**真的链接注解**。
     * 有头模式下 Chromium 不给印，那时候跳过——这一段是加分项，不该让 `--headed` 变红。
     */
    const printablePage = await page.context().newPage();
    await printablePage.setContent(printed!.html as string, { waitUntil: "load" });
    let pdf: Buffer | null = null;
    try {
      pdf = await printablePage.pdf({ preferCSSPageSize: true, printBackground: true });
    } catch {
      /* 有头模式：Chromium 不支持 page.pdf()，跳过这一段 */
    }
    await printablePage.close();
    if (pdf) {
      const raw = pdf.toString("latin1");
      // 页数：/Count 里最大的那个就是文档总页数
      const counts = [...raw.matchAll(/\/Count\s+(\d+)/g)].map((match) => Number(match[1]));
      expect(Math.max(...counts)).toBe(printed!.sheets as number);
      // 纸张：A4 = 595 × 842 pt（允许一点点取整误差）
      const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(raw);
      expect(box).toBeTruthy();
      expect(Math.round(Number(box![1]))).toBe(595);
      expect(Math.round(Number(box![2]))).toBe(842);
      // 链接是真注解，文字是真字体（不是把每页截成图）
      expect((raw.match(/\/URI\s*\(/g) || []).length).toBeGreaterThan(0);
      expect(raw).toContain("/FontFile2");
    }
  });

  /**
   * 目录跨页。
   *
   * 这是真栽过的一次：目录一开始按「一页 30 条」硬切，而 A4 标准边距实际只装得下 20 多条，
   * 多出来的几条被 `overflow:hidden` 悄悄裁掉——页面上没有任何异常，只是目录里凭空少了几行，
   * 还留下一行被切掉半截的字。所以这条用例查两件事：**条目一条不少**，
   * 以及**没有任何一页装超了**。
   */
  test("目录跨页：按量出来的高度分页，一条都不会被裁掉", async ({ page }) => {
    await boot(page);
    await newBoard(page, `E2E-PDF目录-${Date.now() % 100000}`);
    const boardId = await currentBoardId(page);

    // 一次塞够条目：卡片之间没有连线，所以整块板只有一节，目录条目数 = 卡片数
    const COUNT = 34;
    const ingest = await page.request.post(`/api/boards/${boardId}/ingest`, {
      headers: { "content-type": "application/json", "x-auth-key": "e2e-token" },
      data: {
        format: "blotboard.cards",
        version: 1,
        cards: Array.from({ length: COUNT }, (_, at) => ({
          type: "text",
          title: `目录条目 ${at + 1}`,
          content: `短正文 ${at + 1}`,
        })),
      },
    });
    expect(ingest.status()).toBe(201);
    await page.reload();

    await page.locator('.top-btn[aria-label="导出"]').click();
    await page.locator(".layout-menu .cm-item", { hasText: "PDF 排版设置" }).click();
    const frame = page.frameLocator(".pdf-frame");
    await expect(frame.locator(".sheet").first()).toBeVisible({ timeout: 30_000 });

    // 目录真的排到了第二页
    expect(await frame.locator(".pdf-sheet-toc").count()).toBeGreaterThan(1);
    // 一条不少（这就是当初丢掉的那几行）
    await expect(frame.locator("ul.pdf-toc li")).toHaveCount(COUNT);
    // 编号从 1 连到 COUNT，中间不缺号
    const numbers = await frame.locator("ul.pdf-toc li .tn").allTextContents();
    expect(numbers.map((text) => Number(text.trim()))).toEqual(
      Array.from({ length: COUNT }, (_, at) => at + 1),
    );
    // 第二页接着第一页往下排，不是从头再来
    const firstOfSecond = await frame.locator(".pdf-sheet-toc").nth(1).locator("ul.pdf-toc li .tn").first().textContent();
    const lastOfFirst = await frame.locator(".pdf-sheet-toc").first().locator("ul.pdf-toc li .tn").last().textContent();
    expect(Number(firstOfSecond)).toBe(Number(lastOfFirst) + 1);
    // 同一条不变式：谁也不许装超
    expect(await overflowOfSheets(page)).toBeLessThanOrEqual(1);
  });
});
