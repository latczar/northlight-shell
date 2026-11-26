import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = join(import.meta.dirname, "..");
const pub = join(root, "public");
const site = JSON.parse(readFileSync(join(root, "site.json"), "utf8"));
execFileSync(process.execPath, [join(root, "build.mjs")], { stdio: "ignore" });

const pages = readdirSync(pub, { recursive: true }).filter((p) => p.endsWith(".html")).map(p => String(p).replaceAll('\\', '/'));
const html = Object.fromEntries(pages.map((p) => [p, readFileSync(join(pub, p), "utf8")]));

test("every page carries the same name, phone and address from site.json", () => {
  const { name, phone, street } = site.business;
  for (const [p, h] of Object.entries(html)) {
    for (const fact of [name.replace("'", "&#39;"), phone, street]) assert.ok(h.includes(fact), `${p} missing ${fact}`);
  }
});

test("internal links and images resolve", () => {
  for (const [p, h] of Object.entries(html)) {
    for (const [, ref] of h.matchAll(/(?:href|src|poster)="(\/[^"#?]*)/g)) {
      const file = ref.endsWith("/") ? join(ref, "index.html") : ref;
      assert.ok(existsSync(join(pub, file)), `${p} -> ${ref}`);
    }
  }
});

test("preview builds stay out of search", () => {
  if (!site.preview.noindex) return;
  for (const h of Object.values(html)) assert.match(h, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(readFileSync(join(pub, "robots.txt"), "utf8"), /Disallow: \//);
});

test("copy avoids promises the shop has not approved", () => {
  const text = JSON.stringify(site).toLowerCase();
  for (const word of ["guarantee", "warranty", "certified", "cheapest", "best price"]) assert.ok(!text.includes(word), word);
});

test("every committed image is used or reserved for configured content", () => {
  const used = Object.values(html).join("");
  // The static hero uses the first configured slide. Keep the other photo choices and
  // their responsive crops, plus media reserved for unfinished sections, available for later.
  const reservedImages = new Set([...site.home.slides.map(({ image }) => image), site.home.people.image, site.home.expect.poster, site.about.tour.poster].flatMap((image) => [image, image.replace(/\.webp$/, "-800.webp"), image.replace(/\.webp$/, "-portrait.webp")]));
  for (const f of readdirSync(join(root, "assets/img"))) assert.ok(used.includes(`/img/${f}`) || reservedImages.has(f), `unused ${f}`);
});

test("every image is a recorded placeholder that matches the generator and stays small", () => {
  const manifest = JSON.parse(readFileSync(join(root, 'assets/media.json'), 'utf8'));
  const outputs = [...manifest.images, ...manifest.brand];
  const files = ['img', 'brand'].flatMap(folder => readdirSync(join(root, 'assets', folder)).map(file => `${folder}/${file}`));
  assert.deepEqual(outputs.map(output => output.file).sort(), files.sort(), 'every media file needs a manifest record');
  assert.ok(!existsSync(join(root, 'assets/video')), 'the fictional business has no video');
  for (const output of outputs) {
    const data = readFileSync(join(root, 'assets', output.file));
    assert.equal(createHash('sha256').update(data).digest('hex'), output.sha256, output.file);
    assert.equal(data.length, output.bytes, output.file);
    assert.ok(output.file.endsWith('.svg') && data.length <= 20000, `${output.file} should be a small SVG placeholder`);
  }
  assert.match(site.credits, /placeholders for a fictional business/);
});

test("brand guide: Northlight palette, self-hosted fonts and the Kestrel badge", () => {
  const css = readFileSync(join(pub, "styles.css"), "utf8").toLowerCase();
  for (const hex of ["#1f2328", "#f6f8f8", "#0f766e"]) assert.ok(css.includes(hex), hex);
  for (const font of ["inter-latin-wght-normal.woff2", "manrope-latin-wght-normal.woff2"]) {
    assert.ok(css.includes(`/fonts/${font}`), font);
    assert.ok(existsSync(join(pub, "fonts", font)), `${font} is published`);
  }
  for (const [p, h] of Object.entries(html)) {
    assert.ok(h.includes('class="brand-name">KESTREL<') && h.includes('class="brand-detail">GARAGE<'), `${p} legible header wordmark`);
    assert.ok(/src="\/brand\/kestrel-badge.svg" width="160"/.test(h), `${p} footer badge at >=160px`);
    assert.ok(h.includes("Website managed by Northlight"), `${p} credits Northlight`);
    assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(h), `${p} loads external fonts`);
  }
});

test("the demo says on every page that the business is fictional", () => {
  assert.ok(site.preview.noindex, "a fictional business stays out of search");
  for (const [p, h] of Object.entries(html)) assert.ok(h.includes("Kestrel Garage is a fictional business"), p);
  assert.match(site.business.phone_href, /^tel:\+441632960[0-9]{3}$/, "use an Ofcom drama number");
});

test("no em dashes anywhere on the site", () => {
  for (const [p, h] of Object.entries(html)) assert.ok(!h.includes("—") && !h.includes("&mdash;"), `${p} contains an em dash`);
});

test("unsafe URLs in site.json fail the build", async () => {
  const { mkdtempSync, cpSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  for (const bad of ["javascript:alert(1)", "//evil.example", "/x\" onmouseover=\"alert(1)", "data:text/html,hi"]) {
    const dir = mkdtempSync(join(tmpdir(), "kestrel-"));
    try {
      for (const f of ["build.mjs", "src", "assets"]) cpSync(join(root, f), join(dir, f), { recursive: true });
      writeFileSync(join(dir, "site.json"), JSON.stringify({ ...site, talk_cta: { ...site.talk_cta, href: bad } }));
      assert.throws(() => execFileSync(process.execPath, [join(dir, "build.mjs")], { stdio: "pipe" }), undefined, bad);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("security headers ship with the site", () => {
  const h = readFileSync(join(pub, "_headers"), "utf8");
  for (const needed of ["Content-Security-Policy: default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "X-Content-Type-Options: nosniff", "Referrer-Policy:"]) {
    assert.ok(h.includes(needed), needed);
  }
  for (const p of Object.values(html)) assert.ok(!/<script(?![^>]*(src="\/site\.js"|type="application\/ld\+json"))/.test(p), "unexpected inline script");
});

test("text colors meet WCAG AA contrast (4.5:1)", () => {
  const lum = (hex) => {
    const c = hex.match(/\w\w/g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const pairs = [
    ["1f2328", "ffffff"], ["1f2328", "f6f8f8"], ["444c55", "ffffff"], ["444c55", "f6f8f8"], ["5b6670", "ffffff"], ["5b6670", "f6f8f8"],
    ["0f766e", "ffffff"], ["0f766e", "f6f8f8"], ["ffffff", "0f766e"], ["c5cdd3", "1f2328"], ["ffffff", "1f2328"], ["f0c36a", "1f2328"],
    ["ffffff", "0b5e58"], ["2dd4bf", "132a2a"], ["2dd4bf", "101315"], ["5eead4", "12302e"], ["c5cdd3", "16191d"],
    ["b00020", "ffffff"], ["b00020", "f6f8f8"],
    // Brightest possible image at 30% opacity over #1f2328, rounded upward.
    ["ffffff", "666b71"],
  ];
  for (const [fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 4.5, `#${fg} on #${bg} is ${ratio(fg, bg).toFixed(2)}:1`);
});

test("news: every published post has a page, a card on the index, and its sources", () => {
  const posts = readdirSync(join(root, "news")).map((f) => JSON.parse(readFileSync(join(root, "news", f), "utf8"))).filter((p) => p.status === "published");
  assert.ok(posts.length >= 6, "expected at least 6 posts");
  const index = html["news/index.html"];
  for (const p of posts) {
    const page = html[`news/${p.slug}/index.html`];
    assert.ok(page, `missing page for ${p.slug}`);
    assert.ok(index.includes(`href="/news/${p.slug}/"`), `index lacks ${p.slug}`);
    for (const s of p.sources) assert.ok(page.includes(`href="${s.url}"`), `${p.slug} lacks source ${s.url}`);
  }
  assert.ok(html["index.html"].includes('href="/news/"'), "home links to news");
});

test("news: a malformed or unsafe post fails the build", async () => {
  const { mkdtempSync, cpSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const good = JSON.parse(readFileSync(join(root, "news", "signs-your-brakes-need-attention.json"), "utf8"));
  const cases = {
    "em dash": { ...good, summary: "Pads and rotors — explained." },
    "bad category": { ...good, category: "Gossip" },
    "unsafe source": { ...good, sources: [{ label: "x", url: "javascript:alert(1)" }] },
    "removed recall block": { ...good, body: [{ recall: { campaign: "R/2026/001", vehicles: "x" } }] },
    "unknown block": { ...good, body: [{ html: "<script>alert(1)</script>" }] },
    "promise": { ...good, summary: "Guaranteed lowest price." },
  };
  for (const [name, post] of Object.entries(cases)) {
    const dir = mkdtempSync(join(tmpdir(), "kestrel-news-"));
    try {
      for (const f of ["build.mjs", "src", "assets", "site.json"]) cpSync(join(root, f), join(dir, f), { recursive: true });
      cpSync(join(root, "news"), join(dir, "news"), { recursive: true });
      writeFileSync(join(dir, "news", "signs-your-brakes-need-attention.json"), JSON.stringify(post));
      assert.throws(() => execFileSync(process.execPath, [join(dir, "build.mjs")], { stdio: "pipe" }), undefined, name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});


test("the site loads nothing from third parties: no frames, widgets or external scripts", () => {
  const headers = readFileSync(join(pub, "_headers"), "utf8");
  assert.doesNotMatch(headers, /frame-src|googleapis|gstatic/i);
  for (const [page, content] of Object.entries(html)) {
    assert.ok(!content.includes("<iframe"), page);
    assert.doesNotMatch(content, /<script[^>]+src="https:\/\/|<link(?![^>]*rel="canonical")[^>]+href="https:\/\//, page);
  }
});


test("live launch is indexable, has canonical page URLs, and books by phone", () => {
  if (site.preview.noindex) return;
  assert.doesNotMatch(readFileSync(join(pub, "_headers"), "utf8"), /X-Robots-Tag: noindex/i);
  assert.match(readFileSync(join(pub, "robots.txt"), "utf8"), /Allow: \//);
  for (const [page, content] of Object.entries(html)) {
    if (page === "404.html") { assert.match(content, /content="noindex/); continue; }
    assert.doesNotMatch(content, /content="noindex/);
    const path = "/" + page.replace(/index\.html$/, "");
    assert.ok(content.includes(`rel="canonical" href="${site.business.url}${path}"`), `${page} canonical`);
  }
  assert.doesNotMatch(html["contact/index.html"], /<form\b|Send request/);
  for (const page of Object.values(html)) assert.doesNotMatch(page, /data-assistant-open|assistant-dialog|Ask Iris|\/staff\/iris/i);
  assert.ok(html["contact/index.html"].includes(`href="${site.business.phone_href}"`));
  assert.equal(site.home.primary_cta.href, site.business.phone_href);
});

test("sitemap includes each public canonical page exactly once and excludes errors", () => {
  const sitemap = readFileSync(join(pub, "sitemap.xml"), "utf8");
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(urls.length, pages.length - 1);
  assert.equal(new Set(urls).size, urls.length);
  for (const [file, h] of Object.entries(html)) {
    if (file === '404.html') continue;
    const canonical = h.match(/rel="canonical" href="([^"]+)"/)[1];
    assert.ok(urls.includes(canonical), file);
    assert.equal(new URL(canonical).origin, site.business.url);
  }
  assert.doesNotMatch(sitemap, /404|workers\.dev/);
  if (!site.preview.noindex) assert.ok(readFileSync(join(pub, 'robots.txt'), 'utf8').includes(`Sitemap: ${site.business.url}/sitemap.xml`));
});

test("structured data parses and service URLs resolve to descriptive pages", () => {
  const titles = new Set();
  for (const [file, h] of Object.entries(html)) {
    const title = h.match(/<title>(.+)<\/title>/)[1];
    assert.ok(!titles.has(title), `duplicate title: ${file}`); titles.add(title);
    assert.equal([...h.matchAll(/<h1[ >]/g)].length, 1, file);
    for (const [, source] of h.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
      const data = JSON.parse(source);
      assert.equal(data['@context'], 'https://schema.org');
      if (data['@type'] === 'BlogPosting') assert.ok(data.image.startsWith(site.business.url + '/'));
      if (data['@type'] === 'Service') assert.equal(data.provider['@id'], `${site.business.url}/#business`);
      if (data['@type'] === 'AutoRepair') {
        assert.equal(data.address.addressLocality, site.business.city);
        assert.equal(data.hasOfferCatalog.itemListElement.length, 4);
        assert.ok(!data.aggregateRating, 'no unverified review rating schema');
      }
    }
  }
  for (const item of site.services.items) assert.ok(html[`services/${item.id}/index.html`].includes('Contact the front desk'));
});

test("every page offers policy links and no fabricated review names are published", () => {
  for (const h of Object.values(html)) {
    for (const path of ['/privacy/', '/site-guidelines/', '/accessibility/']) assert.ok(h.includes(`href="${path}"`));
  }
  for (const q of site.home.reviews.quotes) if (q.attribution_note === 'Placeholder name') assert.ok(!html['index.html'].includes(q.author));
  assert.match(html["privacy/index.html"], /Cloudflare/);
  assert.doesNotMatch(Object.values(html).join(''), /href="sms:/, 'do not publish an unverified text number');
});
