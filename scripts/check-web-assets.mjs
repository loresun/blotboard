/** Read only: verify that the HTML's current JS/CSS references are actually executable. */
export async function checkWebAssets(base) {
  const origin = new URL(base).origin;
  const page = await fetch(new URL("/", origin), { signal: AbortSignal.timeout(10000), redirect: "error" });
  if (!page.ok) return { pageStatus: page.status, assets: [], ok: false };
  const html = await page.text();
  const refs = [...new Set([...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1]).filter((url) => url.startsWith("/_next/static/") && /\.(js|css)(\?|$)/.test(url)))];
  const assets = [];
  // Sequential bounded requests avoid turning the diagnostic into a load test.
  for (const ref of refs.slice(0, 100)) {
    const url = new URL(ref, origin);
    if (url.origin !== origin) continue;
    try {
      const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000), redirect: "error" });
      const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const expected = url.pathname.endsWith(".css") ? type === "text/css" : /^(?:application|text)\/javascript$/.test(type);
      assets.push({ path: url.pathname, status: response.status, type, ok: response.ok && expected });
    } catch { assets.push({ path: url.pathname, status: 0, type: "", ok: false }); }
  }
  return { pageStatus: page.status, assets, ok: assets.length > 0 && assets.every((asset) => asset.ok) && refs.length <= 100 };
}
