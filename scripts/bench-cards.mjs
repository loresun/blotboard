#!/usr/bin/env node
/**
 * 性能基准数据：生成一块 N 卡画板，用来量拖拽帧率与内存（spec §7）。
 *
 *   node scripts/bench-cards.mjs --cards 200 [--base http://127.0.0.1:8567] [--name 基准-200]
 *   node scripts/bench-cards.mjs --cleanup            删掉所有 "基准-" 开头的画板
 *
 * 画板里 6 种卡片按比例混排，并连出一条长链 + 若干横向连线，
 * 逼近真实使用（大量节点 + 边同时重绘），而不是只堆纯文本卡。
 */
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const base = opt("base", "http://127.0.0.1:8567").replace(/\/+$/, "");
const total = Number(opt("cards", 200));
const cleanup = args.includes("--cleanup");

const HEADERS = { "content-type": "application/json", "x-board-web": "1" };

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: HEADERS,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `${method} ${path} → ${response.status}`);
  return data;
}

if (cleanup) {
  const { boards } = await call("GET", "/api/boards");
  const targets = boards.filter((board) => board.name.startsWith("基准-"));
  for (const board of targets) {
    await call("DELETE", `/api/boards/${board.id}`);
    console.log(`已删除 ${board.name}`);
  }
  console.log(`清理完成（${targets.length} 块）`);
  process.exit(0);
}

const name = opt("name", `基准-${total}`);
const { board } = await call("POST", "/api/boards", { name });
console.log(`画板 ${board.id}「${name}」`);

const TYPES = ["text", "text", "task", "quote", "link", "text"];
const COLUMNS = Math.ceil(Math.sqrt(total));
const cards = [];

for (let index = 0; index < total; index += 1) {
  const type = TYPES[index % TYPES.length];
  const payload = {
    type,
    title: `${type} #${index + 1}`,
    content: `第 ${index + 1} 张卡片：用于性能基准的正文，长度接近真实使用时的一两句话。`,
    x: (index % COLUMNS) * 380,
    y: Math.floor(index / COLUMNS) * 250,
    createdBy: "user",
  };
  if (type === "task") payload.task = { goal: `完成第 ${index + 1} 件事`, priority: index % 3 === 0 ? "high" : "medium" };
  if (type === "link") payload.link = { url: `https://example.com/bench/${index + 1}` };
  if (type === "quote") payload.quote = { source: `来源 ${index + 1}` };
  const { card } = await call("POST", `/api/boards/${board.id}/cards`, payload);
  cards.push(card);
  if ((index + 1) % 50 === 0) console.log(`  已建 ${index + 1}/${total}`);
}

// 长链 + 每 7 张一条横向连线
let edges = 0;
for (let index = 1; index < cards.length; index += 1) {
  await call("POST", `/api/boards/${board.id}/edges`, { from: cards[index - 1].id, to: cards[index].id });
  edges += 1;
  if (index % 7 === 0 && index + COLUMNS < cards.length) {
    await call("POST", `/api/boards/${board.id}/edges`, { from: cards[index].id, to: cards[index + COLUMNS].id, label: "跨列" });
    edges += 1;
  }
}

console.log(`完成：卡片 ${cards.length} 张 / 连线 ${edges} 条`);
console.log(`打开 ${base}/ 选「${name}」，DevTools Performance 录一段拖拽即可读帧率。`);
console.log(`清理：node scripts/bench-cards.mjs --cleanup`);
