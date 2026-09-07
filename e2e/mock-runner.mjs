#!/usr/bin/env node
/** E2E 用的 Goal Agent Runner 替身：只实现画板会用到的那几个端点。 */
import http from "node:http";

const port = Number(process.argv[2] || 8442);
const TOKEN = "e2e-token";
let issueCount = 0;
/** 存一份 Issue：画板的回推（PATCH）要能被 GET 出来验，否则测不了「同步过去的是哪一版」 */
const issues = new Map();

const server = http.createServer(async (req, res) => {
  const send = (code, data) => {
    const body = JSON.stringify(data);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  if (req.url === "/healthz") return send(200, { ok: true });
  if (req.headers["x-auth-key"] !== TOKEN) return send(401, { ok: false });
  const readBody = async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  };
  if (req.url === "/api/capabilities") return send(200, { service: "goal-agent" });
  if (req.url === "/api/issues" && req.method === "POST") {
    issueCount += 1;
    const body = await readBody();
    const issue = {
      id: `issue-${issueCount}`,
      identifier: `ISSUE-${900 + issueCount}`,
      status: "inbox",
      labels: body.labels || [],
      title: body.title,
      description: body.description || "",
      priority: body.priority || "none",
    };
    issues.set(issue.id, issue);
    return send(201, { ok: true, issue });
  }
  const one = /^\/api\/issues\/(issue-\d+)$/.exec(req.url);
  if (one && req.method === "GET") {
    const issue = issues.get(one[1]);
    return issue ? send(200, { ok: true, issue }) : send(404, { ok: false, error: "Issue 不存在" });
  }
  // 画板 → Issue 的回推（编辑保存后自动同步）
  if (one && req.method === "PATCH") {
    const body = await readBody();
    const issue = { ...(issues.get(one[1]) || { id: one[1], identifier: one[1] }), ...body };
    issues.set(one[1], issue);
    return send(200, { ok: true, issue });
  }
  const launch = /^\/api\/issues\/(issue-\d+)\/launch$/.exec(req.url);
  if (launch && req.method === "POST") {
    const body = await readBody();
    return send(201, { ok: true, sessionId: `task-${launch[1]}`, mode: body.mode });
  }
  const task = /^\/api\/tasks\/([\w.-]+)$/.exec(req.url);
  if (task && req.method === "GET") {
    return send(200, { ok: true, task: { id: task[1], status: "running", summary: "e2e mock：任务执行中", updatedAt: Date.now() } });
  }
  if (req.url === "/api/tasks" && req.method === "POST") {
    await readBody();
    return send(201, { ok: true, task: { id: "task-dispatch-e2e" } });
  }
  return send(404, { ok: false });
});

server.listen(port, "127.0.0.1", () => console.log(`[mock-runner] ${port}`));
