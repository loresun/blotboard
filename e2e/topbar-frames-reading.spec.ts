import { expect, test, type Page } from "@playwright/test";

/**
 * 三件事的回归，它们的共同点是「界面在**边界情况**下还能不能用」：
 *
 * ① **顶栏窄屏**：以前顶栏里的按钮全是 `flex:none`，放不下就直接挤出可视区——
 *    778px 宽的窗口上「阅读 / 导出 / 设置 / Agent」四颗按钮站在屏幕外面，整页还多一条横向滚动条。
 *    现在改成量出来的收纳档位，放不下的整批进「更多」。这一节按宽度扫一遍，只断言两件事：
 *    **没有横向溢出** + **收起来的命令在「更多」里找得到**。
 * ② **分组框的显式收纳**：几何上圈住了、`frameId` 还是空的那些卡，只在用户点了那颗按钮时才归属。
 * ③ **阅读顺序的三个把手**：章节（框）、跳过、显式序号，且不设时与从前一致。
 */

const AUTH = { "x-auth-key": "e2e-token" };

/** 顶栏里所有「实际渲染出来的可点元素」都在可视区内，且页面没有被撑出横向滚动条 */
async function expectNoOverflow(page: Page, label: string) {
  const report = await page.evaluate(() => {
    const bar = document.querySelector(".topbar") as HTMLElement | null;
    if (!bar) return { ok: false, why: "没有顶栏", detail: "" };
    const overflow = [...bar.querySelectorAll<HTMLElement>(".top-btn, .sn-item, .storage-mode-chip, .board-name, .sidebar-btn, .tool-switch button, .zoom-box button")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.right > window.innerWidth + 0.5 || box.left < -0.5);
      })
      .map((element) => (element.textContent || element.className).trim().slice(0, 12));
    return {
      ok: overflow.length === 0 && bar.scrollWidth <= bar.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1,
      why: "",
      detail: `档位=${bar.dataset.compact} 顶栏=${bar.scrollWidth}/${bar.clientWidth} 文档=${document.documentElement.scrollWidth}/${window.innerWidth} 越界=${overflow.join(",")}`,
    };
  });
  expect(report.ok, `${label}：${report.why}${report.detail}`).toBe(true);
}

/** 这个命令要么还在顶栏上，要么在「更多」菜单里——两者必居其一，不能凭空消失 */
async function expectCommandReachable(page: Page, name: string) {
  const onBar = page.locator(".topbar .top-group .top-btn", { hasText: name });
  if (await onBar.count()) {
    await expect(onBar.first()).toBeVisible();
    return;
  }
  const more = page.locator(".topbar .more-btn");
  await expect(more, `顶栏上没有「${name}」，也没有「更多」`).toHaveCount(1);
  await more.click();
  await expect(page.locator(".more-menu .cm-label", { hasText: name }).first()).toBeVisible();
  // 再点一下收起来：最窄那档菜单几乎盖满屏，点画布空白会先撞上菜单自己
  await more.click();
  await expect(page.locator(".more-menu")).toHaveCount(0);
}

test.describe("顶栏窄屏收纳", () => {
  test("从 1600 到 320：顶栏不溢出，收起来的命令在「更多」里都还在", async ({ page }) => {
    const board = (await (await page.request.post("/api/boards", { headers: AUTH, data: { name: "顶栏窄屏回归" } })).json()).board;
    await page.request.post(`/api/boards/${board.id}/cards`, {
      headers: AUTH,
      data: { type: "text", title: "占位卡", x: 60, y: 60 },
    });
    await page.goto(`/?board=${board.id}`);
    await expect(page.locator(".topbar")).toBeVisible();

    for (const width of [1600, 1440, 1280, 1024, 900, 768, 600, 430, 360, 320]) {
      await page.setViewportSize({ width, height: 860 });
      // 收纳档位是量出来的：给它一帧把 ResizeObserver → 重排这一轮跑完
      await expect
        .poll(async () => page.evaluate(() => {
          const bar = document.querySelector(".topbar") as HTMLElement;
          return bar.scrollWidth <= bar.clientWidth + 1;
        }), { message: `${width}px 下顶栏仍然溢出` })
        .toBe(true);
      await expectNoOverflow(page, `${width}px`);
    }

    // 最窄那档：右边只剩「更多」，但四件事一件不少
    await expect(page.locator(".topbar .more-btn")).toHaveCount(1);
    // 「更多」不能是一张空菜单：它出现就说明真的收走了命令
    await page.locator(".topbar .more-btn").click();
    await expect(page.locator(".more-menu .cm-item").first()).toBeVisible();
    await page.locator(".topbar .more-btn").click();
    for (const name of ["阅读", "导出", "设置", "整理"]) {
      await expectCommandReachable(page, name);
    }

    // 站点导航收成一颗，点开还是全部页面（「去哪儿」在最窄的屏上也不能断）
    await page.locator(".site-nav.compact .sn-more").click();
    await expect(page.locator(".site-nav .sn-menu .sn-item")).not.toHaveCount(0);
    await expect(page.locator(".site-nav .sn-menu", { hasText: "帮助" })).toBeVisible();

    // 拉回宽屏：命令全部回到顶栏上，「更多」自己消失（1600px 上只收了「字」，一颗命令都没走）
    await page.setViewportSize({ width: 1600, height: 860 });
    for (const name of ["模板", "整理", "阅读", "导出", "评论", "设置"]) {
      await expect(page.locator(".topbar .top-group .top-btn", { hasText: name })).toBeVisible();
    }
    await expect(page.locator(".topbar .more-btn")).toHaveCount(0);
  });

  test("侧栏展开 / 收起都不影响顶栏（顶栏在主体上方，不该被它挤到）", async ({ page }) => {
    const board = (await (await page.request.post("/api/boards", { headers: AUTH, data: { name: "顶栏与侧栏" } })).json()).board;
    await page.goto(`/?board=${board.id}`);
    await expect(page.locator(".topbar")).toBeVisible();
    for (const width of [1280, 900, 480]) {
      await page.setViewportSize({ width, height: 860 });
      for (const _pass of [0, 1]) {
        await page.locator(".sidebar-btn").click();
        await page.waitForTimeout(320);
        await expectNoOverflow(page, `${width}px 切换侧栏后`);
      }
    }
  });
});

