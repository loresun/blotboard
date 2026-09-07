import { expect, test, type Page } from "@playwright/test";
import { alignCards, tidyBoard } from "../lib/layout";
import { computeAlignSnap, computeResizeSnap, frameSnapTargets, ALIGN_SNAP_TOLERANCE, type SnapRect } from "../lib/align-snap";
import { CARD_SIZE_LIMITS, SNAP_GRID } from "../lib/constants";
import type { BoardCard } from "../lib/types";

const card = (id: string, x: number, y: number, w: number, h: number): BoardCard =>
  ({ id, type: "text", x, y, w, h } as BoardCard);
const rect = (id: string, x: number, y: number, w = 151, h = 81): SnapRect => ({ id, x, y, w, h });

// These run through Playwright's TS loader but need neither browser nor a running service.
test.describe("geometry numerical", () => {
  test("all six alignments preserve exact mixed odd/even dimensions", () => {
    const cards = [card("a", 103, 57, 260, 150), card("b", 429, 286, 151, 81), card("c", 764, 494, 223, 137)];
    const metrics = {
      left: (c: BoardCard) => c.x,
      right: (c: BoardCard) => c.x + c.w,
      hcenter: (c: BoardCard) => c.x + c.w / 2,
      top: (c: BoardCard) => c.y,
      bottom: (c: BoardCard) => c.y + c.h,
      vcenter: (c: BoardCard) => c.y + c.h / 2,
    };
    for (const [action, metric] of Object.entries(metrics)) {
      const positions = alignCards(cards, action as keyof typeof metrics);
      const values = cards.map((c) => metric({ ...c, ...positions.find((p) => p.id === c.id) }));
      expect(values[1]).toBeCloseTo(values[0], 9);
      expect(values[2]).toBeCloseTo(values[0], 9);
      expect(values[0] % SNAP_GRID).toBe(0);
    }
  });

  test("horizontal and vertical distribution preserve fractional gaps", () => {
    const cards = [card("a", 103, 57, 260, 150), card("b", 429, 286, 151, 81), card("c", 764, 494, 222, 137), card("d", 1030, 811, 167, 93)];
    for (const action of ["hspace", "vspace"] as const) {
      const horizontal = action === "hspace";
      const positions = alignCards(cards, action);
      const after = cards.map((c) => ({ ...c, ...positions.find((p) => p.id === c.id) }));
      const gaps = after.slice(1).map((c, i) => horizontal ? c.x - after[i].x - after[i].w : c.y - after[i].y - after[i].h);
      for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 9);
    }
  });

  test("tidy preserves mixed-width centers after grid alignment", () => {
    const cards = [card("a", 100, 50, 260, 151), card("b", 155, 400, 151, 100), card("c", 119, 760, 223, 133)];
    const positions = tidyBoard(cards, []);
    const centers = cards.map((c) => positions.find((p) => p.id === c.id)!.x + c.w / 2);
    expect(new Set(centers).size).toBe(1);
    expect(centers[0] % SNAP_GRID).toBe(0);
  });

  test("crossing reduction preserves destination row centers when it reorders cards", () => {
    const cols = [80, 470, 860];
    const cards = Array.from({ length: 9 }, (_, i) => card(`c${i}`, cols[i % 3] + (i % 2 ? 23 : -19), 60 + Math.floor(i / 3) * 230 + (i % 3 ? 17 : -13), 280, 170));
    const edges = [[0, 4], [1, 3], [2, 5], [3, 7], [4, 6], [5, 8]].map(([a, b]) => ({ id: `${a}-${b}`, from: `c${a}`, to: `c${b}` }));
    const positions = tidyBoard(cards, edges as Parameters<typeof tidyBoard>[1]);
    expect(new Set(positions.map((p) => p.x)).size).toBe(3);
    expect(new Set(positions.map((p) => p.y)).size).toBe(3);
    for (const p of positions) {
      const c = cards.find((c) => c.id === p.id)!;
      expect((p.x + c.w / 2) % SNAP_GRID).toBe(0);
      expect((p.y + c.h / 2) % SNAP_GRID).toBe(0);
    }
  });

  test("tidy guarantees separation after quantization and dense collision solving", () => {
    let seed = 51;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
    for (let round = 0; round < 8; round++) {
      const cards = Array.from({ length: 26 }, (_, i) => card(`c${i}`, Math.floor(random() * 400), Math.floor(random() * 350), 140 + Math.floor(random() * 420), 80 + Math.floor(random() * 350)));
      const positions = tidyBoard(cards, []);
      const after = cards.map((c) => ({ ...c, ...positions.find((p) => p.id === c.id) }));
      for (let i = 0; i < after.length; i++) for (let j = i + 1; j < after.length; j++) {
        const a = after[i], b = after[j];
        const gap = 28 - 1e-6;
        expect(a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y).toBe(false);
      }
    }
  });

  test("edge, center and edge-to-edge snap precisely", () => {
    const target = rect("target", 100, 100, 260, 150);
    for (const [x, expected] of [[212, 209], [157.5, 154.5], [363, 360]]) {
      const moving = rect("moving", x, 400);
      const result = computeAlignSnap(moving, [target], 6);
      expect(x + result.dx).toBe(expected);
      expect(result.guides.some((g) => g.axis === "x")).toBe(true);
    }
  });

  test("snap radius stays six screen pixels across zooms", () => {
    for (const zoom of [0.25, 0.5, 1, 2]) {
      const target = rect("target", 100, 100, 260, 150);
      const near = rect("moving", 209 + 5 / zoom, 400);
      const far = rect("moving", 209 + 7 / zoom, 400);
      expect(near.x + computeAlignSnap(near, [target], ALIGN_SNAP_TOLERANCE / zoom).dx).toBeCloseTo(209);
      expect(computeAlignSnap(far, [target], ALIGN_SNAP_TOLERANCE / zoom).dx).toBe(0);
    }
  });

  test("equal gaps extend both ways and insert between neighbors", () => {
    const targets = [rect("a", 100, 100, 150, 80), rect("b", 300, 100, 170, 80)];
    for (const [x, w, expected] of [[523, 140, 520], [-87, 140, -90]]) {
      const result = computeAlignSnap(rect("moving", x, 100, w, 80), targets, 6);
      expect(x + result.dx).toBe(expected);
      const gaps = result.guides.filter((g) => g.kind === "gap" && g.axis === "x");
      expect(gaps).toHaveLength(2);
      expect(gaps[0].x2 - gaps[0].x1).toBe(gaps[1].x2 - gaps[1].x1);
    }
    const inserted = computeAlignSnap(rect("moving", 278, 100, 150, 80), [rect("a", 100, 100, 150, 80), rect("b", 450, 100, 170, 80)], 6);
    expect(278 + inserted.dx).toBe(275);
  });

  test("gap extensions do not pull a card into an existing neighbor", () => {
    const result = computeAlignSnap(rect("moving", 523, 100, 140, 80), [rect("a", 100, 100, 150, 80), rect("b", 300, 100, 170, 80), rect("c", 590, 100, 160, 80)], 6);
    expect(result.guides.filter((g) => g.kind === "gap" && g.axis === "x")).toHaveLength(0);
  });

  test("resizing snaps the dragged edge to a neighbor edge, and the center at half speed", () => {
    const target = rect("target", 100, 100, 260, 150); // 三条线：100 / 230 / 360
    // 拉右边贴上目标的右边缘：只改宽度，左边缘不动
    const edge = computeResizeSnap(rect("moving", 220, 400, 137, 80), { right: true }, [target], 6);
    expect([edge.dx, edge.dw]).toEqual([0, 3]);
    expect(edge.guides.map((g) => [g.kind, g.axis, g.x1])).toEqual([["edge", "x", 360]]);
    // 中线只跟着走一半，所以手上要挪两倍：中线差 1.5px → 宽度改 3px
    const center = computeResizeSnap(rect("moving", 160, 400, 137, 80), { right: true }, [target], 6);
    expect([center.dx, center.dw]).toEqual([0, 3]);
    expect(center.guides.map((g) => [g.kind, g.axis, g.x1])).toEqual([["center", "x", 230]]);
    // 中线差得再多一点（手上要挪 7px > 6px 容差）就不该再吸——不然会「猛地缩一下」
    expect(computeResizeSnap(rect("moving", 160, 400, 133, 80), { right: true }, [target], 6).dw).toBe(0);
  });

  test("dragging the start edge moves coordinate and size together, leaving the far edge still", () => {
    const target = rect("target", 100, 100, 260, 150);
    const result = computeResizeSnap(rect("moving", 363, 400, 140, 80), { left: true }, [target], 6);
    expect([result.dx, result.dw]).toEqual([-3, 3]);
    // 右边缘 503 纹丝不动，左边缘落到 360
    expect(363 + result.dx).toBe(360);
    expect(363 + result.dx + 140 + result.dw).toBe(503);
    // 只拉横边时纵轴一个字节都不改
    expect([result.dy, result.dh]).toEqual([0, 0]);
    const corner = computeResizeSnap(rect("moving", 363, 254, 140, 80), { left: true, top: true }, [target], 6);
    expect([corner.dx, corner.dy]).toEqual([-3, -4]); // 斜角把手两条轴各解各的
    expect(corner.guides.map((g) => g.axis).sort()).toEqual(["x", "y"]);
  });

  test("resize snapping never pushes a card past the handle size limits", () => {
    const target = rect("target", 100, 100, 260, 150); // 右边缘 360
    const width = CARD_SIZE_LIMITS.minW + 2;
    // 往外拉 3px 贴上目标右边缘：宽度 152 → 155，没碰到上下限
    expect(computeResizeSnap(rect("grow", 205, 400, width, 80), { right: true }, [target], 6, CARD_SIZE_LIMITS).dw).toBe(3);
    // 同样 3px，改成拉左边就要吃掉 3px 宽度 → 跌破手柄下限，这条轴整轴放弃
    const shrink = computeResizeSnap(rect("shrink", 357, 400, width, 80), { left: true }, [target], 6, CARD_SIZE_LIMITS);
    expect([shrink.dx, shrink.dw, shrink.guides.length]).toEqual([0, 0, 0]);
    // 不给上下限时它照吸不误——限制是调用方的事，纯计算不自己发明数字
    expect(computeResizeSnap(rect("shrink", 357, 400, width, 80), { left: true }, [target], 6).dw).toBe(-3);
  });

  test("resizing keeps out of equal-gap snapping, which only answers where a whole card sits", () => {
    const targets = [rect("a", 100, 100, 150, 80), rect("b", 300, 100, 170, 80)];
    // 同一个矩形拖动时会被等距吸走（见上一个用例），拉边时不该有任何反应
    expect(computeAlignSnap(rect("moving", 523, 100, 140, 80), targets, 6).dx).toBe(-3);
    const resized = computeResizeSnap(rect("moving", 523, 100, 140, 80), { right: true }, targets, 6);
    expect([resized.dw, resized.guides.length]).toEqual([0, 0]);
  });

  test("frame boundaries and title-safe inner padding do not become gap mates", () => {
    const frame = rect("frame", 100, 100, 500, 500);
    const moving = rect("moving", 125, 147, 151, 81);
    const targets = frameSnapTargets(frame, moving);
    const result = computeAlignSnap(moving, targets, 6);
    expect(moving.x + result.dx).toBe(100 + SNAP_GRID);
    expect(moving.y + result.dy).toBe(100 + SNAP_GRID * 2);
    expect(result.guides.every((g) => g.kind !== "gap")).toBe(true);
    expect(frameSnapTargets(frame, moving, true)).toHaveLength(1);
    expect(frameSnapTargets(frame, rect("outside", 800, 800))).toHaveLength(1);
  });
});

