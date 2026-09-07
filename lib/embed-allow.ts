/**
 * HTML 嵌入卡的域白名单。
 *
 * 这是 html 卡唯一的「能嵌什么」闸门：iframe 里跑的是别人的脚本，
 * 所以**写入时**就把 URL 挡在门外，而不是等渲染时再想办法（渲染时已经太晚——
 * 卡片一旦落库，任何打开这块板的人都会去加载它）。
 *
 * 默认口径 `@private` 与 server.mjs 的地址闸门是同一条线：
 * 本服务只接受本机 / 私网 / Tailscale 的直连，那它也只嵌这些网段里的页面。
 * 想嵌别的（公司内网域名、自建站点）就配 `BLOTBOARD_HTML_ALLOW`，见 README。
 *
 * 这个文件刻意不引 node:*（config.ts 才读环境变量）：前端要用同一份匹配逻辑
 * 在输入框旁边就告诉用户「这个地址嵌不了」，不能等提交完再吃一个 400。
 */

/** 规则三态：私网段整体放行 / 精确 host（可带端口）/ 域名后缀 */
export type EmbedRule =
  | { kind: "private" }
  | { kind: "host"; host: string; port: string | null }
  | { kind: "suffix"; suffix: string };

/** 默认只放行「本服务自己也只接受连接的那些网段」——本机端口、Tailscale 上的自建服务都在里面 */
export const DEFAULT_HTML_ALLOW = "@private";

/** 去掉 IPv6 字面量的方括号：URL.hostname 给的是 `[::1]`，规则里写的是 `::1` 也该认 */
function bareHost(host: string): string {
  const clean = String(host || "").trim().toLowerCase();
  return clean.startsWith("[") && clean.endsWith("]") ? clean.slice(1, -1) : clean;
}

/**
 * 本机 / 私网 / Tailscale(100.64.0.0/10) / 链路本地 —— 与 server.mjs 的
 * isTrustedClientAddress 同一套判断（那边看的是连进来的 IP，这边看的是要嵌的 host）。
 */
export function isPrivateHost(rawHost: string): boolean {
  let host = bareHost(rawHost);
  if (host.startsWith("::ffff:")) host = host.slice(7);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "127.0.0.1") return true;
  // 127.0.0.0/8 整段（127.0.0.2 之类也是回环）
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const match100 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (match100 && Number(match100[1]) >= 64 && Number(match100[1]) <= 127) return true;
  const match172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  // Prefixes only identify an IPv6 network after the input is a valid IPv6 literal.
  // Hostnames such as fcdn.example.com must never pass the default private allowlist.
  if (!host.includes(":")) return false;
  try {
    new URL(`http://[${host}]/`);
  } catch {
    return false;
  }
  return /^(?:fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/i.test(host);
}

/**
 * 解析配置串：逗号 / 空白分隔，条目形如
 *   `@private`           私网段整体放行（默认）
 *   `slides.example.com` 精确 host，任意端口
 *   `10.1.2.3:8000`      精确 host + 端口
 *   `*.example.com`      域名后缀（含裸域本身）
 * 解析出空数组 = 一个都不放行（`BLOTBOARD_HTML_ALLOW=@none` 就是这么关掉整张卡的）。
 */
export function parseAllowSpec(spec: string): EmbedRule[] {
  const rules: EmbedRule[] = [];
  for (const raw of String(spec || "").split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry || entry === "@none") continue;
    if (entry === "@private") {
      rules.push({ kind: "private" });
      continue;
    }
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(2).replace(/^\.+/, "");
      if (suffix) rules.push({ kind: "suffix", suffix });
      continue;
    }
    // IPv6 要么写 [::1]:8000 要么写 ::1；只有前者能带端口
    const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(entry);
    if (bracket) {
      rules.push({ kind: "host", host: bracket[1], port: bracket[2] || null });
      continue;
    }
    if (entry.includes(":") && !/^[^:]+:\d{1,5}$/.test(entry)) {
      rules.push({ kind: "host", host: bareHost(entry), port: null });
      continue;
    }
    const [host, port] = entry.split(":");
    if (host) rules.push({ kind: "host", host: bareHost(host), port: port || null });
  }
  return rules;
}

/** host（可含端口，URL.host 的形状）能不能嵌。 */
export function hostAllowed(rawHost: string, rules: EmbedRule[]): boolean {
  const host = String(rawHost || "").trim().toLowerCase();
  if (!host) return false;
  // 拆 host / port：IPv6 字面量的冒号不算端口分隔符
  const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(host);
  const name = bracket ? bracket[1] : host.includes(":") && /^[^:]+:\d{1,5}$/.test(host) ? host.split(":")[0] : bareHost(host);
  const port = bracket ? bracket[2] || "" : /^[^:]+:(\d{1,5})$/.exec(host)?.[1] || "";
  for (const rule of rules) {
    if (rule.kind === "private" && isPrivateHost(name)) return true;
    if (rule.kind === "host" && rule.host === name && (!rule.port || rule.port === port)) return true;
    if (rule.kind === "suffix" && (name === rule.suffix || name.endsWith(`.${rule.suffix}`))) return true;
  }
  return false;
}

/** 报错文案里那句「现在允许哪些」——用户看到 400 时得知道该改什么。 */
export function describeAllowRules(rules: EmbedRule[]): string {
  if (!rules.length) return "（当前配置不允许任何地址）";
  return rules
    .map((rule) =>
      rule.kind === "private"
        ? "本机 / 局域网 / Tailscale 的地址"
        : rule.kind === "suffix"
          ? `*.${rule.suffix}`
          : rule.host + (rule.port ? `:${rule.port}` : ""),
    )
    .join("、");
}
