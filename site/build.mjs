// Renderer: site.json + src/ + assets/ -> public/.
// site.json is edited by people and by the web-manager agent, so every value is escaped on output and
// every URL, file name and id is validated here. A bad value fails the build instead of shipping.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { serviceDetails, policies } from "./src/content.mjs";

const root = import.meta.dirname;
const out = join(root, "public");
const site = JSON.parse(readFileSync(join(root, "site.json"), "utf8"));
const b = site.business;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Links: same-site paths, https, or tel only.
function url(u, field) {
  const ok = /^\/(?!\/)[\w\-./#]*$/.test(u) || /^tel:\+?[0-9]+$/.test(u) || /^https:\/\/[^\s"'<>]+$/.test(u);
  if (!ok) throw new Error(`site.json ${field}: unsafe or malformed URL ${JSON.stringify(u)}`);
  return esc(u);
}
const ext = (u) => (u.startsWith("https://") ? ' rel="noopener noreferrer"' : "");

// Images: plain file names that exist in assets/img. Width/height come from the WebP header or the SVG root.
function imageSize(file) {
  if (file.endsWith(".svg")) {
    const svg = readFileSync(join(root, "assets/img", file), "utf8").match(/<svg[^>]*>/)?.[0] ?? "";
    const size = [/ width="(\d+)"/, / height="(\d+)"/].map((pattern) => Number(svg.match(pattern)?.[1]));
    if (!size.every((n) => n > 0)) throw new Error(`assets/img/${file}: SVG needs width and height`);
    return size;
  }
  const buf = readFileSync(join(root, "assets/img", file));
  const kind = buf.toString("ascii", 12, 16);
  if (kind === "VP8X") return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (kind === "VP8 ") return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (kind === "VP8L") { const v = buf.readUInt32LE(21); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; }
  throw new Error(`assets/img/${file}: not a WebP image`);
}
function checkImage(file, field) {
  if (!/^[a-z0-9-]+\.(webp|svg)$/.test(file) || !existsSync(join(root, "assets/img", file))) {
    throw new Error(`site.json ${field}: image ${JSON.stringify(file)} must be a .webp or .svg file in assets/img`);
  }
  return file;
}
function checkVideo(file, field) {
  if (!/^\/video\/[a-z0-9-]+\.mp4$/.test(file) || !existsSync(join(root, 'assets', file.slice(1)))) {
    throw new Error(`site.json ${field}: video must be a local .mp4 file in assets/video`);
  }
  return file;
}
const variant = (file, suffix) => {
  if (!file.endsWith(".webp")) return null;
  const v = file.replace(/\.webp$/, `-${suffix}.webp`);
  return existsSync(join(root, "assets/img", v)) ? v : null;
};
// Phones use the supplied portrait or 800px image, avoiding a desktop download on dense screens.
function picture(file, alt, { sizes = "100vw", eager = false, hero = false, field = "image" } = {}) {
  checkImage(file, field);
  const [w, h] = imageSize(file);
  const small = variant(file, "800");
  const portrait = hero ? variant(file, "portrait") : null;
  const srcset = small ? ` srcset="/img/${small} ${imageSize(small)[0]}w, /img/${file} ${w}w" sizes="${sizes}"` : "";
  const loading = eager ? ' fetchpriority="high"' : ' loading="lazy" decoding="async"';
  const imgTag = `<img src="/img/${small || file}"${srcset} width="${w}" height="${h}" alt="${esc(alt)}"${loading}>`;
  const phone = portrait || small;
  return phone ? `<picture><source media="(max-width: 700px)" srcset="/img/${phone}">${imgTag}</picture>` : imgTag;
}
const slug = (id) => {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`site.json id ${JSON.stringify(id)} must be a lowercase slug`);
  return id;
};

const icons = {
  pin: '<path d="M24 43s15-14 15-25a15 15 0 0 0-30 0c0 11 15 25 15 25Z"/><circle cx="24" cy="18" r="5"/>',
  brake: '<circle cx="24" cy="24" r="15"/><circle cx="24" cy="24" r="4"/><path d="M33 12a15 15 0 0 1 4 9"/><path d="M9 24h4M35 24h4M24 9v4M24 35v4"/>',
  spring: '<path d="M14 8h20M14 40h20"/><path d="M16 12l16 4-16 4 16 4-16 4 16 4-16 4"/>',
  tyre: '<circle cx="24" cy="24" r="16"/><circle cx="24" cy="24" r="8"/><path d="M24 8v8M24 32v8M8 24h8M32 24h8"/>',
  wrench: '<path d="M30 8a8 8 0 0 0-7 11L9 33a3 3 0 0 0 4 4l14-14a8 8 0 0 0 11-7l-5 3-4-1-1-4z"/>',
  play: '<circle cx="24" cy="24" r="20"/><path d="M20 16l12 8-12 8z"/>',
  star: '<path d="M24 6l5.5 11.5 12.5 1.5-9 8.5 2.5 12.5-11.5-6-11.5 6 2.5-12.5-9-8.5 12.5-1.5z"/>',
  phone: '<path d="M14 6h7l3 9-5 3a24 24 0 0 0 11 11l3-5 9 3v7a4 4 0 0 1-4 4A34 34 0 0 1 10 10a4 4 0 0 1 4-4z"/>',
  chat: '<path d="M8 10h32v22H20l-8 7v-7H8z"/>',
};
const heading = (h) => esc(h.heading) + (h.accent ? ` <span class="accent-line">${esc(h.accent)}</span>` : "");
const icon = (name, cls = "icon") => `<svg class="${cls}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${icons[name]}</svg>`;