test.describe("分组框：显式收纳", () => {
  test("圈住了但归属为空的卡只在点了「收纳」之后才归属，且可撤销", async ({ page }) => {
    const board = (await (await page.request.post("/api/boards", { headers: AUTH, data: { name: "分组框收纳回归" } })).json()).board;
    const mk = async (data: Record<string, unknown>) =>
      (await (await page.request.post(`/api/boards/${board.id}/cards`, { headers: AUTH, data })).json()).card;
    // 摆在画布左上角的浮动工具箱下面：那条工具箱会挡住框头上的按钮
    const frame = await mk({ type: "frame", title: "第一阶段", x: 60, y: 360, w: 600, h: 400 });
    // 坐标落在框里，但 frameId 是空的——批量导入 / 整板改写之后最常见的形态
    await mk({ type: "text", title: "压在框里的甲", x: 120, y: 440, w: 200, h: 120 });
    await mk({ type: "text", title: "压在框里的乙", x: 380, y: 440, w: 200, h: 120 });
    await mk({ type: "text", title: "框外的丙", x: 900, y: 440, w: 200, h: 120 });

    await page.goto(`/?board=${board.id}`);
    const frameNode = page.locator(`.react-flow__node[data-id="${frame.id}"]`);
    await expect(frameNode).toBeVisible();
    // 系统自己不会认领：这时框上还是「把卡片拖进来」，服务端的归属一个字节没动
    await expect(frameNode.locator(".frame-count")).toHaveText("把卡片拖进来");
    const before = await (await page.request.get(`/api/boards/${board.id}`)).json();
    expect(before.board.cards.filter((card: { frameId?: string | null }) => card.frameId).length).toBe(0);

    // 差额摆在框上，点一下才收
    await frameNode.locator('[data-act="capture-frame"]').click();
    await expect(frameNode.locator(".frame-count")).toHaveText("2 张卡片");
    const after = await (await page.request.get(`/api/boards/${board.id}`)).json();
    const inFrame = after.board.cards.filter((card: { frameId?: string | null }) => card.frameId === frame.id);
    expect(inFrame.map((card: { title: string }) => card.title).sort()).toEqual(["压在框里的乙", "压在框里的甲"]);
    // 框外那张没被卷进来
    expect(after.board.cards.find((card: { title: string }) => card.title === "框外的丙").frameId).toBe(null);
    // 批量写的合同：动手前有一份整板快照
    const checkpoints = await (await page.request.get(`/api/boards/${board.id}/checkpoints`, { headers: AUTH })).json();
    expect(checkpoints.checkpoints.length).toBeGreaterThan(0);

    // 撤销回到「一张都不归属」
    await page.locator(".toast button", { hasText: "撤销" }).click();
    await expect.poll(async () => {
      const now = await (await page.request.get(`/api/boards/${board.id}`)).json();
      return now.board.cards.filter((card: { frameId?: string | null }) => card.frameId === frame.id).length;
    }).toBe(0);
  });
});

