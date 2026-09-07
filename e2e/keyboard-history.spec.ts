import { expect, test, type Page } from "@playwright/test";
import { boardInputBlocked, boardKeyBlocked, historyShortcut } from "../lib/keyboard-shortcuts";

const headers = { "x-board-web": "1" };
const nativeModifier = process.platform === "darwin" ? "Meta" : "Control";

async function setup(page: Page) {
  const boardResponse = await page.request.post("/api/boards", { headers, data: { name: "Keyboard history regression" } });
  expect(boardResponse.ok()).toBe(true);
  const boardId = (await boardResponse.json()).board.id;
  const cards = [];
  for (let index = 0; index < 2; index++) {
    const response = await page.request.post(`/api/boards/${boardId}/cards`, { headers, data: { type: "text", title: `Keyboard ${index}`, content: "A text card", x: 380 + index * 380, y: 220, w: 280, h: 180 } });
    expect(response.ok()).toBe(true);
    cards.push((await response.json()).card);
  }
  await page.goto(`/?board=${boardId}`);
  await expect(page.locator(`.react-flow__node[data-id="${cards[0].id}"]`)).toBeVisible();
  return { boardId, cards };
}

async function count(page: Page, boardId: string) {
  return ((await (await page.request.get(`/api/boards/${boardId}`)).json()).board.cards as unknown[]).length;
}

async function expectCount(page: Page, boardId: string, expected: number) {
  // A successful API write can precede delivery of its response to the browser.
  // Wait for rendered state as well before sending the next normal keyboard action.
  await expect(page.locator(".react-flow__node")).toHaveCount(expected);
  await expect.poll(() => count(page, boardId)).toBe(expected);
}

async function select(page: Page, id: string) {
  await page.locator(`.react-flow__node[data-id="${id}"]`).click({ position: { x: 45, y: 25 } });
}

function trackReplay(page: Page) {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/history(?:\/|\?|$)/.test(new URL(request.url()).pathname)) writes.push(request.url());
  });
  return writes;
}

test("history shortcut mapping handles both platforms without claiming unrelated chords", () => {
  const key = (key: string, more = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...more });
  expect(historyShortcut(key("z", { ctrlKey: true }))).toBe("undo");
  expect(historyShortcut(key("Z", { metaKey: true }))).toBe("undo");
  expect(historyShortcut(key("Z", { ctrlKey: true, shiftKey: true }))).toBe("redo");
  expect(historyShortcut(key("z", { metaKey: true, shiftKey: true }))).toBe("redo");
  expect(historyShortcut(key("y", { ctrlKey: true }))).toBe("redo");
  for (const event of [key("z"), key("z", { ctrlKey: true, altKey: true }), key("y", { metaKey: true }), key("y", { ctrlKey: true, shiftKey: true })]) expect(historyShortcut(event)).toBeNull();
});

test("keyboard ownership rejects composition, consumed events and embedded/modal contexts", () => {
  const doc = { activeElement: null, querySelector: () => null } as unknown as Document;
  const event = { target: null, defaultPrevented: false, isComposing: false, keyCode: 0, altKey: false, composedPath: () => [] } as unknown as KeyboardEvent;
  expect(boardKeyBlocked(event, {}, doc)).toBe(false);
  for (const change of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }, { altKey: true }]) expect(boardKeyBlocked({ ...event, ...change } as KeyboardEvent, {}, doc)).toBe(true);
  for (const state of [{ drawer: "pdf" }, { drawer: "mindmap" }, { drawer: "read" }, { drawer: "excalidraw" }, { compareIds: ["a", "b"] }, { editingCardId: "a" }, { viewMode: "outline" }]) expect(boardInputBlocked(null, state, doc)).toBe(true);
  expect(boardInputBlocked(null, {}, { ...doc, activeElement: { tagName: "IFRAME" } } as unknown as Document)).toBe(true);
});

