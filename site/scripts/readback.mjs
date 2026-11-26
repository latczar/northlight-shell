// Checks a deployed origin serves this build: the homepage carries the business phone (and noindex while
// the site is a preview) and the badge loads. Retries ~20s for edge propagation.
// Usage: node scripts/readback.mjs <origin>
import { readFileSync } from "node:fs";

const origin = process.argv[2];
if (!origin) {
  console.error("Usage: node scripts/readback.mjs <origin>");
  process.exit(2);
}
const site = JSON.parse(readFileSync(new URL("../site.json", import.meta.url), "utf8"));

async function check() {
  const home = await fetch(new URL("/", origin), { signal: AbortSignal.timeout(4000) });
  if (!home.ok) throw new Error(`homepage returned HTTP ${home.status}`);
  const html = await home.text();
  if (!html.includes(site.business.phone)) throw new Error(`homepage lacks phone ${site.business.phone}`);
  if (site.preview.noindex && !html.includes('content="noindex')) throw new Error("homepage lacks noindex");
  if (!site.preview.noindex) {
    if (html.includes('content="noindex') || /noindex/i.test(home.headers.get("x-robots-tag") || "")) throw new Error("live homepage is blocked from search");
    const contact = await fetch(new URL("/contact/", origin), { signal: AbortSignal.timeout(4000) });
    const contactHtml = await contact.text();
    if (!contact.ok || /<form\b/i.test(contactHtml) || !contactHtml.includes('href="' + site.business.phone_href + '"')) throw new Error("live booking must direct customers to the phone");
  }
  if (!site.preview.noindex) {
    const robots = await fetch(new URL('/robots.txt', origin), { signal: AbortSignal.timeout(4000) });
    if (!robots.ok || !(await robots.text()).includes(`Sitemap: ${site.business.url}/sitemap.xml`)) throw new Error('robots.txt lacks sitemap');
    const sitemap = await fetch(new URL('/sitemap.xml', origin), { signal: AbortSignal.timeout(4000) });
    if (!sitemap.ok || !/xml/.test(sitemap.headers.get('content-type') || '')) throw new Error('sitemap must return XML');
    const xml = await sitemap.text();
    const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]));
    if (paths.length < 18 || paths.some((u) => u.origin !== site.business.url)) throw new Error('sitemap has missing or noncanonical pages');
    for (const path of ['/privacy/', '/site-guidelines/', '/accessibility/', '/services/brakes/', '/services/suspension/', '/services/tyres/', '/services/servicing/']) {
      const page = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(4000) });
      if (!page.ok || !(await page.text()).includes(`rel="canonical" href="${site.business.url}${path}"`)) throw new Error(`missing canonical page: ${path}`);
    }
    const missing = await fetch(new URL('/readback-page-that-does-not-exist/', origin), { signal: AbortSignal.timeout(4000) });
    if (missing.status !== 404 || !(await missing.text()).includes('content="noindex')) throw new Error('missing pages must return 404 and noindex');
  }
  const badge = await fetch(new URL("/brand/kestrel-badge.svg", origin), { signal: AbortSignal.timeout(4000) });
  if (badge.status !== 200) throw new Error(`/brand/kestrel-badge.svg returned HTTP ${badge.status}`);
  const expected = process.env.EXPECTED_COMMIT;
  if (expected) {
    const marker = await fetch(new URL("/foundry-source.json", origin), { signal: AbortSignal.timeout(4000), cache: "no-store" });
    const commit = marker.ok ? (await marker.json()).commit : null;
    if (commit !== expected) throw new Error(`/foundry-source.json reports ${commit}, expected ${expected}`);
  }
}

const deadline = Date.now() + 20_000;
for (let attempt = 1; ; attempt++) {
  try {
    await check();
    console.log(`Readback passed on attempt ${attempt}: ${origin}`);
    break;
  } catch (error) {
    if (Date.now() >= deadline) {
      console.error(`Readback failed after ${attempt} attempts: ${error.message}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