test.describe("连线标签的可读性", () => {
  test("同一对卡片之间的两条线：标签不叠在一起，也不压在线身上", async ({ page }) => {
    const board = (await (await page.request.post("/api/boards", { headers: AUTH, data: { name: "连线标签回归" } })).json()).board;
    const mk = async (data: Record<string, unknown>) =>
      (await (await page.request.post(`/api/boards/${board.id}/cards`, { headers: AUTH, data })).json()).card;
    const top = await mk({ type: "text", title: "上面那张", x: 300, y: 200, w: 240, h: 140 });
    const bottom = await mk({ type: "text", title: "下面那张", x: 300, y: 520, w: 240, h: 140 });
    // 一来一回两条线：路径完全重合，标签钉在同一处就会叠成一团
    await page.request.post(`/api/boards/${board.id}/edges`, {
      headers: AUTH,
      data: { from: top.id, to: bottom.id, label: "因为限流", kind: "rel" },
    });
    await page.request.post(`/api/boards/${board.id}/edges`, {
      headers: AUTH,
      data: { from: bottom.id, to: top.id, label: "反过来也有一条", kind: "blocks" },
    });

    await page.goto(`/?board=${board.id}`);
    const labels = page.locator(".edge-label-text");
    await expect(labels).toHaveCount(2);
    const boxes = await labels.evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
      }),
    );
    const [a, b] = boxes;
    const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    expect(overlap, `两条线的标签仍然叠在一起：${JSON.stringify(boxes)}`).toBe(false);
  });
});

test.describe("阅读顺序的三个把手", () => {
  test("章节 / 跳过 / 显式序号：不设时与从前一致，设了之后目录跟着变", async ({ page }) => {
    const board = (await (await page.request.post("/api/boards", { headers: AUTH, data: { name: "阅读顺序回归" } })).json()).board;
    await page.request.put(`/api/boards/${board.id}/whole`, {
      headers: AUTH,
      data: {
        cards: [
          { id: "c_rd_frame", type: "frame", title: "第一章", x: 0, y: 0, w: 600, h: 400 },
          { id: "c_rd_a", type: "text", title: "章内甲", content: "甲", x: 40, y: 60, w: 200, h: 120, frameId: "c_rd_frame" },
          { id: "c_rd_b", type: "text", title: "章内乙", content: "乙", x: 320, y: 60, w: 200, h: 120, frameId: "c_rd_frame" },
          { id: "c_rd_side", type: "text", title: "侧边服务信息", content: "附录", x: 900, y: 40, w: 200, h: 120 },
          { id: "c_rd_last", type: "text", title: "收尾", content: "尾", x: 40, y: 900, w: 200, h: 120 },
        ],
      },
    });
    await page.goto(`/?board=${board.id}`);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();

    // 顶栏「阅读」通读整块板
    await page.locator(".top-btn", { hasText: "阅读" }).click();
    const outline = page.locator(".reader-outline .ro-item");
    await expect(outline).toHaveCount(5);
    // 章节：框排在它的成员前面，成员缩进
    await expect(outline.nth(0)).toHaveText(/第一章/);
    await expect(outline.nth(0)).toHaveClass(/chapter/);
    await expect(outline.nth(1)).toHaveText(/章内甲/);
    await expect(outline.nth(1)).toHaveClass(/nested/);
    await expect(outline.nth(2)).toHaveText(/章内乙/);

    // 跳过：翻到「侧边服务信息」，就地按一下，它退出序列并自动翻到下一张
    await page.locator(".reader-outline .ro-item", { hasText: "侧边服务信息" }).click();
    await page.locator('.reader-modal [data-act="skip"]').click();
    await expect(page.locator(".reader-outline .ro-item")).toHaveCount(4);
    await expect(page.locator(".reader-outline .ro-item", { hasText: "侧边服务信息" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // 显式序号：把「收尾」钉到最前（改的是数据，重开阅读模式立刻生效）
    await page.request.patch(`/api/boards/${board.id}/cards/c_rd_last`, {
      headers: AUTH,
      data: { reading: { order: 1 } },
    });
    await expect.poll(async () => {
      const now = await (await page.request.get(`/api/boards/${board.id}`)).json();
      return now.board.cards.find((card: { id: string }) => card.id === "c_rd_last").reading?.order;
    }).toBe(1);
    await page.reload();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page.locator(".top-btn", { hasText: "阅读" }).click();
    await expect(page.locator(".reader-outline .ro-item").nth(0)).toHaveText(/收尾/);
    // 跳过的那张仍然不在序列里；导出照旧收全板（跳过只管阅读顺序）
    await expect(page.locator(".reader-outline .ro-item")).toHaveCount(4);
    await page.keyboard.press("Escape");
    const md = await (await page.request.get(`/api/boards/${board.id}/export?format=md`)).text();
    expect(md).toContain("侧边服务信息");
  });
});
