import { expect, test, type APIRequestContext } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const headers = { 'x-auth-key': 'e2e-token' };
async function newBoard(request: APIRequestContext, name: string) {
  const response = await request.post('/api/boards', { headers, data: { name } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).board.id as string;
}
async function board(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/boards/${id}`)).json()).board;
}
async function history(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/boards/${id}/history`)).json()).history;
}
async function step(request: APIRequestContext, id: string, action: 'undo' | 'redo') {
  const latest = await board(request, id);
  const response = await request.post(`/api/boards/${id}/history`, { headers: { ...headers, 'x-board-since': String(latest.updatedAt) }, data: { action } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function add(request: APIRequestContext, id: string, payload: Record<string, unknown>) {
  const response = await request.post(`/api/boards/${id}/cards`, { headers, data: { type: 'text', ...payload } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).card;
}
const geometry = (value: any) => value.cards.map((c: any) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h }));

test('three different layouts undo and redo independently and survive reload of history state', async ({ request, page }) => {
  const id = await newBoard(request, 'history layout chain');
  const a = await add(request, id, { title: 'idea', x: 603, y: 412, w: 281, h: 151 });
  const b = await add(request, id, { type: 'task', title: 'task', x: 11, y: 891, task: { status: 'idea' } });
  const c = await add(request, id, { type: 'quote', title: 'quote', x: 951, y: 83, w: 403, h: 211 });
  await request.post(`/api/boards/${id}/edges`, { headers, data: { from: a.id, to: b.id } });
  await request.post(`/api/boards/${id}/edges`, { headers, data: { from: b.id, to: c.id } });
  const snapshots = [geometry(await board(request, id))];
  const count = (await history(request, id)).entries.length;
  for (const mode of ['grid', 'LR', 'kanban']) {
    const response = await request.post(`/api/boards/${id}/tidy`, { headers, data: { mode } });
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).changed).toBeGreaterThan(0);
    snapshots.push(geometry(await board(request, id)));
  }
  expect((await history(request, id)).entries.length).toBe(count + 3);
  for (let i = 2; i >= 0; i--) expect(geometry((await step(request, id, 'undo')).board)).toEqual(snapshots[i]);
  await page.goto(`/?board=${id}`);
  await page.reload();
  expect((await history(request, id)).canRedo).toBe(true);
  for (let i = 1; i <= 3; i++) expect(geometry((await step(request, id, 'redo')).board)).toEqual(snapshots[i]);
  expect((await history(request, id)).canRedo).toBe(false);
});

test('same-card saves coalesce, a new edit truncates redo, and viewport changes do not record steps', async ({ request }) => {
  const id = await newBoard(request, 'history coalescing');
  const card = await add(request, id, { title: 'original' });
  const initial = (await history(request, id)).entries.length;
  for (const title of ['draft one', 'draft two']) {
    expect((await request.patch(`/api/boards/${id}/cards/${card.id}`, { headers, data: { title } })).ok()).toBeTruthy();
  }
  expect((await history(request, id)).entries.length).toBe(initial + 1);
  expect((await step(request, id, 'undo')).board.cards[0].title).toBe('original');
  expect((await step(request, id, 'redo')).board.cards[0].title).toBe('draft two');
  await step(request, id, 'undo');
  await request.patch(`/api/boards/${id}/cards/${card.id}`, { headers, data: { content: 'new branch' } });
  const branched = await history(request, id);
  expect(branched.canRedo).toBe(false);
  await request.put(`/api/boards/${id}/state`, { headers, data: { viewport: { x: 817, y: -41, zoom: 0.7 } } });
  expect((await history(request, id)).entries).toEqual(branched.entries);
});

test('deleting a card restores its original ID, linked edges, comments and unknown fields in one undo', async ({ request }) => {
  const id = await newBoard(request, 'history delete graph');
  const a = await add(request, id, { title: 'a' }), b = await add(request, id, { title: 'b' });
  await request.post(`/api/boards/${id}/edges`, { headers, data: { from: a.id, to: b.id } });
  await request.post(`/api/boards/${id}/comments`, { headers, data: { target: 'card', targetId: a.id, text: 'keep comment' } });
  const before = await board(request, id);
  expect((await request.delete(`/api/boards/${id}/cards/${a.id}`, { headers })).ok()).toBeTruthy();
  const restored = (await step(request, id, 'undo')).board;
  expect(restored.cards.map((c: any) => c.id)).toEqual(before.cards.map((c: any) => c.id));
  expect(restored.edges).toEqual(before.edges);
  expect(restored.comments).toEqual(before.comments);
  await step(request, id, 'redo');
  expect((await board(request, id)).cards.map((c: any) => c.id)).toEqual([b.id]);
});