for (const modifier of ["Control", "Meta"]) {
  test(`${modifier} undo and shift-redo restore a deleted card through the persistent board history`, async ({ page }) => {
    const { boardId, cards } = await setup(page);
    await select(page, cards[0].id);
    await page.keyboard.press("Delete");
    await expectCount(page, boardId, 1);
    await page.keyboard.press(`${modifier}+z`);
    await expectCount(page, boardId, 2);
    await page.keyboard.press(`${modifier}+Shift+z`);
    await expectCount(page, boardId, 1);
    await page.keyboard.press(`${modifier}+z`);
    await expectCount(page, boardId, 2);
    await page.reload();
    await expect(page.locator(`.react-flow__node[data-id="${cards[0].id}"]`)).toBeVisible();
    await page.keyboard.press(modifier === "Control" ? "Control+y" : "Meta+Shift+z");
    await expectCount(page, boardId, 1);
  });
}

test("card editor keeps native text undo and does not replay board history", async ({ page }) => {
  const { boardId, cards } = await setup(page);
  const writes = trackReplay(page);
  await page.locator(`.react-flow__node[data-id="${cards[0].id}"]`).dblclick({ position: { x: 60, y: 25 } });
  const title = page.locator('.editor input[data-field="title"]').last();
  await expect(title).toBeVisible();
  for (const [field, original] of [[title, "Keyboard 0"], [page.locator('.editor textarea[data-field="content"]').last(), "A text card"]] as const) {
    await field.focus();
    await field.press("End");
    await page.keyboard.type(" appended");
    await expect(field).toHaveValue(`${original} appended`);
    await page.keyboard.press(`${nativeModifier}+z`);
    await expect.poll(async () => (await field.inputValue()).length).toBeLessThan(`${original} appended`.length);
    // Chromium may group controlled textarea typing character-by-character.
    for (let step = 0; step < 12 && await field.inputValue() !== original; step++) {
      await page.keyboard.press(`${nativeModifier}+z`);
    }
    await expect(field).toHaveValue(original);
  }
  await title.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", isComposing: true, bubbles: true, cancelable: true })));
  await expect(title).toBeVisible();
  expect(await count(page, boardId)).toBe(2);
  expect(writes).toEqual([]);
});

test("contenteditable descendants retain native edit, copy, paste and tool keys", async ({ page }) => {
  const { boardId, cards } = await setup(page);
  await select(page, cards[0].id);
  const writes = trackReplay(page);
  await page.evaluate(() => {
    const editor = document.createElement("div");
    editor.id = "keyboard-editable";
    editor.contentEditable = "true";
    editor.style.cssText = "position:fixed;top:100px;left:100px;background:white;z-index:9999;padding:20px";
    editor.innerHTML = "<span>Original</span>";
    document.body.append(editor);
  });
  const editable = page.locator("#keyboard-editable");
  await editable.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" vh");
  await expect(editable).toHaveText("Original vh");
  await expect(page.locator(".canvas-wrap")).toHaveClass(/tool-select/);
  await page.keyboard.press(`${nativeModifier}+z`);
  await expect(editable).toHaveText("Original");
  const prevented = await editable.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "https://example.org/editor-paste");
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    (element.querySelector("span") || element).dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  expect(await count(page, boardId)).toBe(2);
  expect(writes).toEqual([]);
});

test("shortcut help and focused iframe cannot mutate the board behind them", async ({ page }) => {
  const { boardId, cards } = await setup(page);
  await select(page, cards[0].id);
  const writes = trackReplay(page);
  await page.getByRole("button", { name: "快捷键与手势", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "快捷键与手势" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Ctrl Y");
  for (const key of ["Delete", "Control+z", "Meta+z", "h"]) await page.keyboard.press(key);
  expect(await count(page, boardId)).toBe(2);
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "关闭快捷键帮助" }).click();
  await expect(dialog).not.toBeVisible();
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "keyboard-frame";
    frame.srcdoc = '<input aria-label="Embedded editor" value="original">';
    frame.style.cssText = "position:fixed;top:100px;left:100px;z-index:9999;background:white";
    document.body.append(frame);
  });
  const input = page.frameLocator("#keyboard-frame").getByRole("textbox", { name: "Embedded editor" });
  await input.click();
  await page.keyboard.type("vh");
  await page.keyboard.press(`${nativeModifier}+z`);
  await expect(page.locator(".canvas-wrap")).toHaveClass(/tool-select/);
  expect(await count(page, boardId)).toBe(2);
  expect(writes).toEqual([]);
});

