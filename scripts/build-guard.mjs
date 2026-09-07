/** Coordinate builds and production servers sharing one checkout. No user data here. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const directory = (root) => path.join(root, ".blotboard-runtime");
const buildFile = /^build(?:-\d+-[a-f0-9-]+)?\.json$/;
const serverFile = /^server-\d+(?:-[a-f0-9-]+)?\.json$/;

function occupied(file) {
  let record;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw new Error("构建协调文件尚未就绪或已损坏；请确认没有构建/服务运行后清理 .blotboard-runtime。");
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw new Error("构建协调文件格式无效；请确认没有构建/服务运行后清理 .blotboard-runtime。");
  }
  try { process.kill(record.pid, 0); return true; }
  catch (error) {
    // Never unlink another owner's marker. Unique reservation names make dead
    // owners harmless without the read/unlink race of a shared build.json lock.
    return error.code !== "ESRCH";
  }
}

function active(root, pattern, except) {
  let entries;
  try { entries = fs.readdirSync(directory(root)); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  return entries.some((entry) => pattern.test(entry) && path.join(directory(root), entry) !== except && occupied(path.join(directory(root), entry)));
}

function reserve(root, kind) {
  const dir = directory(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}-${process.pid}-${randomUUID()}.json`);
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
  finally { fs.closeSync(fd); }
  let released = false;
  return { file, release: () => {
    if (released) return;
    released = true;
    fs.rmSync(file, { force: true });
  } };
}

export function assertNoProductionServers(root) {
  if (active(root, serverFile)) {
    throw new Error("拒绝覆盖运行中的生产构建：请先停止这个工作区的 Blotboard，或在独立工作区构建；构建成功后再启动。否则会导致 JS/CSS 500 与 ChunkLoadError。");
  }
}

export function claimBuild(root) {
  // Publish our unique reservation before checking other participants. Concurrent
  // starters therefore see each other; at worst both refuse, never both proceed.
  const claim = reserve(root, "build");
  try {
    if (active(root, buildFile, claim.file)) throw new Error("这个工作区正在构建或运行，请等待当前操作结束。");
    assertNoProductionServers(root);
    return claim.release;
  } catch (error) { claim.release(); throw error; }
}

export function claimProductionServer(root) {
  const claim = reserve(root, "server");
  try {
    if (active(root, buildFile)) throw new Error("生产构建尚未完成，不能启动 Blotboard；请等待构建成功后再启动。");
    return claim.release;
  } catch (error) { claim.release(); throw error; }
}
