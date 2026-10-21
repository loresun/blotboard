import { expect, test } from "@playwright/test";

const HEADERS = { "x-auth-key": "e2e-token" };
const SORT_KEY = "blotboard.sidebar.sort";

test("左栏按时间、名称排序，保持分组和父子层级，刷新后保留选择", async ({ page }) => {
  const prefix = `E2E-排序-${Date.now()}`;
  const ids: string[] = [];
  async function create(name: string, group = `${prefix}-A`, parentId?: string) {
    const response = await page.request.post("/api/boards", { headers: HEADERS, data: { name: `${prefix}-${name}`, group, parentId } });
    expect(response.ok()).toBeTruthy();
    const { board } = await response.json();
    ids.push(board.id);
    return board;
  }
  try {
    const ten = await create("画板10");
    const two = await create("画板2");
    const one = await create("画板1");
    const childTen = await create("子板10", undefined, ten.id);
    const childTwo = await create("子板2", undefined, ten.id);
    const other = await create("另一组", `${prefix}-B`);
    const ungrouped = await create("未分组", "");
    await page.goto(`/?board=${ten.id}`);
    await expect(page.locator(".board-item.active")).toHaveAttribute("data-board-id", ten.id);
    await page.getByPlaceholder("搜画板名 / 分组 / 卡片内容").fill(prefix);
    const rows = page.locator(".board-list .board-item");
    const order = () => rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-board-id")));
    const field = page.getByRole("combobox", { name: "画板排序", exact: true });
    const direction = page.getByRole("combobox", { name: "排序方向", exact: true });

    await expect(direction).toBeDisabled();
    await expect.poll(order).toEqual([one.id, two.id, ten.id, childTwo.id, childTen.id, other.id, ungrouped.id]);
    await field.selectOption("name");
    await expect(direction).toHaveValue("asc");
    await expect.poll(order).toEqual([one.id, two.id, ten.id, childTwo.id, childTen.id, other.id, ungrouped.id]);
    await direction.selectOption("desc");
    await expect.poll(order).toEqual([other.id, ten.id, childTen.id, childTwo.id, two.id, one.id, ungrouped.id]);

    await field.selectOption("created");
    await expect.poll(order).toEqual([other.id, one.id, two.id, ten.id, childTwo.id, childTen.id, ungrouped.id]);
    await direction.selectOption("asc");
    await expect.poll(order).toEqual([ten.id, childTen.id, childTwo.id, two.id, one.id, other.id, ungrouped.id]);

    // 修改最老的根板：修改排序要用真实的新 revision，不能仍按创建顺序。
    const renamed = `${prefix}-画板10-已修改`;
    const modified = await page.request.patch(`/api/boards/${ten.id}`, { headers: HEADERS, data: { name: renamed } });
    expect(modified.ok()).toBeTruthy();
    await page.reload();
    await expect(field).toHaveValue("created");
    await expect(direction).toHaveValue("asc");
    await page.getByPlaceholder("搜画板名 / 分组 / 卡片内容").fill(prefix);
    await field.selectOption("updated");
    await expect.poll(order).toEqual([ten.id, childTwo.id, childTen.id, one.id, two.id, other.id, ungrouped.id]);
    await page.reload();
    await expect(field).toHaveValue("updated");
    await expect(direction).toHaveValue("desc");
    await page.getByPlaceholder("搜画板名 / 分组 / 卡片内容").fill(prefix);
    await expect.poll(order).toEqual([ten.id, childTwo.id, childTen.id, one.id, two.id, other.id, ungrouped.id]);
    await field.selectOption("default");
    await expect.poll(order).toEqual([one.id, two.id, ten.id, childTwo.id, childTen.id, other.id, ungrouped.id]);
    // 排序只是本机偏好，不会重排服务端存储。
    const list = await (await page.request.get("/api/boards")).json();
    expect(list.boards.filter((board: { id: string }) => ids.includes(board.id)).map((board: { id: string }) => board.id))
      .toEqual([ungrouped.id, other.id, childTwo.id, childTen.id, one.id, two.id, ten.id]);
  } finally {
    for (const id of ids.reverse()) await page.request.delete(`/api/boards/${id}`, { headers: HEADERS });
  }
});

