import { expect, test, type Page } from "@playwright/test";

/**
 * 卡面图片的加载闸门（lib/card-image-client.ts）。
 *
 * 守的是这个真实 bug：一块画廊板上十来张 2 MB 的图一起开下，浏览器对同一个源只有
 * 6 条 HTTP/1.1 连接，切板要的 `GET /api/boards/:id` 只能排在图片后面 ——
 * 5 Mbit/s 上实测要等 **15 秒**，用户看到的就是「图还在转，点别的画板没反应」。
 *
 * 所以这里断言的是机制本身（并发上限 + 离场取消），不是某个时长：
 * 时长跟着机器和网速走，机制不跟。
 */

const HEADERS = { "content-type": "application/json", "x-auth-key": "e2e-token" };
/** 1×1 PNG：字节多少不重要，这里量的是「同时开几条」 */
const DOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const isPreview = (url: string) => /\/api\/uploads\/[^/]+\/preview/.test(url);

async function makeBoard(page: Page, name: string): Promise<string> {
  const res = await (await page.request.post("/api/boards", { headers: HEADERS, data: { name } })).json();
  return res.board.id as string;
}

/** 摆一块「一屏装得下的图片墙」：每张图独立上传，URL 各不相同（同一个 URL 浏览器会合并成一个请求） */
async function fillWithImages(page: Page, boardId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const upload = await (
      await page.request.post("/api/uploads", {
        headers: { "content-type": "image/png", "x-file-name": `dot-${i}.png`, "x-auth-key": "e2e-token" },
        data: DOT,
      })
    ).json();
    await page.request.post(`/api/boards/${boardId}/cards`, {
      headers: HEADERS,
      data: {
        type: "image",
        title: `图 ${i}`,
        x: 40 + (i % 4) * 240,
        y: 40 + Math.floor(i / 4) * 200,
        w: 200,
        h: 160,
        file: { uploadId: upload.upload.id, name: `dot-${i}.png`, kind: "image" },
      },
    });
  }
}

test.describe("卡面图片的加载闸门", () => {
  test("同时最多三张在路上，切板时在途的当场取消", async ({ page }) => {
    const wall = await makeBoard(page, `E2E-图墙-${Date.now() % 100000}`);
    const other = await makeBoard(page, `E2E-另一块-${Date.now() % 100000}`);
    await fillWithImages(page, wall, 9);

    // 把每张图拖慢，好稳定地看住「同时几条在路上」（真实世界里慢的是网，不是服务端）
    let inflight = 0;
    let peak = 0;
    let started = 0;
    let aborted = 0;
    await page.route(/\/api\/uploads\/[^/]+\/preview/, async (route) => {
      await new Promise((done) => setTimeout(done, 1500));
      // 图片已经被取消（切板 / 划出视野）时 continue 会抛，属正常路径
      await route.continue().catch(() => {});
    });
    page.on("request", (r) => { if (isPreview(r.url())) { inflight += 1; started += 1; peak = Math.max(peak, inflight); } });
    page.on("requestfinished", (r) => { if (isPreview(r.url())) inflight -= 1; });
    page.on("requestfailed", (r) => { if (isPreview(r.url())) { inflight -= 1; aborted += 1; } });

    await page.goto(`/?board=${wall}`);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect.poll(() => started, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(2000);

    // ① 闸门：九张图不会一起上路，同源连接得给应用自己的请求留着
    expect(peak).toBeLessThanOrEqual(3);
    expect(started).toBeLessThan(9);

    // ② 离场即取消：光把 <img> 从 DOM 上删掉不够，Chrome 会把那张图默默下完、连接照占
    const inflightBeforeSwitch = inflight;
    expect(inflightBeforeSwitch).toBeGreaterThan(0);
    await page.locator(`[data-board-id="${other}"]`).click();
    await expect(page.locator(".board-item.active")).toHaveAttribute("data-board-id", other);
    await expect.poll(() => aborted, { timeout: 10_000 }).toBeGreaterThanOrEqual(inflightBeforeSwitch);
  });

  test("闸门放行完整：一屏的图最后一张都得显示出来", async ({ page }) => {
    const wall = await makeBoard(page, `E2E-图墙全显-${Date.now() % 100000}`);
    await fillWithImages(page, wall, 6);

    await page.goto(`/?board=${wall}`);
    await expect(page.locator("img.card-img").first()).toBeVisible();
    // 六张全部真的解码出来（naturalWidth>0），且没有一张卡在闸门里
    await expect
      .poll(
        async () =>
          page.locator("img.card-img").evaluateAll((nodes) =>
            nodes.filter((node) => (node as HTMLImageElement).naturalWidth > 0).length,
          ),
        { timeout: 20_000 },
      )
      .toBe(6);
    await expect(page.locator("img.card-img.img-gated")).toHaveCount(0);
  });
});