const phoneHref = url(b.phone_href, "business.phone_href");
const directions = url(b.directions_url, "business.directions_url");
const talk = { href: url(site.talk_cta.href, "talk_cta.href"), label: esc(site.talk_cta.label) };
const primary = { href: url(site.home.primary_cta.href, "home.primary_cta.href"), label: esc(site.home.primary_cta.label) };

const hoursTable = (cls = "hours") =>
  `<table class="${cls}"><caption class="sr">Opening hours</caption>${b.hours
    .map((h) => `<tr><th scope="row">${esc(h.days)}</th><td>${h.closed ? "Closed" : `${esc(h.open)} to ${esc(h.close)}`}</td></tr>`)
    .join("")}</table>`;

// Unavailable videos have no public placeholder. Callers also omit their surrounding section.
function media({ video, poster, field }) {
  if (!video) return "";
  return `<div class="media media--wide"><video src="${url(video, `${field}.video`)}" poster="/img/${checkImage(poster, `${field}.poster`)}" muted loop playsinline preload="metadata" data-autoplay></video><button class="video-toggle" type="button" aria-pressed="false">Pause video</button></div>`;
}

// JSON-LD: escape "<" so no value can close the script element.
const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "AutoRepair",
  "@id": `${b.url}/#business`,
  image: `${b.url}/brand/kestrel-badge.svg`,
  name: b.name,
  telephone: b.phone,
  url: b.url,
  address: { "@type": "PostalAddress", streetAddress: b.street, addressLocality: b.city, addressRegion: b.region, postalCode: b.postal, addressCountry: "GB" },
  openingHours: b.hours.filter((h) => !h.closed).map((h) => h.schema),
  areaServed: b.service_area.map((name) => ({ "@type": "Place", name })),
  hasOfferCatalog: { "@type": "OfferCatalog", name: "Garage services", itemListElement: site.services.items.map((item) => ({ "@type": "Offer", itemOffered: { "@type": "Service", name: item.title, url: `${b.url}/services/${item.id}/` } })) },
}).replace(/</g, "\\u003c");

const address = `${esc(b.street)}<br>${esc(b.city)}, ${esc(b.region)}<br>${esc(b.postal)}`;
// Directions say they open Google Maps only when the business has a real map link.
const mapNote = b.directions_url.startsWith("https://") ? '<span class="sr"> (opens Google Maps)</span>' : "";