test("损坏或不可写的排序偏好不妨碍开板与临时排序", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "{broken-json");
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("Blocked", "QuotaExceededError");
      return write.call(this, name, value);
    };
  }, SORT_KEY);
  await page.goto("/");
  const field = page.getByRole("combobox", { name: "画板排序", exact: true });
  await expect(field).toHaveValue("default");
  await field.selectOption("name");
  await expect(field).toHaveValue("name");
  await expect(page.getByRole("combobox", { name: "排序方向", exact: true })).toHaveValue("asc");
  await expect(page.locator(".board-item.active")).toBeVisible();
});

test("分组本身跟随名称和时间排序，隐藏子板的修改时间也会更新分组位置", async ({ page }) => {
  const prefix = `E2E-组序-${Date.now()}`;
  const ids: string[] = [];
  async function create(name: string, group: string, parentId?: string) {
    const response = await page.request.post("/api/boards", { headers: HEADERS, data: { name, group: `${prefix}-${group}`, parentId } });
    expect(response.ok()).toBeTruthy();
    const { board } = await response.json();
    ids.push(board.id);
    return board.id as string;
  }
  try {
    const ten = await create(`Root-${prefix}-10`, "Group10");
    const two = await create(`Root-${prefix}-2`, "Group2");
    const twenty = await create(`Root-${prefix}-20`, "Group20");
    const child = await create(`Hidden-${prefix}`, "Group10", ten);
    await page.goto(`/?board=${two}`);
    await expect(page.locator(".board-item.active")).toHaveAttribute("data-board-id", two);
    const search = page.getByPlaceholder("搜画板名 / 分组 / 卡片内容");
    await search.fill(`Root-${prefix}`);
    const roots = () => page.locator(".board-group .board-item").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-board-id")));
    const field = page.getByRole("combobox", { name: "画板排序", exact: true });
    const direction = page.getByRole("combobox", { name: "排序方向", exact: true });
    await expect.poll(roots).toEqual([ten, two, twenty]);
    await field.selectOption("name");
    await expect.poll(roots).toEqual([two, ten, twenty]);
    await direction.selectOption("desc");
    await expect.poll(roots).toEqual([twenty, ten, two]);
    await field.selectOption("created");
    await expect.poll(roots).toEqual([ten, twenty, two]);
    await direction.selectOption("asc");
    await expect.poll(roots).toEqual([two, twenty, ten]);
    await field.selectOption("updated");
    await expect.poll(roots).toEqual([ten, twenty, two]);
    // 新修改让 Group2 到最前；再改不可见的子板，让 Group10 回到最前。
    expect((await page.request.patch(`/api/boards/${two}`, { headers: HEADERS, data: { name: `Root-${prefix}-2-edited` } })).ok()).toBeTruthy();
    await page.reload();
    await search.fill(`Root-${prefix}`);
    await expect.poll(roots).toEqual([two, ten, twenty]);
    expect((await page.request.patch(`/api/boards/${child}`, { headers: HEADERS, data: { name: `Hidden-${prefix}-edited` } })).ok()).toBeTruthy();
    await page.reload();
    await search.fill(`Root-${prefix}`);
    await expect.poll(roots).toEqual([ten, two, twenty]);
    await field.selectOption("default");
    await expect.poll(roots).toEqual([ten, two, twenty]);
  } finally {
    for (const id of ids.reverse()) await page.request.delete(`/api/boards/${id}`, { headers: HEADERS });
  }
});

