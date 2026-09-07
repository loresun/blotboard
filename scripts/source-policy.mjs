/** Source release allowlist. Deployment state never belongs in a source archive. */
export function sourcePathAllowed(file) {
  if (file === ".env.example") return true;
  if (file.includes("\\") || file.split("/").some((part) => !part || part === "." || part === "..")) return false;
  if (/(?:^|\/)(?:\.env(?:\..*)?|token|runner-settings\.json|agent-commands\.json|ecosystem\.config\.cjs|lint-repo\.local\.json)$/.test(file)) return false;
  if (/\.(?:log|tgz|pem|key|tsbuildinfo)$/.test(file) || /\.tmp\./.test(file)) return false;
  if (file.startsWith("data/")) return file === "data/.gitkeep" || /^data\/(?:templates|card-specs)\/[^/]+\.json$/.test(file);
  if (file.startsWith("public/excalidraw-assets/")) return false;
  if (/^(?:app|bin|cards|components|lib|public|scripts|docs|e2e|landing|packaging)\//.test(file)) {
    // Binary assets require explicit review; never ship arbitrary backups under a code directory.
    return /\.(?:[cm]?js|[cm]?ts|tsx|jsx|json|md|css|html|yml|yaml|sh|svg)$/.test(file) || file === "packaging/npm-placeholder/LICENSE";
  }
  if (file.startsWith(".github/")) return /\.(?:yml|yaml|md)$/.test(file);
  // `README.en.md` 这类带语言后缀的根文档也放行：语言码只认两位小写，
  // 不至于把 `notes.local.md` 这种个人文件一起放进来
  return /^(?:[A-Z][A-Z0-9_-]*(?:\.[a-z]{2})?\.md|LICENSE|package(?:-lock)?\.json|server\.mjs|next\.config\.mjs|tsconfig\.json|playwright\.config\.ts|ecosystem\.config\.example\.cjs|\.gitignore|\.gitattributes|\.npmrc|\.env\.example)$/.test(file);
}

/** Explicit public references; new destinations require review, not a private-domain blacklist. */
export function publicExampleHost(host) {
  const value = host.toLowerCase();
  return ["127.0.0.1", "localhost", "100.x", "100.x.x.x", "100.x.y.z", "12",
    "github.com", "agentclientprotocol.com", "excalidraw.com", "json-schema.org", "keepachangelog.com",
    // 语义化版本与行为准则的官方文本：CHANGELOG / README / CODE_OF_CONDUCT 要引它们的原文出处
    "semver.org", "www.contributor-covenant.org",
    "reactflow.dev", "www.w3.org", "mp.weixin.qq.com", "www.bilibili.com", "x.com", "registry.npmjs.org",
    // Dependency funding metadata, not application service defaults.
    "opencollective.com", "tidelift.com", "paulmillr.com", "example.feishu.cn"].includes(value)
    || /(?:^|\.)(?:example\.(?:com|org|net)|test|invalid)$/.test(value);
}
