import { expect, test, type Page } from "@playwright/test";

async function expectReachableBar(page: Page) {
  const bar = page.locator(".node-bar");
  await expect(bar).toBeVisible();
  await expect.poll(() => bar.evaluate((element) => {
    const canvas = element.closest(".react-flow")!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    if (bounds.left < canvas.left || bounds.right > canvas.right || bounds.top < canvas.top || bounds.bottom > canvas.bottom) return false;
    return [...element.querySelectorAll("button")].every((button) => {
      const r = button.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".node-bar") === element;
    });
  })).toBe(true);
}

test("single and group shortcuts avoid the real toolbox and remain clickable after viewport resize", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("blotboard_nodebar", "1");
    localStorage.setItem("blotboard_toolbox", "0");
  });
  const headers = { "x-auth-key": "e2e-token" };
  const board = (await (await page.request.post("/api/boards", { headers, data: { name: "Toolbar obstacle regression" } })).json()).board;
  const ids: string[] = [];
  for (const x of [80, 420]) {
    const response = await page.request.post(`/api/boards/${board.id}/cards`, { headers, data: { type: "text", title: `Card ${x}`, x, y: 120, w: 250, h: 130 } });
    ids.push((await response.json()).card.id);
  }
  await page.goto(`/?board=${board.id}`);
  const first = page.locator(`.react-flow__node[data-id="${ids[0]}"] .card`);
  const second = page.locator(`.react-flow__node[data-id="${ids[1]}"] .card`);
  await first.click();
  await expectReachableBar(page);
  await page.locator('.node-bar [data-color="green"]').click();
  await expect.poll(async () => {
    const current = await (await page.request.get(`/api/boards/${board.id}`)).json();
    return current.board.cards.find((card: { id: string }) => card.id === ids[0]).color;
  }).toBe("green");
  await second.click({ modifiers: ["Shift"] });
  await expect(page.locator(".node-bar .nb-count")).toHaveText("2 张");
  await expectReachableBar(page);
  await page.setViewportSize({ width: 1000, height: 800 });
  await expectReachableBar(page);
  await page.locator('.node-bar [data-color="violet"]').click();
  await expect.poll(async () => {
    const current = await (await page.request.get(`/api/boards/${board.id}`)).json();
    return current.board.cards.map((card: { color: string }) => card.color);
  }).toEqual(["violet", "violet"]);
});

test("fit view reserves the measured toolbox height through both topbar and built-in controls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem("blotboard_toolbox", "0"));
  const headers = { "x-auth-key": "e2e-token" };
  const board = (await (await page.request.post("/api/boards", { headers, data: { name: "Fit viewport obstacle regression" } })).json()).board;
  for (let i = 0; i < 18; i++) {
    await page.request.post(`/api/boards/${board.id}/cards`, { headers, data: {
      type: "text", title: `Fit card ${i}`, x: 80 + i % 3 * 350, y: 100 + Math.floor(i / 3) * 240, w: 250, h: 130,
    } });
  }
  const readGeometry = async () => {
    const current = await (await page.request.get(`/api/boards/${board.id}`)).json();
    return current.board.cards.map(({ id, x, y, w, h }: { id: string; x: number; y: number; w: number; h: number }) => ({ id, x, y, w, h }));
  };
  const before = await readGeometry();
  await page.goto(`/?board=${board.id}`);
  await expect(page.locator(".react-flow__node")).toHaveCount(18);
  const expectClearTop = async () => {
    await expect.poll(() => page.evaluate(() => {
      const tools = document.querySelector(".toolbox")!.getBoundingClientRect();
      const canvas = document.querySelector(".react-flow")!.getBoundingClientRect();
      const nodes = [...document.querySelectorAll(".react-flow__node")].map((element) => element.getBoundingClientRect());
      return nodes.every((r) => r.top >= tools.bottom + 12 && r.bottom <= canvas.bottom + 1 && r.left >= canvas.left - 1 && r.right <= canvas.right + 1);
    })).toBe(true);
  };
  await page.locator('.top-btn[aria-label="适应内容"]').click();
  await expectClearTop();
  await page.locator('.top-btn[aria-label="回到原点"]').click();
  await expect(page.locator(".zoom-label")).toHaveText("100%");
  await page.locator(".react-flow__controls-fitview").click();
  await expectClearTop();
  expect(await readGeometry()).toEqual(before);
});