test("canvas search, tool switching, selection clearing and help remain discoverable", async ({ page }) => {
  const { cards } = await setup(page);
  await select(page, cards[0].id);
  await page.keyboard.press("h");
  await expect(page.locator(".canvas-wrap")).toHaveClass(/tool-pan/);
  await page.keyboard.press("v");
  await expect(page.locator(".canvas-wrap")).toHaveClass(/tool-select/);
  await page.keyboard.press("Control+a");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  await page.keyboard.press("Control+f");
  await expect(page.locator('.search-bar input')).toBeFocused();
  await page.locator('.search-bar input').blur();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "快捷键与手势" })).toBeVisible();
});

test("history drawer permits only history chords while preserving editing and modal ownership", () => {
  const target = { closest: (selector: string) => [".drawer", ".history-drawer"].includes(selector) ? {} : null } as unknown as EventTarget;
  const doc = { activeElement: null, querySelector: () => null } as unknown as Document;
  const base = { target, key: "z", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, isComposing: false, keyCode: 0, composedPath: () => [] } as unknown as KeyboardEvent;
  const state = { drawer: "history" };
  expect(boardKeyBlocked(base, state, doc)).toBe(false);
  expect(boardKeyBlocked({ ...base, shiftKey: true } as KeyboardEvent, state, doc)).toBe(false);
  expect(boardKeyBlocked({ ...base, key: "y" } as KeyboardEvent, state, doc)).toBe(false);
  for (const key of ["Delete", "Backspace", "h", "c", "f"]) expect(boardKeyBlocked({ ...base, key } as KeyboardEvent, state, doc)).toBe(true);
  expect(boardInputBlocked(target, state, doc)).toBe(true); // Paste stays blocked.
  expect(boardKeyBlocked({ ...base, isComposing: true } as KeyboardEvent, state, doc)).toBe(true);
  expect(boardKeyBlocked(base, { drawer: "comments" }, doc)).toBe(true);
  expect(boardKeyBlocked({ ...base, target: { isContentEditable: true, closest: (target as unknown as { closest: unknown }).closest } } as unknown as KeyboardEvent, state, doc)).toBe(true);
  expect(boardKeyBlocked(base, state, { ...doc, querySelector: () => ({}) } as unknown as Document)).toBe(true);
});

test("undo can continue by keyboard after clicking a history button without enabling drawer deletion", async ({ page }) => {
  const { boardId, cards } = await setup(page);
  await page.locator(".topbar").getByRole("button", { name: /^历史/ }).click();
  const drawer = page.locator(".history-drawer.open");
  await expect(drawer).toBeVisible();
  const undo = drawer.locator('[data-act="history-undo"]');
  const redo = drawer.locator('[data-act="history-redo"]');
  await expect(undo).toBeEnabled();
  await undo.click();
  await expectCount(page, boardId, 1);
  await expect(undo).toBeEnabled();
  await undo.focus();
  await page.keyboard.press("Control+z");
  await expectCount(page, boardId, 0);
  await expect(redo).toBeEnabled();
  await redo.focus();
  await page.keyboard.press("Control+y");
  await expectCount(page, boardId, 1);
  await expect(redo).toBeEnabled();
  await redo.focus();
  await page.keyboard.press("Meta+Shift+z");
  await expectCount(page, boardId, 2);
  await select(page, cards[0].id);
  await expect(page.locator(`.react-flow__node[data-id="${cards[0].id}"]`)).toHaveClass(/selected/);
  // Moving focus to the drawer must not expose the selected card to Delete.
  const writes = trackReplay(page);
  await undo.focus();
  for (const key of ["Delete", "Backspace", "h"]) await page.keyboard.press(key);
  await expect(page.locator(".canvas-wrap")).toHaveClass(/tool-select/);
  expect(await count(page, boardId)).toBe(2);
  expect(writes).toEqual([]);
});

