import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentLinks, agentSkillName, boardAgentPrompt, browserAgentPrompt, serverAgentPrompt, shellQuote, skillInstallCommand } from '../lib/agent-onboarding';

async function clipboard(page: Page, fail = false) {
  await page.addInitScript(({ fail }) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        if (fail) throw new Error('clipboard denied');
        (window as unknown as { copiedText: string }).copiedText = text;
      },
    } });
    if (fail) document.execCommand = () => false;
  }, { fail });
}

async function copied(page: Page) {
  return page.evaluate(() => (window as unknown as { copiedText: string }).copiedText);
}

test('Agent installation is deployment-specific Markdown, with a minimal live guide and no credentials', async ({ request, baseURL }) => {
  const response = await request.get('/api/skill?format=install', { headers: { 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'https' } });
  expect(response.ok()).toBeTruthy();
  expect(response.headers()['content-type']).toContain('text/markdown');
  expect(response.headers()['content-disposition']).toContain('SKILL.md');
  expect(response.headers()['cache-control']).toBe('no-store');
  const invalidFocus = await request.get('/api/skill?format=install&focus=invalid');
  expect(invalidFocus.status()).toBe(400);
  const text = await response.text();
  expect(text).toMatch(/^---\nname: blotboard-[a-z0-9-]+\ndescription: /);
  expect(text).toContain(`${baseURL}/api/skill?format=md&focus=api,pitfalls,links`);
  expect(text).toContain('每次任务重新获取指南');
  expect(text).not.toContain('e2e-token');
  expect(text).not.toContain('attacker.invalid');
  expect(text).not.toMatch(/\/Users\/|\/home\//);
  const capabilities = await (await request.get('/api/capabilities')).json();
  expect(capabilities.agentOnboarding.install).toBe('/api/skill?format=install');
  const local = await request.get(`http://127.0.0.1:${process.env.E2E_LOCAL_PORT || 8443}/api/skill?format=install`);
  expect(local.ok()).toBeTruthy();
  expect(await local.text()).not.toBe(text);
});

test('/llms.txt is generated from the live deployment, without a static file, forged host or local paths', async ({ request, baseURL }) => {
  const response = await request.get('/llms.txt', { headers: { 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'https' } });
  expect(response.ok()).toBeTruthy();
  expect(response.headers()['content-type']).toContain('text/plain');
  expect(response.headers()['cache-control']).toBe('no-store');
  const text = await response.text();
  // 样例里的 base 跟着调用方访问的 host 走，伪造的转发头不算数
  expect(text).toContain(`${baseURL}/api/health`);
  expect(text).not.toContain('attacker.invalid');
  expect(text).not.toContain('e2e-token');
  expect(text).not.toMatch(/\/Users\/|\/home\//);
  // 讲的是这台部署此刻的形态：这台接了外部 Runner，另一台是内置 local 后端
  expect(text).toContain('Goal Agent Runner');
  const local = await request.get(`http://127.0.0.1:${process.env.E2E_LOCAL_PORT || 8443}/llms.txt`);
  expect(local.ok()).toBeTruthy();
  const localText = await local.text();
  expect(localText).toContain('内置 local');
  expect(localText).not.toBe(text);
});

test('copied installation command installs readable SKILL.md and preserves an existing file', async ({ baseURL }) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blotboard-skill-install-'));
  try {
    const command = skillInstallCommand(baseURL!, 'codex');
    execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home }, timeout: 40_000 });
    const file = path.join(home, '.agents', 'skills', agentSkillName(baseURL!), 'SKILL.md');
    const installed = fs.readFileSync(file, 'utf8');
    expect(installed).toContain(`Deployment: ${baseURL}`);
    fs.writeFileSync(file, installed + '\nUser customization\n');
    expect(() => execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home }, stdio: 'pipe' })).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(installed + '\nUser customization\n');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['SKILL.md']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('handoff builders encode identifiers, strip URL credentials and query strings, and quote shell safely', async () => {
  const credentialUrl = new URL('https://example.org:9443/?token=hidden');
  credentialUrl.username = 'secret';
  credentialUrl.password = 'password';
  const links = agentLinks(credentialUrl.href, 'board &/?');
  expect(links.origin).toBe('https://example.org:9443');
  expect(links.board).toBe('https://example.org:9443/?board=board%20%26%2F%3F');
  expect(links.boardApi).toContain('/board%20%26%2F%3F');
  const value = "https://example.org/a'b$(printf BAD)`printf BAD`";
  expect(execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' })).toBe(value);
  expect(() => agentLinks('javascript:alert(1)')).toThrow();
  expect(agentSkillName('https://example.org')).not.toBe(agentSkillName('http://example.org'));
  expect(agentSkillName(`https://${'a'.repeat(60)}.example.org`).length).toBeLessThanOrEqual(64);
  expect(boardAgentPrompt(links.origin, 'b_test')).not.toContain('GOAL_AGENT_TOKEN');
  const cdp = browserAgentPrompt(links.origin, 'research', 'b_test');
  expect(cdp).toContain('workspace（JSON 字符串）："research"');
  expect(cdp).toContain('window.blotboardBrowser');
  expect(cdp).toContain('禁止用 /api/boards');
  expect(cdp).not.toContain('x-auth-key');
  expect(serverAgentPrompt(links.origin)).toContain('/api/skill?format=md');
  expect(serverAgentPrompt(links.origin)).not.toContain('window.blotboardBrowser');
});

test('Agent page copies board and install prompts, switches client, and exposes the current origin', async ({ page, baseURL }) => {
  await clipboard(page);
  await page.goto('/agent?board=b_agent-test');
  await expect(page.getByRole('heading', { name: '让 Agent 读懂这块服务端画板' })).toBeVisible();
  await page.getByRole('button', { name: '复制画板提示词', exact: true }).click();
  expect(await copied(page)).toBe(boardAgentPrompt(baseURL!, 'b_agent-test'));
  await page.getByRole('button', { name: '复制 Skill 安装提示词', exact: true }).click();
  expect(await copied(page)).toContain(`${baseURL}/api/skill?format=install`);
  await page.getByText('手动安装：复制终端命令', { exact: true }).click();
  await page.getByLabel('Skill 安装客户端').selectOption('claude');
  await page.getByRole('button', { name: '复制安装命令', exact: true }).click();
  expect(await copied(page)).toContain('$HOME/.claude/skills/');
  await page.getByLabel('Skill 安装客户端').selectOption('codex');
  await page.getByRole('button', { name: '复制安装命令', exact: true }).click();
  expect(await copied(page)).toContain('$HOME/.agents/skills/');
});

test('clipboard denial reports failure and leaves selectable text; no board is guessed on a direct visit', async ({ page }) => {
  await clipboard(page, true);
  await page.goto('/agent');
  await expect(page.getByRole('button', { name: '复制画板提示词', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '复制 Skill 安装提示词', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('复制失败，请选中上方文本手动复制');
  await expect(page.getByLabel('复制 Skill 安装提示词', { exact: true })).toBeVisible();
});

test('browser Agent page emits a workspace-specific CDP prompt instead of the server Skill flow', async ({ page, baseURL }) => {
  await clipboard(page);
  await page.goto('/agent?storage=browser&workspace=research-vault&board=b_browser-test');
  await expect(page.getByRole('heading', { name: '让 Agent 进入这个浏览器 workspace' })).toBeVisible();
  await page.getByRole('button', { name: '复制 CDP Agent 提示词', exact: true }).click();
  expect(await copied(page)).toBe(browserAgentPrompt(baseURL!, 'research-vault', 'b_browser-test'));
  await expect(page.getByRole('button', { name: '复制 Skill 安装提示词', exact: true })).toHaveCount(0);
  await expect(page.locator('code', { hasText: 'exportBundle()' })).toBeVisible();
});

test('canvas and sidebar hand off the correct board and navigation preserves current board context', async ({ page, request, baseURL }) => {
  await clipboard(page);
  const ids: string[] = [];
  for (const name of ['Agent current', 'Agent other']) {
    const response = await request.post('/api/boards', { headers: { 'x-auth-key': 'e2e-token' }, data: { name } });
    expect(response.ok()).toBeTruthy();
    ids.push((await response.json()).board.id);
  }
  await page.goto(`/?board=${ids[0]}`);
  await expect(page.locator('.board-item.active .bi-name')).toHaveText('Agent current');
  await expect(page.locator('.site-nav a[href^="/agent"]')).toHaveAttribute('href', `/agent?board=${ids[0]}`);
  const pane = await page.locator('.react-flow__pane').boundingBox();
  // Bottom-left contains React Flow controls; target an unobstructed point in this empty board.
  await page.locator('.react-flow__pane').click({
    button: 'right', position: { x: pane!.width * 0.45, y: pane!.height * 0.65 },
  });
  await page.getByText('复制给 Agent 的提示词', { exact: true }).click();
  expect(await copied(page)).toBe(boardAgentPrompt(baseURL!, ids[0]));
  await page.locator('.board-item').filter({ hasText: 'Agent other' }).click({ button: 'right' });
  await page.getByText('复制给 Agent 的提示词', { exact: true }).click();
  expect(await copied(page)).toBe(boardAgentPrompt(baseURL!, ids[1]));
  await expect(page.locator('.board-item.active .bi-name')).toHaveText('Agent current');
});


test('installation rejects an HTML response and removes its temporary download', async ({ baseURL }) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blotboard-skill-invalid-'));
  try {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nfor arg do dest="$arg"; done\nprintf "%s" "<html>Sign in</html>" > "$dest"\n', { mode: 0o755 });
    expect(() => execFileSync('/bin/sh', ['-c', skillInstallCommand(baseURL!, 'codex')], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe',
    })).toThrow();
    const dir = path.join(home, '.agents', 'skills', agentSkillName(baseURL!));
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
