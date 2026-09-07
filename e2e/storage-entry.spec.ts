import { expect, test, type Page } from '@playwright/test';
import { browserAgentPrompt, serverAgentPrompt } from '../lib/agent-onboarding';

async function captureClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as unknown as { copiedText: string }).copiedText = text; },
    } });
  });
}

test('storage-first landing creates and rediscovers named browser workspaces', async ({ page, baseURL }) => {
  await captureClipboard(page);
  const name = `research-${Date.now()}`;
  await page.goto('/start');
  await expect(page.getByRole('heading', { name: /同一张画板/ })).toBeVisible();
  await expect(page.getByRole('link', { name: '进入服务端画板' })).toHaveAttribute('href', '/?storage=server');

  await page.getByLabel('新 workspace 名称').fill(name);
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(page.getByRole('link', { name: `进入「${name}」` })).toHaveAttribute('href', `/?storage=browser&workspace=${name}`);
  await page.getByRole('button', { name: '复制 CDP Agent 提示词', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toBe(browserAgentPrompt(baseURL!, name));

  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  await page.getByRole('button', { name: '复制服务端 Agent 提示词', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toBe(serverAgentPrompt(baseURL!));
});

test('data-directory reveal is a protected write action and never returns a path to strangers', async ({ request }) => {
  const anonymous = await request.post('/api/storage/reveal');
  expect(anonymous.status()).toBe(403);
  expect(await anonymous.text()).not.toMatch(/\/Users\/|\/home\//);
  const forged = await request.post('/api/storage/reveal', {
    headers: { 'x-board-web': '1', origin: 'https://attacker.invalid' },
  });
  expect(forged.status()).toBe(403);
  expect(await forged.text()).not.toMatch(/\/Users\/|\/home\//);
});