test('history requests require auth, valid action and fresh monotonically increasing revision', async ({ request }) => {
  const id = await newBoard(request, 'history versions');
  const card = await add(request, id, { title: 'old' });
  const initial = await board(request, id);
  const versions = [initial.updatedAt];
  for (let i = 0; i < 6; i++) {
    await request.patch(`/api/boards/${id}/cards/${card.id}`, { headers, data: { title: `v${i}` } });
    versions.push((await board(request, id)).updatedAt);
  }
  versions.slice(1).forEach((version, i) => expect(version).toBeGreaterThan(versions[i]));
  const endpoint = `/api/boards/${id}/history`;
  expect((await request.post(endpoint, { data: { action: 'undo' } })).status()).toBe(403);
  expect((await request.post(endpoint, { headers, data: { action: 'undo' } })).status()).toBe(400);
  expect((await request.post(endpoint, { headers, data: { action: 'invalid' } })).status()).toBe(400);
  expect((await request.post(endpoint, { headers: { ...headers, 'x-board-since': String(initial.updatedAt) }, data: { action: 'undo' } })).status()).toBe(409);
  expect((await board(request, id)).cards[0].title).toBe('v5');
});

test('geometry history stores changed fields instead of repeating unchanged large card content and is bounded', async ({ request }) => {
  const id = await newBoard(request, 'history bounds');
  const content = 'unchanged-body-'.repeat(2000);
  const card = await add(request, id, { title: 'large body', content });
  for (let i = 1; i <= 105; i++) {
    const response = await request.put(`/api/boards/${id}/state`, { headers, data: { cards: [{ id: card.id, x: i * 31, y: i * 7 }] } });
    expect(response.ok()).toBeTruthy();
  }
  const state = await history(request, id);
  expect(state.entries).toHaveLength(100);
  const file = path.join(process.env.E2E_DATA_DIR || path.join(os.tmpdir(), 'blotboard-e2e'), 'history', `${id}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  expect(Buffer.byteLength(raw)).toBeLessThan(8 * 1024 * 1024);
  expect(raw).not.toContain('unchanged-body-');
  expect(JSON.parse(raw).cursor).toBe(100);
});

test('task linkage is a history boundary while later edits and deleted references remain reversible', async ({ request }) => {
  const id = await newBoard(request, 'history task boundary');
  const task = await add(request, id, { type: 'task', title: 'linked task', task: { goal: 'keep issue truthful' } });
  const issue = await request.post(`/api/boards/${id}/cards/${task.id}/issue`, { headers });
  expect(issue.ok(), await issue.text()).toBeTruthy();
  const linked = (await board(request, id)).cards[0];
  expect(linked.task.issueId).toBeTruthy();
  const boundary = await history(request, id);
  expect(boundary.canUndo).toBe(false);
  expect(boundary.warning).toContain('任务');
  await request.patch(`/api/boards/${id}/cards/${task.id}`, { headers, data: { title: 'later edit' } });
  const undone = (await step(request, id, 'undo')).board.cards[0];
  expect(undone.title).toBe('linked task');
  expect(undone.task.issueId).toBe(linked.task.issueId);
  await request.delete(`/api/boards/${id}/cards/${task.id}`, { headers });
  const restored = (await step(request, id, 'undo')).board.cards[0];
  expect(restored.id).toBe(task.id);
  expect(restored.task.issueId).toBe(linked.task.issueId);
});


test('undo refuses a parent restoration that would create a cross-board cycle', async ({ request }) => {
  const a = await newBoard(request, 'history parent a'), b = await newBoard(request, 'history parent b');
  await request.patch(`/api/boards/${a}`, { headers, data: { parentId: b } });
  await request.patch(`/api/boards/${a}`, { headers, data: { parentId: null } });
  await request.patch(`/api/boards/${b}`, { headers, data: { parentId: a } });
  const current = await board(request, a);
  const response = await request.post(`/api/boards/${a}/history`, { headers: { ...headers, 'x-board-since': String(current.updatedAt) }, data: { action: 'undo' } });
  expect(response.status()).toBe(409);
  expect((await board(request, a)).parentId).toBeNull();
  expect((await board(request, b)).parentId).toBe(a);
});

test('layout toast remains reversible after automatic fit-view saves the viewport', async ({ request, page }) => {
  const id = await newBoard(request, 'history layout camera');
  await add(request, id, { title: 'left', x: 301, y: 140, w: 281, h: 151 });
  await add(request, id, { title: 'right', x: 5400, y: 3200, w: 403, h: 211 });
  const before = geometry(await board(request, id));
  await page.goto(`/?board=${id}`);
  await expect(page.locator('.board-item.active .bi-name')).toHaveText('history layout camera');
  await page.locator('.top-btn', { hasText: '整理' }).click();
  await page.locator('.layout-menu').getByText('网格铺开', { exact: true }).click();
  await expect(page.locator('.toast.show')).toContainText('已网格铺开');
  // Observe the real 60ms fit / animation / 600ms autosave chain, not a fixed sleep.
  await page.waitForResponse((response) => response.url().endsWith(`/api/boards/${id}/state`) && response.request().method() === 'PUT' && Boolean(response.request().postDataJSON()?.viewport) && response.ok());
  const arranged = geometry(await board(request, id));
  expect(arranged).not.toEqual(before);
  await page.locator('.toast-action').click();
  await expect.poll(async () => geometry(await board(request, id))).toEqual(before);
  const pane = await page.locator('.react-flow__pane').boundingBox();
  await page.locator('.react-flow__pane').click({ position: { x: pane!.width * 0.45, y: pane!.height * 0.7 } });
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => geometry(await board(request, id))).toEqual(arranged);
});