function layout({ page, path, body }) {
  const canonical = path ? b.url + path : null;
  const socialImage = `${b.url}/img/${page.image || site.home.slides[0].image}`;
  const nav = site.nav
    .map((n, i) => `<a href="${url(n.href, `nav[${i}].href`)}"${path === n.href ? ' aria-current="page"' : ""}>${esc(n.label)}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#1f2328">
<meta name="format-detection" content="telephone=no">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}">
<meta property="og:type" content="${path.startsWith('/news/') && path !== '/news/' ? 'article' : 'website'}">
<meta property="og:site_name" content="${esc(b.name)}">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
${canonical ? `<meta property="og:url" content="${url(canonical, 'canonical')}">` : ''}
<meta property="og:image" content="${url(socialImage, 'social image')}">
<meta name="twitter:card" content="summary_large_image">
${path && b.url ? `<link rel="canonical" href="${url(b.url + path, "business.url")}">` : ""}
${site.preview.noindex || !path ? '<meta name="robots" content="noindex, nofollow">\n' : '<meta name="robots" content="index, follow, max-image-preview:large">\n'}<link rel="icon" href="/brand/kestrel-badge.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/manrope-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css">
<script type="application/ld+json">${jsonLd}</script>
<script src="/site.js" defer></script>
</head>
<body${path === '/' ? ' class="home-page"' : ''}>
<a class="skip" href="#main">Skip to content</a>
<header class="masthead">
  <div class="masthead-inner">
    <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-nav"><span class="menu-bars" aria-hidden="true"></span><span class="sr">Menu</span></button>
    <nav id="site-nav" class="nav" aria-label="Main">${nav}<a class="nav-call" href="${phoneHref}">Call ${esc(b.phone)}</a></nav>
    <a class="brand" href="/" aria-label="${esc(b.name)} home"><span class="brand-name">KESTREL</span><span class="brand-detail">GARAGE</span></a>
    <div class="masthead-actions">
      <a class="masthead-phone" href="${phoneHref}">${esc(b.phone)}</a>
      <a class="masthead-call" href="${phoneHref}" aria-label="Call ${esc(b.phone)}">${icon("phone", "call-icon")}</a>
      <a class="masthead-cta" href="${talk.href}">${talk.label}</a>
    </div>
  </div>
</header>
<main id="main" tabindex="-1">
${body}
</main>
<footer class="footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <a class="footer-badge" href="/"><img src="/brand/kestrel-badge.svg" width="160" height="160" alt="${esc(b.name)} home" loading="lazy" decoding="async"></a>
      <p>${esc(b.tagline)}</p>
    </div>
    <div>
      <h2 class="footer-h">Visit</h2>
      <address>${address}</address>
      <p><a href="${phoneHref}">${esc(b.phone)}</a></p>
      <p><a href="${directions}"${ext(b.directions_url)}>Get directions${mapNote}</a></p>
    </div>
    <div>
      <h2 class="footer-h">Hours</h2>
      ${hoursTable("hours hours--footer")}
    </div>
    <div>
      <h2 class="footer-h">Explore</h2>
      <ul class="footer-links">${site.nav.map((n, i) => `<li><a href="${url(n.href, `nav[${i}].href`)}">${esc(n.label)}</a></li>`).join("")}</ul>
    </div>
  </div>
  <div class="footer-base">
    <p>© ${new Date().getFullYear()} ${esc(b.name)} · Serving ${esc(b.county)}</p>
    <p>${esc(site.credits)}</p>
    <p class="managed-by"><img src="/brand/northlight-mark.svg" width="16" height="16" alt="">Website managed by Northlight</p>
    <nav class="policy-links" aria-label="Policies"><a href="/privacy/">Privacy policy</a><a href="/site-guidelines/">Site guidelines</a><a href="/accessibility/">Accessibility</a></nav>
    ${site.preview.noindex ? `<p class="preview-note">${esc(site.preview.notice)}</p>` : ""}
  </div>
</footer>
<div class="quick-contact">
<nav class="action-bar" aria-label="Quick actions">
  <a href="${phoneHref}">${icon("phone", "action-icon")}Call</a>
  <a href="${directions}"${ext(b.directions_url)}>${icon("pin", "action-icon")}Directions${mapNote}</a>
</nav>
</div>
</body>
</html>
`;
}

const pageHero = ({ eyebrow, heading: h, intro, image, alt }, field) => `
<section class="page-hero">
  <div class="page-hero-copy">
    <p class="eyebrow">${esc(eyebrow)}</p>
    <h1 class="display">${esc(h)}</h1>
    <p class="lede">${esc(intro)}</p>
  </div>
  ${picture(image, alt, { eager: true, hero: true, field })}
</section>`;

const visitBlock = (v) => `
<section class="visit" aria-labelledby="visit-h">
  <div class="visit-inner">
    <div class="visit-header">
      <div class="visit-copy">
        <p class="eyebrow">${esc(v.eyebrow)}</p>
        <h2 class="display display--md" id="visit-h">${esc(v.heading)}</h2>
      </div>
      <div class="visit-media">${picture(v.image, v.image_alt, { sizes: "(max-width: 700px) 100vw, 420px", field: "home.visit.image" })}</div>
    </div>
    <div class="visit-details">
      <div class="visit-detail">
        <h3 class="visit-label">${esc(v.address_label)}</h3>
        <address class="visit-address">${address}</address>
        <a class="btn btn--primary" href="${directions}"${ext(b.directions_url)}>Get directions${mapNote}</a>
      </div>
      <div class="visit-detail">
        <h3 class="visit-label">${esc(v.hours_label)}</h3>
        ${hoursTable()}
      </div>
      <div class="visit-detail">
        <h3 class="visit-label">${esc(v.phone_label)}</h3>
        <p class="visit-phone"><a href="${phoneHref}">${esc(b.phone)}</a></p>
        <a class="btn btn--outline-dark" href="${phoneHref}">${esc(v.phone_cta)}</a>
      </div>
    </div>
    <div class="visit-area">
      <h3 class="visit-label">${esc(v.area_label)}</h3>
      <ul>${b.service_area.map((area) => `<li>${esc(area)}</li>`).join("")}</ul>
    </div>
  </div>
</section>`;

const pointsList = (points) =>
  `<ol class="points">${points.map((p) => `<li><h3>${esc(p.title)}</h3><p>${esc(p.body)}</p></li>`).join("")}</ol>`;

function home() {
  const h = site.home;
  const hero = h.hero;
  const lead = h.slides[0];
  const film = h.hero_video;
  const heroPhoto = picture(film?.poster ?? lead.image, lead.alt, { eager: true, sizes: "100vw", field: "home.hero_video.poster" });
  const heroMedia = film ? `${heroPhoto}<video id="shop-film" data-desktop="${checkVideo(film.video, 'home.hero_video.video')}" data-phone="${checkVideo(film.mobile_video, 'home.hero_video.mobile_video')}" muted loop playsinline preload="none" aria-hidden="true"></video>` : heroPhoto;
  const weekday = b.hours.find((day) => !day.closed);

  const tiles = h.tiles
    .map((t, i) => {
      checkImage(t.image, `home.tiles[${i}].image`);
      const service = site.services.items.find(item => t.href === `/services/${item.id}/`);
      if (!service) throw new Error(`home.tiles[${i}] needs a matching service`);
      return `<li><a class="tile" href="${url(t.href, `home.tiles[${i}].href`)}">${picture(t.image, "", { sizes: "(max-width: 700px) 50vw, (max-width: 1300px) 45vw, 580px", field: `home.tiles[${i}].image` })}<span class="tile-symbol" aria-hidden="true">${icon(t.icon, "tile-icon")}</span><span class="tile-label"><strong>${esc(t.label)}</strong><span class="tile-description">${service.list.filter(item => item.toLowerCase() !== t.label.toLowerCase()).slice(0, 2).map(esc).join(" · ")}</span></span><span class="tile-arrow" aria-hidden="true">↗</span></a></li>`;
    })
    .join("");

  const quotes = h.reviews.quotes.map((q) => `<figure class="quote"><blockquote><p>“${esc(q.text)}”</p></blockquote><figcaption>${esc(q.author)}<br><small>Sample review for a fictional business</small></figcaption></figure>`).join("");

  const body = `
<section class="hero hero--cinematic" aria-labelledby="hero-heading">
  <div class="cinematic-stage">
    <div class="cinematic-media">${heroMedia}</div>
    <button class="video-toggle hero-playback" type="button" aria-controls="shop-film" hidden>Play video</button>
    <div class="cinematic-copy">
      <p class="cinematic-eyebrow">${esc(hero.eyebrow)}</p>
      <h1 id="hero-heading">${hero.heading_lines.map((line) => `<span>${esc(line)}</span>`).join(" ")}${hero.accent ? ` <span class="cinematic-accent">${esc(hero.accent)}</span>` : ""}</h1>
      <p class="cinematic-description">${esc(lead.body)}</p>
      <div class="cinematic-actions">
        <a class="cinematic-primary" href="${primary.href}">${primary.label}<span aria-hidden="true">→</span></a>
        <a class="cinematic-secondary" href="${directions}"${ext(b.directions_url)}>Get directions</a>
      </div>
    </div>
  </div>
  <div class="cinematic-details">
    <span><strong>${esc(hero.local_note)}</strong> ${esc(hero.location_note)}</span>
    <span><strong>${esc(weekday.days)}</strong> ${esc(weekday.open)} to ${esc(weekday.close)}</span>
    <span><strong>${esc(b.street)}</strong> ${esc(b.city)}, ${esc(b.region)}</span>
  </div>
</section>

<section class="section services-overview" aria-labelledby="tiles-h">
  <div class="section-head services-heading">
    <div><p class="eyebrow">${esc(h.tiles_eyebrow)}</p><h2 class="display display--md" id="tiles-h">${esc(h.tiles_heading)}</h2></div>
    <a class="link" href="/services/">Explore our services <span aria-hidden="true">→</span></a>
  </div>
  <ul class="tiles">${tiles}</ul>
</section>

${h.expect.video ? `<section class="section expect" aria-labelledby="expect-h">
  <div class="section-head">
    <p class="eyebrow">${esc(h.expect.eyebrow)}</p>
    <h2 class="display display--md" id="expect-h">${esc(h.expect.heading)}</h2>
    <p class="section-intro">${esc(h.expect.body)}</p>
  </div>
  ${media({ video: h.expect.video, poster: h.expect.poster, field: "home.expect" })}
  ${pointsList(h.expect.points)}
</section>` : ""}

${h.people.enabled ? `<section class="section people" aria-labelledby="people-h">
  <figure class="people-media">${picture(h.people.image, h.people.image_alt, { sizes: "(max-width: 900px) 100vw, 50vw", field: "home.people.image" })}</figure>
  <div class="people-copy">
    <p class="eyebrow">${esc(h.people.eyebrow)}</p>
    <h2 class="display display--md" id="people-h">${esc(h.people.heading)}</h2>
    <p>${esc(h.people.body)}</p>
  </div>
</section>` : ""}

${h.reviews.enabled ? `<section class="section section--dark reviews" aria-labelledby="reviews-h">
  <h2 class="eyebrow eyebrow--light" id="reviews-h">${esc(h.reviews.eyebrow)}</h2>
  <div class="quotes">${quotes}</div>
</section>` : ""}

<section class="section focus" aria-labelledby="focus-h">
  <div class="focus-panel">
    <div class="focus-photo">${picture(h.focus.image, h.focus.image_alt, { sizes: "(max-width: 700px) 100vw, 50vw", field: "home.focus.image" })}</div>
    <div class="focus-copy"><p class="eyebrow">${esc(h.focus.eyebrow)}</p><h2 class="display display--md" id="focus-h">${esc(h.focus.heading)}</h2><p class="section-intro">${esc(h.focus.body)}</p><a class="link" href="/about/">${esc(site.about.eyebrow)} <span aria-hidden="true">↗</span></a></div>
  </div>
</section>

${news.length ? `<section class="section news-strip" aria-labelledby="news-h">
  <div class="section-head"><p class="eyebrow">From the garage</p><h2 class="display display--md" id="news-h">Tips and garage news.</h2></div>
  <div class="cards">${news.slice(0, 3).map((p) => newsCard(p)).join("")}</div>
  <p class="news-all"><a class="link" href="/news/">See all news</a></p>
</section>
` : ""}<section class="cta-band" aria-labelledby="talk-h">
  <h2 class="display display--md" id="talk-h">${heading(h.talk)}</h2>
  <p>${esc(h.talk.body)}</p>
  <div class="actions"><a class="btn btn--primary" href="${talk.href}">${talk.label}</a><a class="btn btn--outline" href="${phoneHref}">Call ${esc(b.phone)}</a></div>
</section>
${visitBlock(h.visit)}`;
  return layout({ page: h, path: "/", body });
}

function services() {
  const s = site.services;
  const items = s.items
    .map(
      (it, i) => `
<section class="feature${i % 2 ? " feature--flip" : ""}" id="${slug(it.id)}" aria-labelledby="${slug(it.id)}-h">
  <div class="feature-media">${picture(it.image, it.alt, { sizes: "(max-width: 900px) 100vw, 50vw", field: `services.items[${i}].image` })}</div>
  <div class="feature-copy">
    <h2 class="display display--md" id="${slug(it.id)}-h">${esc(it.title)}</h2>
    <p>${esc(it.body)}</p>
    <ul class="checklist">${it.list.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    <a class="link" href="/services/${slug(it.id)}/">Explore ${esc(it.title.toLowerCase())} <span aria-hidden="true">→</span></a>
  </div>
</section>`
    )
    .join("");
  const body = `${pageHero({ eyebrow: s.eyebrow, heading: s.heading, intro: s.intro, image: s.hero_image, alt: s.hero_alt }, "services.hero_image")}
${items}
<section class="section section--dark not-offered" aria-labelledby="not-offered-h">
  <h2 class="display display--md" id="not-offered-h">${esc(s.not_offered_heading)}</h2>
  <p>${esc(s.not_offered_body)}</p>
</section>`;
  return layout({ page: s, path: "/services/", body });
}

function about() {
  const a = site.about;
  const h = site.home;
  const body = `${pageHero({ eyebrow: a.eyebrow, heading: a.heading, intro: a.intro, image: a.hero_image, alt: a.hero_alt }, "about.hero_image")}
${h.people.enabled ? `<section class="section people" aria-labelledby="manager-h">
  <figure class="people-media">${picture(h.people.image, h.people.image_alt, { sizes: "(max-width: 900px) 100vw, 50vw", field: "home.people.image" })}</figure>
  <div class="people-copy">
    <p class="eyebrow">Garage manager</p>
    <h2 class="display display--md" id="manager-h">${esc(b.manager)}</h2>
    <p>${esc(h.people.body)}</p>
  </div>
</section>` : ""}
${a.tour.video ? `<section class="section expect" aria-labelledby="tour-h">
  <div class="section-head">
    <p class="eyebrow">${esc(a.tour.eyebrow)}</p>
    <h2 class="display display--md" id="tour-h">${esc(a.tour.heading)}</h2>
    <p class="section-intro">${esc(a.tour.body)}</p>
  </div>
  ${media({ video: a.tour.video, poster: a.tour.poster, field: "about.tour" })}
  ${pointsList(h.expect.points)}
</section>` : ""}
${visitBlock(h.visit)}`;
  return layout({ page: a, path: "/about/", body });
}

function contact() {
  const c = site.contact;
  const body = `
<section class="section contact">
  <div class="contact-info">
    <p class="eyebrow">${esc(c.eyebrow)}</p>
    <h1 class="display display--md">${heading(c)}</h1>
    <p class="section-intro">${esc(c.intro)}</p>
    <address class="visit-address">${esc(b.name)}<br>${address}</address>
    <p class="contact-phone"><a href="${phoneHref}">${esc(b.phone)}</a></p>
    ${hoursTable()}
    <div class="actions"><a class="btn btn--primary" href="${directions}"${ext(b.directions_url)}>Get directions${mapNote}</a></div>
  </div>
${site.preview.noindex ? `  <form class="form" id="appointment" novalidate aria-labelledby="form-h" aria-describedby="form-note" data-preview-note="${esc(c.form.preview_note)}">
    <h2 class="form-h" id="form-h">${esc(c.form.heading)}</h2>
    <p class="form-note" id="form-note">Fields marked <span aria-hidden="true">*</span><span class="sr">with an asterisk</span> are required.</p>
    <div class="field">
      <label for="f-name">Name <span class="req" aria-hidden="true">*</span></label>
      <input id="f-name" name="name" autocomplete="name" required aria-describedby="f-name-err">
      <p class="field-error" id="f-name-err" hidden>Please enter your name.</p>
    </div>
    <div class="field">
      <label for="f-phone">Phone <span class="req" aria-hidden="true">*</span></label>
      <input id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required aria-describedby="f-phone-err">
      <p class="field-error" id="f-phone-err" hidden>Please enter a phone number we can call.</p>
    </div>
    <div class="field">
      <label for="f-vehicle">Vehicle <span class="opt">(make, model and registration)</span></label>
      <input id="f-vehicle" name="vehicle" autocomplete="off">
    </div>
    <div class="field">
      <label for="f-service">Service</label>
      <select id="f-service" name="service">${c.form.services.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
    </div>
    <div class="field">
      <label for="f-notes">What's going on? <span class="opt">(optional)</span></label>
      <textarea id="f-notes" name="notes" rows="4"></textarea>
    </div>
    <button class="btn btn--primary" type="submit">Send request</button>
    <p class="form-status" role="status" aria-live="polite"></p>
  </form>` : `<section class="form" id="appointment" aria-labelledby="booking-h"><h2 class="form-h" id="booking-h">${esc(c.booking.heading)}</h2><p class="section-intro">${esc(c.booking.body)}</p><a class="btn btn--primary" href="${phoneHref}">${esc(c.booking.cta)}</a></section>`}
</section>`;
  return layout({ page: c, path: "/contact/", body });
}

function notFound() {
  const body = `<section class="section section--center notfound"><p class="eyebrow">404</p><h1 class="display display--md">That page took a wrong turning.</h1><p><a class="btn btn--primary" href="/">Back to home</a></p></section>`;
  return layout({ page: { title: `Page not found | ${b.name}`, description: site.home.description }, path: "", body });
}

// News: one JSON file per post in news/. The weekly agent writes these, so every field is validated
// and a bad post fails the build. Only "published" posts render.
const CATEGORIES = ["MOT", "Brakes", "Tyres", "Suspension", "Maintenance", "Garage news"];
const BLOCKS = ["p", "h2", "ul", "ol", "callout"];
function loadNews() {
  const dir = join(root, "news");
  if (!existsSync(dir)) return [];
  const posts = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    const p = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const bad = (why) => { throw new Error(`news/${f}: ${why}`); };
    const text = (v, max, name) => (typeof v === "string" && v.trim() && v.length <= max ? v : bad(`${name} must be text up to ${max} characters`));
    if (`${p.slug}.json` !== f || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug)) bad("slug must match the file name and be a lowercase slug");
    if (!["published", "draft"].includes(p.status)) bad('status must be "published" or "draft"');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || Number.isNaN(Date.parse(p.date))) bad("date must be YYYY-MM-DD");
    if (!CATEGORIES.includes(p.category)) bad(`category must be one of ${CATEGORIES.join(", ")}`);
    text(p.title, 90, "title"); text(p.summary, 200, "summary"); text(p.image_alt, 140, "image_alt"); text(p.author, 60, "author");
    checkImage(p.image, `news/${f} image`);
    if (!Array.isArray(p.body) || !p.body.length) bad("body must be a nonempty list of blocks");
    for (const block of p.body) {
      const keys = Object.keys(block);
      if (keys.length !== 1 || !BLOCKS.includes(keys[0])) bad(`each body block must be exactly one of ${BLOCKS.join(", ")}`);
      const v = block[keys[0]];
      if (keys[0] === "ul" || keys[0] === "ol") { if (!Array.isArray(v) || !v.length) bad("lists need items"); v.forEach((i) => text(i, 600, "list item")); }
      else text(v, 1200, keys[0]);
    }
    if (!Array.isArray(p.sources)) bad("sources must be a list");
    p.sources.forEach((s, i) => { text(s.label, 120, "source label"); if (!/^https:\/\//.test(s.url)) bad(`sources[${i}] must be https`); url(s.url, `news/${f} sources[${i}]`); });
    const all = JSON.stringify(p);
    if (/[—]|&mdash;/.test(all)) bad("no em dashes");
    if (/guarantee|warranty|certified|cheapest|best price/i.test(all)) bad("no unapproved promises (guarantee, warranty, certified, pricing claims)");
    return p;
  });
  const slugs = new Set();
  for (const p of posts) { if (slugs.has(p.slug)) throw new Error(`duplicate news slug ${p.slug}`); slugs.add(p.slug); }
  return posts.filter((p) => p.status === "published").sort((a, b) => b.date.localeCompare(a.date) || Number(!!b.featured) - Number(!!a.featured) || a.title.localeCompare(b.title));
}
const news = loadNews();
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const readMinutes = (p) => Math.max(1, Math.round(JSON.stringify(p.body).split(/\s+/).length / 200));

function newsCard(p, { level = "h3", large = false } = {}) {
  return `<article class="card${large ? " card--large" : ""}">
  <div class="card-media">${picture(p.image, "", { sizes: large ? "(max-width: 900px) 100vw, 60vw" : "(max-width: 700px) 100vw, 400px", field: `news ${p.slug}` })}</div>
  <div class="card-body">
    <p class="card-meta"><span class="card-cat">${esc(p.category)}</span> <time datetime="${p.date}">${longDate(p.date)}</time></p>
    <${level} class="card-title"><a href="/news/${p.slug}/">${esc(p.title)}</a></${level}>
    <p>${esc(p.summary)}</p>
  </div>
</article>`;
}

function renderBlock(block) {
  const [k, v] = Object.entries(block)[0];
  if (k === "p") return `<p>${esc(v)}</p>`;
  if (k === "h2") return `<h2>${esc(v)}</h2>`;
  if (k === "ul" || k === "ol") return `<${k}>${v.map((i) => `<li>${esc(i)}</li>`).join("")}</${k}>`;
  return `<p class="callout">${esc(v)}</p>`;
}

function newsIndex() {
  const featured = news.find((p) => p.featured) ?? news[0];
  const rest = news.filter((p) => p !== featured);
  const body = `
<section class="section news-head">
  <p class="eyebrow">News</p>
  <h1 class="display display--md">From the garage. <span class="accent-line">Tips and straight answers.</span></h1>
  <p class="section-intro">Practical advice on MOTs, brakes, suspension and tyres from the team at ${esc(b.name)}.</p>
</section>
<section class="section news-list" aria-label="Latest posts">
  ${featured ? newsCard(featured, { level: "h2", large: true }) : "<p>No posts yet.</p>"}
  <div class="cards">${rest.map((p) => newsCard(p, { level: "h2" })).join("")}</div>
</section>`;
  return layout({ page: { title: `News | ${b.name}, ${b.city}`, description: `Practical MOT, brake, suspension and tyre advice from ${b.name} in ${b.city}.` }, path: "/news/", body });
}

function newsPost(p) {
  const related = news.filter((o) => o !== p).sort((x, y) => Number(y.category === p.category) - Number(x.category === p.category)).slice(0, 3);
  const ld = JSON.stringify({
    "@context": "https://schema.org", "@type": "BlogPosting", headline: p.title, description: p.summary, datePublished: p.date,
    author: { "@type": "Organization", name: p.author }, publisher: { "@type": "Organization", name: b.name }, image: `${b.url}/img/${p.image}`,
    mainEntityOfPage: { "@type": "WebPage", "@id": `${b.url}/news/${p.slug}/` },
  }).replace(/</g, "\\u003c");
  const body = `
<article class="post">
  <header class="post-head">
    <nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/news/">News</a></li><li aria-current="page">${esc(p.title)}</li></ol></nav>
    <p class="eyebrow">${esc(p.category)}</p>
    <h1 class="display display--md">${esc(p.title)}</h1>
    <p class="post-meta"><time datetime="${p.date}">${longDate(p.date)}</time> · ${readMinutes(p)} min read · ${esc(p.author)}</p>
  </header>
  <figure class="post-media">${picture(p.image, p.image_alt, { sizes: "(max-width: 900px) 100vw, 900px", eager: true, field: `news ${p.slug}` })}</figure>
  <div class="post-body">
    <p class="post-lede">${esc(p.summary)}</p>
    ${p.body.map(renderBlock).join("\n    ")}
    ${p.sources.length ? `<h2>Sources</h2><ul class="sources">${p.sources.map((s) => `<li><a href="${url(s.url, "source")}" rel="noopener noreferrer">${esc(s.label)}</a></li>`).join("")}</ul>` : ""}
  </div>
  <script type="application/ld+json">${ld}</script>
</article>
<section class="cta-band" aria-labelledby="talk-h">
  <h2 class="display display--md" id="talk-h">${heading(site.home.talk)}</h2>
  <p>${esc(site.home.talk.body)}</p>
  <div class="actions"><a class="btn btn--primary" href="${talk.href}">${talk.label}</a><a class="btn btn--outline" href="${phoneHref}">Call ${esc(b.phone)}</a></div>
</section>
${related.length ? `<section class="section news-related" aria-labelledby="related-h"><h2 class="eyebrow" id="related-h">More from the garage</h2><div class="cards">${related.map((r) => newsCard(r)).join("")}</div></section>` : ""}`;
  return layout({ page: { title: `${p.title} | ${b.name}`, description: p.summary, image: p.image }, path: `/news/${p.slug}/`, body });
}

function policyPage(key, policy) {
  return layout({ page: { title: `${policy.title} | ${b.name}`, description: policy.description }, path: `/${key}/`, body: `
<section class="section policy-page">
  <p class="eyebrow">${esc(b.name)}</p><h1 class="display display--md">${esc(policy.title)}</h1>
  <p class="policy-updated">Updated 26 November 2026</p>
  ${policy.sections.map(([title, text]) => `<h2>${esc(title)}</h2><p>${esc(text)}</p>`).join('')}
  <h2>Contact the garage</h2><p>Call <a href="${phoneHref}">${esc(b.phone)}</a> during opening hours, or write to ${esc(b.name)}, ${esc(b.street)}, ${esc(b.city)}, ${esc(b.region)} ${esc(b.postal)}.</p>
  ${key === 'privacy' ? '<p>Provider policy: <a href="https://www.cloudflare.com/privacypolicy/" rel="noopener noreferrer">Cloudflare</a>.</p>' : ''}
</section>` });
}

function servicePage(item) {
  const details = serviceDetails[item.id];
  const path = `/services/${slug(item.id)}/`;
  const data = JSON.stringify({ "@context": "https://schema.org", "@type": "Service", "@id": `${b.url}${path}#service`, name: details.heading, serviceType: item.title, description: details.description, url: b.url + path, provider: { "@id": `${b.url}/#business` }, areaServed: b.service_area }).replace(/</g, "\\u003c");
  return layout({ page: { title: `${details.heading} | ${b.name}`, description: details.description, image: item.image }, path, body: `
<section class="section service-detail">
  <nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/services/">Services</a></li><li aria-current="page">${esc(item.title)}</li></ol></nav>
  <div class="service-detail-grid"><div><p class="eyebrow">${esc(b.city)} · Serving ${esc(b.county)}</p><h1 class="display display--md">${esc(details.heading)}</h1><p class="section-intro">${esc(details.description)}</p><p class="service-location">${esc(b.street)}, ${esc(b.city)} · ${esc(b.hours[0].days)}, ${esc(b.hours[0].open)} to ${esc(b.hours[0].close)}</p><a class="btn btn--primary" href="${phoneHref}">Call about ${esc(item.title.toLowerCase())}</a></div>${picture(item.image, item.alt, {eager: true, sizes: '(max-width: 900px) 100vw, 50vw'})}</div>
  <div class="service-detail-body"><h2>What we help with</h2><p>${esc(item.body)}</p><ul class="checklist">${item.list.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
  ${details.sections.map(([title, text]) => `<h2>${esc(title)}</h2><p>${esc(text)}</p>`).join('')}
  <h2>Plan your visit</h2><p>Call ${esc(b.phone)} with your vehicle's make, model and registration, what you have noticed, and your preferred day. The front desk can confirm service fit, availability and the next step. Appointments and prices are confirmed by the garage.</p><p><a class="link" href="/contact/#appointment">Contact the front desk</a> · <a class="link" href="${directions}">Get directions</a></p>
  <h2>More services at ${esc(b.name)}</h2><ul>${site.services.items.filter((other) => other.id !== item.id).map((other) => `<li><a href="/services/${slug(other.id)}/">${esc(other.title)}</a></li>`).join('')}</ul></div>
</section><script type="application/ld+json">${data}</script>` });
}

// Security headers for Cloudflare Workers static assets (and serve.mjs locally).
// Everything is served from this site: no third-party scripts, frames or fonts.
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");
const headers = `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()
  Strict-Transport-Security: max-age=31536000
  Cross-Origin-Opener-Policy: same-origin
${site.preview.noindex ? "  X-Robots-Tag: noindex, nofollow\n" : ""}
/img/*
  Cache-Control: public, max-age=604800

/brand/*
  Cache-Control: public, max-age=604800

/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/video/*
  Cache-Control: public, max-age=604800
`;

rmSync(out, { recursive: true, force: true });
const pages = { "index.html": home(), "services/index.html": services(), "about/index.html": about(), "contact/index.html": contact(), "news/index.html": newsIndex(), "404.html": notFound() };
for (const item of site.services.items) pages[`services/${slug(item.id)}/index.html`] = servicePage(item);
for (const [key, policy] of Object.entries(policies)) pages[`${key}/index.html`] = policyPage(key, policy);
for (const p of news) pages[`news/${p.slug}/index.html`] = newsPost(p);
for (const [file, html] of Object.entries(pages)) {
  mkdirSync(join(out, file, ".."), { recursive: true });
  writeFileSync(join(out, file), html);
}
cpSync(join(root, "assets/img"), join(out, "img"), { recursive: true });
if (existsSync(join(root, "assets/video"))) cpSync(join(root, "assets/video"), join(out, "video"), { recursive: true });
// Brand fonts are self-hosted from the locked @fontsource packages, so no visitor request leaves the site.
mkdirSync(join(out, "fonts"), { recursive: true });
for (const [pkg, file] of [["inter", "inter-latin-wght-normal.woff2"], ["manrope", "manrope-latin-wght-normal.woff2"]]) {
  cpSync(join(root, "node_modules/@fontsource-variable", pkg, "files", file), join(out, "fonts", file));
}
cpSync(join(root, "assets/brand"), join(out, "brand"), { recursive: true });
const { transform } = await import('esbuild');
// Keep readable source files while sending compact CSS and JavaScript to visitors.
for (const file of ['styles.css', 'site.js']) {
  const { code } = await transform(readFileSync(join(root, 'src', file), 'utf8'), {
    loader: file.endsWith('.css') ? 'css' : 'js', target: 'es2022', minify: true, legalComments: 'none',
  });
  writeFileSync(join(out, file), code);
}
writeFileSync(join(out, "_headers"), headers);
// Iris confirms which commit is live by reading this marker. Set DEPLOY_COMMIT to the full commit hash when deploying.
const deployCommit = process.env.DEPLOY_COMMIT;
if (deployCommit) {
  if (!/^[0-9a-f]{40}$/.test(deployCommit)) throw new Error("DEPLOY_COMMIT must be a full 40-character commit hash");
  writeFileSync(join(out, "foundry-source.json"), JSON.stringify({ commit: deployCommit }));
}
writeFileSync(join(out, "robots.txt"), site.preview.noindex ? "User-agent: *\nDisallow: /\n" : `User-agent: *\nAllow: /\n\nSitemap: ${b.url}/sitemap.xml\n`);
const sitemapPaths = Object.keys(pages).filter((file) => file !== "404.html").map((file) => "/" + file.replace(/index\.html$/, ""));
writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapPaths.map((path) => `  <url><loc>${esc(b.url + path)}</loc></url>`).join("\n")}\n</urlset>\n`);
console.log(`built ${Object.keys(pages).length} pages -> public/`);