const headers = { "x-auth-key": "e2e-token" };
async function setup(page: Page, entries: Partial<BoardCard>[], zoom = 1, grid = false) {
  await page.setViewportSize({ width: 1600, height: 1100 });
  const made = await page.request.post("/api/boards", { headers, data: { name: `Geometry-${Date.now()}` } });
  expect(made.ok()).toBe(true);
  const id = (await made.json()).board.id as string;
  const created: BoardCard[] = [];
  for (const entry of entries) {
    const response = await page.request.post(`/api/boards/${id}/cards`, { headers, data: { type: "text", ...entry } });
    expect(response.ok()).toBe(true);
    created.push((await response.json()).card);
  }
  await page.request.put(`/api/boards/${id}/state`, { headers, data: { viewport: { x: 0, y: 0, zoom } } });
  await page.addInitScript(({ grid }) => {
    localStorage.setItem("blotboard_snap", grid ? "1" : "0");
    localStorage.setItem("blotboard_align_snap", "1");
  }, { grid });
  await page.goto(`/?board=${id}`);
  await expect(page.locator(".react-flow__node")).toHaveCount(entries.length);
  return { id, created, read: async () => (await (await page.request.get(`/api/boards/${id}`)).json()).board.cards as BoardCard[] };
}
async function dragTo(page: Page, moving: BoardCard, x: number, y: number) {
  const box = (await page.locator(`.react-flow__node[data-id="${moving.id}"]`).boundingBox())!;
  const zoom = box.width / moving.w;
  const start = { x: box.x + box.width / 2, y: box.y + 16 * zoom };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // RF 在越过拖动阈值的第一帧建立抓取点；先越过阈值，后续位移才从这里计算。
  await page.mouse.move(start.x + 5, start.y);
  await page.mouse.move(start.x + 5 + (x - moving.x) * zoom, start.y + (y - moving.y) * zoom, { steps: 16 });
}

