#!/usr/bin/env node
/** Build an archive from a clean commit, excluding Git history and local state. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sourcePathAllowed } from "./source-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
try {
  if (git(["status", "--porcelain", "--untracked-files=all"]).trim()) throw new Error("发布前请精确提交当前项目改动；只从干净提交生成源码包。");
  const commit = git(["rev-parse", "HEAD"]).trim();
  const entries = git(["ls-tree", "-rz", commit]).split("\0").filter(Boolean);
  const rejected = entries.filter((entry) => {
    const [meta, file] = entry.split("\t");
    return !sourcePathAllowed(file) || !meta.startsWith("100644 blob ") && !meta.startsWith("100755 blob ");
  });
  if (rejected.length) throw new Error(`发布内容检查失败：${rejected.length} 个不允许的文件或符号链接。请检查 git ls-tree -r HEAD；未生成源码包。`);
  const revision = commit.slice(0, 12);
  const output = path.join(root, "release");
  fs.mkdirSync(output, { recursive: true });
  const name = `blotboard-source-${revision}.tar.gz`;
  const archive = path.join(output, name);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "blotboard-release-"));
  try {
    const candidate = path.join(temp, "source.tar.gz");
    git(["archive", "--format=tar.gz", "--prefix=blotboard/", "--output", candidate, commit]);
    execFileSync("tar", ["-xzf", candidate, "-C", temp]);
    // Lint the exact immutable tree being released, not a concurrently edited working copy.
    execFileSync(process.execPath, ["scripts/lint-repo.mjs"], { cwd: path.join(temp, "blotboard"), stdio: "inherit" });
    fs.copyFileSync(candidate, `${archive}.tmp`);
    fs.renameSync(`${archive}.tmp`, archive);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  fs.writeFileSync(`${archive}.sha256`, `${digest}  ${name}\n`);
  console.log(`已生成 release/${name} 与 SHA-256；仅包含当前源码，不包含 Git 历史或运行数据。`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
