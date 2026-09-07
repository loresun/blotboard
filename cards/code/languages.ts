/**
 * 代码卡的语言标识表（零依赖，前后端共用）。
 *
 * **为什么是「白名单 + 自由值」而不是纯枚举**：
 * 语言标识有两个互相独立的用途——
 *  ① 给人看（卡面角标、导出的围栏代码块 ```<lang>），任何语言名都有意义，
 *     agent 明天贴一段 zig / nim / hcl，不该被一张我们维护的表挡在门外；
 *  ② 给高亮器用，那只能是本机装了语法定义的那些。
 * 所以：**取值自由**（只校验形状），**高亮按表**（表里没有的老实按纯文本显示，
 * 不猜、不 auto-detect——猜错的高亮比没有高亮更误导人）。
 */

/**
 * 形状闸门：小写字母/数字开头，后面允许 `+ # . _ -`，总长 ≤ 20。
 * 这一条挡的是「把整段代码塞进 language」「传了个对象」这类明显写错的情况，
 * 不是挡语言本身——见上面的两用途说明。
 */
export const CODE_LANGUAGE_RE = /^[a-z0-9][a-z0-9+#._-]{0,19}$/;

/**
 * 别名 → highlight.js 语法模块名。
 * 只列这 26 个模块：覆盖日常贴代码的绝大多数场合，每个模块 4–24 KB，
 * 而且是**按需 import**（cards/code/ui.tsx 的 LOADERS），用到哪个才下哪个。
 */
export const HIGHLIGHT_ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", javascript: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript", typescript: "typescript",
  py: "python", python: "python", python3: "python",
  sh: "bash", bash: "bash", zsh: "bash", shell: "bash", console: "bash",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml",
  sql: "sql",
  go: "go", golang: "go",
  rs: "rust", rust: "rust",
  java: "java",
  c: "c", h: "c",
  cpp: "cpp", "c++": "cpp", cc: "cpp", hpp: "cpp", cxx: "cpp",
  cs: "csharp", csharp: "csharp", "c#": "csharp",
  php: "php",
  rb: "ruby", ruby: "ruby",
  swift: "swift",
  kt: "kotlin", kotlin: "kotlin",
  css: "css",
  scss: "scss", sass: "scss",
  html: "xml", xml: "xml", svg: "xml", vue: "xml",
  md: "markdown", markdown: "markdown",
  diff: "diff", patch: "diff",
  ini: "ini", toml: "ini", conf: "ini",
  dockerfile: "dockerfile", docker: "dockerfile",
  lua: "lua",
  txt: "plaintext", text: "plaintext", plain: "plaintext", plaintext: "plaintext",
};

/** 编辑器下拉里给的常见值（只是提示，输别的照样存得下）。 */
export const COMMON_LANGUAGES = [
  "ts", "tsx", "js", "jsx", "python", "bash", "json", "yaml", "sql",
  "go", "rust", "java", "c", "cpp", "csharp", "php", "ruby", "swift",
  "kotlin", "css", "html", "md", "diff", "toml", "dockerfile", "lua",
];

/** 这个语言本机能高亮吗？能就返回 highlight.js 的模块名，不能返回 null。 */
export function highlightModuleOf(language: string): string | null {
  return HIGHLIGHT_ALIASES[String(language || "").toLowerCase()] || null;
}