/** 从卡片右下角的缩放手柄拉到「宽 w 高 h」（画布坐标）。 */
async function resizeTo(page: Page, card: BoardCard, w: number, h: number) {
  await page.locator(`.react-flow__node[data-id="${card.id}"]`).click();
  const handle = page.locator(`.react-flow__node[data-id="${card.id}"] .react-flow__resize-control.bottom.right.handle`);
  await expect(handle).toBeVisible();
  const box = (await page.locator(`.react-flow__node[data-id="${card.id}"]`).boundingBox())!;
  const zoom = box.width / card.w;
  const corner = { x: box.x + box.width, y: box.y + box.height };
  await page.mouse.move(corner.x - 2, corner.y - 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + (w - card.w) * zoom, corner.y + (h - card.h) * zoom, { steps: 12 });
}

test.describe("geometry browser", () => {
  for (const grid of [false, true]) test(`neighbor snap survives mouse release, reload, and grid=${grid}`, async ({ page }) => {
    const setupBoard = await setup(page, [
      { title: "Reference", x: 100, y: 80, w: 261, h: 151 },
      { title: "Moving", x: 380, y: 330, w: 151, h: 81 },
    ], grid ? 2 : 1, grid);
    const moving = setupBoard.created[1];
    await dragTo(page, moving, 212, 330);
    await expect(page.locator(".align-guides")).toBeVisible();
    await expect.poll(() => page.locator(".align-guides line").count()).toBeGreaterThan(0);
    const during = (await page.locator(`.react-flow__node[data-id="${moving.id}"]`).boundingBox())!;
    const reference = (await page.locator(`.react-flow__node[data-id="${setupBoard.created[0].id}"]`).boundingBox())!;
    expect(during.x + during.width).toBeCloseTo(reference.x + reference.width, 1);
    await page.mouse.up();
    await expect(page.locator(".align-guides")).toHaveCount(0);
    await expect.poll(async () => (await setupBoard.read()).find((c) => c.id === moving.id)!.x).toBe(210);
    await page.reload();
    const after = (await page.locator(`.react-flow__node[data-id="${moving.id}"]`).boundingBox())!;
    expect(after.x + after.width).toBeCloseTo(reference.x + reference.width, 1);
  });

  test("dragging a frame snaps its boundary and preserves child offsets after reload", async ({ page }) => {
    const board = await setup(page, [
      { type: "frame", title: "Frame", x: 100, y: 120, w: 400, h: 300 },
      { title: "Child", x: 122, y: 190, w: 151, h: 81 },
      { title: "Reference", x: 620, y: 100, w: 151, h: 81 },
    ]);
    const [frame, child] = board.created;
    const patch = await page.request.patch(`/api/boards/${board.id}/cards/${child.id}`, { headers, data: { frameId: frame.id } });
    expect(patch.ok()).toBe(true);
    await page.reload();
    await dragTo(page, frame, 374, 120);
    await page.mouse.up();
    await expect.poll(async () => (await board.read()).find((c) => c.id === frame.id)!.x).toBe(371);
    const after = await board.read();
    expect(after.find((c) => c.id === child.id)!.x).toBe(393);
    expect(after.find((c) => c.id === child.id)!.frameId).toBe(frame.id);
    await page.reload();
    const frameBox = (await page.locator(`.react-flow__node[data-id="${frame.id}"]`).boundingBox())!;
    const childBox = (await page.locator(`.react-flow__node[data-id="${child.id}"]`).boundingBox())!;
    expect(childBox.x - frameBox.x).toBeCloseTo(22, 1);
  });

  test("a child uses absolute frame inset lines and persists relative coordinates correctly", async ({ page }) => {
    const board = await setup(page, [
      { type: "frame", title: "Frame", x: 100, y: 100, w: 500, h: 500 },
      { title: "Child", x: 400, y: 250, w: 151, h: 81 },
    ]);
    const [frame, child] = board.created;
    await page.request.patch(`/api/boards/${board.id}/cards/${child.id}`, { headers, data: { frameId: frame.id } });
    await page.reload();
    await dragTo(page, child, 125, 250);
    await page.mouse.up();
    await expect.poll(async () => (await board.read()).find((c) => c.id === child.id)!.x).toBe(122);
    expect((await board.read()).find((c) => c.id === child.id)!.frameId).toBe(frame.id);
  });

  test("multi-selection snaps its bounding box without changing internal offsets", async ({ page }) => {
    const board = await setup(page, [
      { title: "Reference", x: 500, y: 80, w: 261, h: 151 },
      { title: "First", x: 100, y: 330, w: 151, h: 81 },
      { title: "Second", x: 310, y: 500, w: 140, h: 101 },
    ]);
    const [, first, second] = board.created;
    const firstBox = (await page.locator(`.react-flow__node[data-id="${first.id}"]`).boundingBox())!;
    const secondBox = (await page.locator(`.react-flow__node[data-id="${second.id}"]`).boundingBox())!;
    // 拖选才会打开 RF 的整组包围盒；Shift 点选只选节点，不一定生成 selection rect。
    await page.mouse.move(firstBox.x - 15, firstBox.y - 15);
    await page.mouse.down();
    await page.mouse.move(secondBox.x + secondBox.width + 15, secondBox.y + secondBox.height + 15, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
    const selection = page.locator(".react-flow__nodesselection-rect");
    await expect(selection).toBeVisible();
    const box = (await selection.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 35, box.y + box.height / 2);
    await page.mouse.move(box.x + 35 + 314, box.y + box.height / 2, { steps: 16 });
    await page.mouse.up();
    await expect.poll(async () => (await board.read()).find((c) => c.id === first.id)!.x).toBe(411);
    const after = await board.read();
    const a = after.find((c) => c.id === first.id)!, b = after.find((c) => c.id === second.id)!;
    expect(b.x - a.x).toBe(210);
    expect(b.y - a.y).toBe(170);
    expect(b.x + b.w).toBe(761);
  });

  test("resizing a card snaps its dragged edges to neighbors and keeps the far corner still", async ({ page }) => {
    const board = await setup(page, [
      { title: "Reference", x: 100, y: 80, w: 261, h: 151 },
      { title: "Moving", x: 100, y: 300, w: 151, h: 81 },
    ]);
    const [reference, moving] = board.created;
    // 右边缘拉到差 3px 的地方：该吸上参照卡的右边缘（361），而不是停在 358
    await resizeTo(page, moving, 258, 120);
    await expect(page.locator(".align-guides")).toBeVisible();
    await expect.poll(() => page.locator(".align-guides line").count()).toBeGreaterThan(0);
    const during = (await page.locator(`.react-flow__node[data-id="${moving.id}"]`).boundingBox())!;
    const referenceBox = (await page.locator(`.react-flow__node[data-id="${reference.id}"]`).boundingBox())!;
    expect(during.x + during.width).toBeCloseTo(referenceBox.x + referenceBox.width, 1);
    // 松手不该弹回原始尺寸：落库的是吸附后的宽度，左上角一动没动
    await page.mouse.up();
    await expect(page.locator(".align-guides")).toHaveCount(0);
    await expect.poll(async () => (await board.read()).find((c) => c.id === moving.id)!.w).toBe(261);
    const after = (await board.read()).find((c) => c.id === moving.id)!;
    expect([after.x, after.y]).toEqual([100, 300]);
    // 刷新后两条右边缘还是同一条线。两张卡一起量：刷新后的视口动画没停时，
    // 先后量到的绝对像素会差半个身位，比的是「它们之间」而不是跟旧数字比。
    await page.reload();
    await expect.poll(async () => {
      const one = (await page.locator(`.react-flow__node[data-id="${moving.id}"]`).boundingBox())!;
      const other = (await page.locator(`.react-flow__node[data-id="${reference.id}"]`).boundingBox())!;
      return Math.round(one.x + one.width - other.x - other.width);
    }).toBe(0);
  });

  test("resizing a frame snaps its edge without disturbing the cards inside it", async ({ page }) => {
    const board = await setup(page, [
      { type: "frame", title: "Frame", x: 110, y: 120, w: 400, h: 300 },
      { title: "Child", x: 132, y: 190, w: 151, h: 81 },
      { title: "Reference", x: 597, y: 600, w: 151, h: 81 }, // 左边缘 597，右边缘 748
    ]);
    const [frame, child, reference] = board.created;
    await page.request.patch(`/api/boards/${board.id}/cards/${child.id}`, { headers, data: { frameId: frame.id } });
    await page.reload();
    // 框的右边缘 510 → 拉到 594，差 3px 就到参照卡的左边缘 597
    await resizeTo(page, frame, 484, 300);
    await page.mouse.up();
    await expect.poll(async () => (await board.read()).find((c) => c.id === frame.id)!.w).toBe(487);
    const after = await board.read();
    // 拉的是右下角：框的左上角与框里的卡都不该动
    expect(after.find((c) => c.id === frame.id)!.x).toBe(110);
    expect([after.find((c) => c.id === child.id)!.x, after.find((c) => c.id === child.id)!.frameId]).toEqual([132, frame.id]);
    expect(after.find((c) => c.id === reference.id)!.x).toBe(597);
  });

  test("with no neighbor in reach, the dragged edge falls back to the grid", async ({ page }) => {
    // 开着网格 + 邻居对齐，板上只有一张卡：没有参照物，两条边都该退回 22px 刻度
    const board = await setup(page, [{ title: "Alone", x: 110, y: 110, w: 151, h: 101 }], 1, true);
    const [alone] = board.created;
    await resizeTo(page, alone, 210, 160);
    await page.mouse.up();
    await expect.poll(async () => (await board.read()).find((c) => c.id === alone.id)!.w).toBeGreaterThan(151);
    const after = (await board.read()).find((c) => c.id === alone.id)!;
    // 拉的是右下角：两条边都落在刻度上，左上角一动没动
    expect([(after.x + after.w) % SNAP_GRID, (after.y + after.h) % SNAP_GRID]).toEqual([0, 0]);
    expect([after.x, after.y]).toEqual([110, 110]);
    expect(after.h).toBeGreaterThan(101);
  });

  test("children of collapsed frames never attract visible cards", async ({ page }) => {
    const board = await setup(page, [
      { type: "frame", title: "Collapsed", x: 100, y: 100, w: 500, h: 500 },
      { title: "Hidden", x: 125, y: 250, w: 151, h: 81 },
      { title: "Moving", x: 450, y: 750, w: 151, h: 81 },
    ]);
    const [frame, child, moving] = board.created;
    await page.request.patch(`/api/boards/${board.id}/cards/${child.id}`, { headers, data: { frameId: frame.id } });
    await page.request.patch(`/api/boards/${board.id}/cards/${frame.id}`, { headers, data: { frame: { collapsed: true } } });
    await page.reload();
    await expect(page.locator(`.react-flow__node[data-id="${child.id}"]`)).toHaveCount(0);
    await dragTo(page, moving, 128, 750);
    await page.mouse.up();
    await expect.poll(async () => (await board.read()).find((c) => c.id === moving.id)!.x).toBe(128);
  });

});