test("英文界面与浏览器库也能排序，最窄侧栏不溢出", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "blotboard.locale", value: "en", url: baseURL! }]);
  await page.addInitScript(() => localStorage.setItem("blotboard_sidebar_w", "200"));
  await page.goto(`/?storage=browser&workspace=sidebar-sort-${Date.now()}`);
  await expect(page.locator(".board-item.active")).toBeVisible();
  for (const name of ["SortBoard10", "SortBoard2", "SortBoard1"]) {
    await page.locator(".new-board-btn").click();
    await page.locator(".board-name").fill(name);
    await page.locator(".board-name").press("Enter");
    await expect(page.locator(".board-item.active .bi-name")).toHaveText(name);
  }
  await page.getByPlaceholder("Search board names, groups, card contents").fill("SortBoard");
  const field = page.getByRole("combobox", { name: "Board sort", exact: true });
  await field.selectOption("name");
  await expect(page.locator(".board-list .bi-name")).toHaveText(["SortBoard1", "SortBoard2", "SortBoard10"]);
  await page.getByRole("combobox", { name: "Sort direction", exact: true }).selectOption("desc");
  await expect(page.locator(".board-list .bi-name")).toHaveText(["SortBoard10", "SortBoard2", "SortBoard1"]);
  expect(await field.evaluate((element) => {
    const row = element.parentElement!;
    return row.scrollWidth <= row.clientWidth;
  })).toBeTruthy();
  await page.reload();
  await expect(field).toHaveValue("name");
  await expect(page.getByRole("combobox", { name: "Sort direction", exact: true })).toHaveValue("desc");
  // 只有一个未分组区时，也不能折叠成一片无法点开的空白。
  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(page.locator(".board-list .board-item")).toHaveCount(0);
  await expect(page.locator(".group-head-row")).toContainText("Ungrouped");
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(page.locator(".board-item.active")).toBeVisible();
});

test("全部折叠与展开覆盖所有分组、嵌套子板和卡片类型分组，搜索结果不被隐藏", async ({ page }) => {
  const prefix = `E2E-折叠-${Date.now()}`;
  const ids: string[] = [];
  async function create(name: string, group: string, parentId?: string) {
    const response = await page.request.post("/api/boards", { headers: HEADERS, data: { name: `${prefix}-${name}`, group, parentId } });
    expect(response.ok()).toBeTruthy();
    const { board } = await response.json();
    ids.push(board.id);
    return board.id as string;
  }
  try {
    const parent = await create("父板", `${prefix}-A`);
    const child = await create("子板", `${prefix}-A`, parent);
    const grandchild = await create("孙板", `${prefix}-A`, child);
    await create("另一组", `${prefix}-B`);
    for (const type of ["text", "todo"]) {
      const response = await page.request.post(`/api/boards/${parent}/cards`, { headers: HEADERS, data: { type, title: `${prefix}-${type}` } });
      expect(response.ok()).toBeTruthy();
    }
    await page.goto(`/?board=${parent}`);
    await expect(page.locator(".board-item.active")).toHaveAttribute("data-board-id", parent);
    const collapse = page.getByRole("button", { name: "全部折叠", exact: true });
    const expand = page.getByRole("button", { name: "全部展开", exact: true });
    await collapse.click();
    await expect(page.locator(".board-list .board-item")).toHaveCount(0);
    const group = page.locator(".board-group").filter({ has: page.locator(".group-head-row", { hasText: `${prefix}-A` }) });
    await group.locator(".card-group-head").click();
    await expect(group.locator(".board-item")).toHaveCount(1);
    await page.locator(`[data-board-id="${parent}"]`).getByTitle("展开子画板").click();
    await expect(page.locator(`[data-board-id="${child}"]`)).toBeVisible();
    await expect(page.locator(`[data-board-id="${grandchild}"]`)).toHaveCount(0);
    await expand.click();
    await expect(page.locator(`[data-board-id="${grandchild}"]`)).toBeVisible();
    await collapse.click();

    const search = page.getByPlaceholder("搜画板名 / 分组 / 卡片内容");
    await search.fill(prefix);
    await expect(collapse).toBeDisabled();
    await expect(expand).toBeDisabled();
    await expect(page.locator(`[data-board-id="${grandchild}"]`)).toBeVisible();
    await search.clear();
    await expect(collapse).toBeEnabled();
    await page.locator(".react-flow__node").last().click();
    await page.locator(".aside-tabs > button").nth(1).click();
    await expect(page.locator(".card-item")).toHaveCount(2);
    await expect(page.locator(".card-item.active")).toHaveCount(1);
    await collapse.click();
    await expect(page.locator(".card-item")).toHaveCount(0);
    await expect(page.locator(".card-group-head")).toHaveCount(2);
    await expand.click();
    await expect(page.locator(".card-item")).toHaveCount(2);
  } finally {
    for (const id of ids.reverse()) await page.request.delete(`/api/boards/${id}`, { headers: HEADERS });
  }
});