test("toast undo advances the persistent cursor so keyboard redo can delete again", async ({ page }) => {
  const { boardId, cards } = await setup(page);
  await select(page, cards[0].id);
  await page.keyboard.press("Delete");
  await expectCount(page, boardId, 1);
  await page.locator(".toast-action").click();
  await expectCount(page, boardId, 2);
  await page.locator(`.react-flow__node[data-id="${cards[0].id}"]`).click({ position: { x: 45, y: 25 } });
  await page.keyboard.press("Control+Shift+z");
  await expectCount(page, boardId, 1);
  await page.keyboard.press("Meta+z");
  await expectCount(page, boardId, 2);
  await page.keyboard.press("Meta+Shift+z");
  await expectCount(page, boardId, 1);
});

test("undo waits for an in-flight delete response and completes without a second shortcut", async ({ page }) => {
  const { boardId, cards } = await setup(page);
  let signalDeleted!: () => void;
  let releaseResponse!: () => void;
  const deleted = new Promise<void>((resolve) => { signalDeleted = resolve; });
  const release = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route(`**/api/boards/${boardId}/cards/${cards[0].id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const response = await route.fetch();
    signalDeleted();
    await release;
    await route.fulfill({ response });
  });
  const writes = trackReplay(page);
  try {
    await select(page, cards[0].id);
    await page.keyboard.press("Delete");
    await deleted;
    expect(await count(page, boardId)).toBe(1); // Server wrote, client is still awaiting its response.
    await page.keyboard.press("Control+z");
    expect(writes).toEqual([]);
    releaseResponse();
    await expectCount(page, boardId, 2);
    await expect.poll(() => writes.length).toBe(1);
    await expect(page.locator(".toast.show")).toContainText("已撤销");
  } finally {
    releaseResponse();
  }
});

test("Space owns temporary canvas panning without taking native button or input activation", async ({ page }) => {
  const { boardId, cards } = await setup(page);
  await select(page, cards[0].id);
  const before = (await (await page.request.get(`/api/boards/${boardId}`)).json()).board;
  const canvas = page.locator(".canvas-wrap");
  await page.keyboard.down("Space");
  await expect(canvas).toHaveClass(/tool-pan/);
  const node = page.locator(`.react-flow__node[data-id="${cards[0].id}"]`);
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 95, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect(canvas).toHaveClass(/tool-select/);
  await expect.poll(async () => {
    const saved = (await (await page.request.get(`/api/boards/${boardId}`)).json()).board;
    return JSON.stringify(saved.viewport);
  }).not.toBe(JSON.stringify(before.viewport));
  const board = (await (await page.request.get(`/api/boards/${boardId}`)).json()).board;
  expect(board.cards.map((card: { id: string; x: number; y: number }) => [card.id, card.x, card.y])).toEqual(cards.map((card) => [card.id, card.x, card.y]));

  await page.keyboard.down("Space");
  await expect(canvas).toHaveClass(/tool-pan/);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(canvas).toHaveClass(/tool-select/);
  await page.keyboard.up("Space");

  // Native Space activates the focused help button instead of dragging the board.
  await page.getByRole("button", { name: "快捷键与手势", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("dialog", { name: "快捷键与手势" })).toBeVisible();
  await expect(canvas).toHaveClass(/tool-select/);
  await page.getByRole("button", { name: "关闭快捷键帮助" }).click();
  const input = page.locator(".search-bar input");
  await input.fill("a");
  await input.press("End");
  await page.keyboard.press("Space");
  await expect(input).toHaveValue("a ");
  await expect(canvas).toHaveClass(/tool-select/);
});
