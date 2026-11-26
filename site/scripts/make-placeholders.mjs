// Writes the neutral SVG illustrations used by the demo site, plus assets/media.json.
// Kestrel Garage is fictional, so the site uses drawn placeholders instead of photographs.
// Usage: node scripts/make-placeholders.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const W = 1600, H = 1000;
const line = 'fill="none" stroke="#2DD4BF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

const scene = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2C3138"/><stop offset="1" stop-color="#16191D"/></linearGradient></defs>` +
  `<rect width="${W}" height="${H}" fill="url(#g)"/><circle cx="1320" cy="180" r="260" fill="#14B8A6" opacity=".1"/>` +
  `<path d="M0 840H1600" stroke="#2DD4BF" stroke-opacity=".25" stroke-width="4"/>${inner}</svg>\n`;
// Icon paths use a 48 by 48 grid, drawn at ten times that size in the middle of the frame.
const icon = (paths) => scene(`<g transform="translate(560 260) scale(10)" ${line}>${paths}</g>`);

const car = '<path d="M5 31l4-9a4 4 0 0 1 3.6-2.4h22.8A4 4 0 0 1 39 22l4 9v6H5z"/><circle cx="14" cy="37" r="4"/><circle cx="34" cy="37" r="4"/><path d="M12 25h24"/>';
const images = {
  "kestrel-exterior.svg": scene(
    // Drawn on the right so the homepage heading on the left stays clear.
    '<rect x="760" y="420" width="700" height="420" fill="#1F2328" stroke="#5B6670" stroke-width="4"/>' +
    '<rect x="910" y="330" width="400" height="70" rx="12" fill="#0F766E"/>' +
    [800, 1020, 1240].map((x) => `<rect x="${x}" y="530" width="180" height="310" fill="#2C3138" stroke="#5B6670" stroke-width="4"/>` +
      [570, 610, 650, 690, 730, 770, 810].map((y) => `<path d="M${x} ${y}h180" stroke="#3D4650" stroke-width="4"/>`).join("")).join("")),
  "kestrel-brakes.svg": icon('<circle cx="24" cy="24" r="15"/><circle cx="24" cy="24" r="4"/><path d="M33 12a15 15 0 0 1 4 9"/><path d="M9 24h4M35 24h4M24 9v4M24 35v4"/>'),
  "kestrel-suspension.svg": icon('<path d="M14 8h20M14 40h20"/><path d="M16 12l16 4-16 4 16 4-16 4 16 4-16 4"/>'),
  "kestrel-tyres.svg": icon('<circle cx="24" cy="24" r="16"/><circle cx="24" cy="24" r="8"/><path d="M24 8v8M24 32v8M8 24h8M32 24h8"/>'),
  "kestrel-service-bays.svg": icon(`${car}<path d="M8 44h32M12 41v3M36 41v3"/>`),
  "kestrel-under-bonnet.svg": icon('<path d="M30 8a8 8 0 0 0-7 11L9 33a3 3 0 0 0 4 4l14-14a8 8 0 0 0 11-7l-5 3-4-1-1-4z"/>'),
  "kestrel-front-desk.svg": icon('<path d="M6 30h36v12H6z"/><path d="M18 22a6 6 0 0 1 12 0"/><path d="M14 26h20M24 14v2"/>'),
  "kestrel-entrance.svg": icon('<path d="M12 42V8h24v34"/><path d="M6 42h36"/><circle cx="30" cy="26" r="1.5"/>'),
  "kestrel-waiting-room.svg": icon('<path d="M10 22v18M10 32h22v8M32 22v18"/><path d="M14 22h14v10H14z"/><path d="M38 14h4v6a2 2 0 0 1-4 0z"/>'),
};
const brand = {
  "kestrel-badge.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">' +
    '<circle cx="80" cy="80" r="76" fill="#1F2328" stroke="#14B8A6" stroke-width="6"/>' +
    '<path d="M40 92c18-4 30-14 40-34 6 16 18 26 40 30-20 2-32 8-40 24-8-14-20-20-40-20z" fill="#2DD4BF"/>' +
    '<text x="80" y="134" fill="#E8ECEF" font-family="Manrope, Inter, Arial, sans-serif" font-size="15" font-weight="800" text-anchor="middle" letter-spacing="3">KESTREL</text></svg>\n',
  "northlight-mark.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M16 2 19 13 30 16 19 19 16 30 13 19 2 16 13 13Z" fill="#14B8A6"/></svg>\n',
};

mkdirSync(join(root, "assets/img"), { recursive: true });
mkdirSync(join(root, "assets/brand"), { recursive: true });
const record = (folder, file, svg) => {
  writeFileSync(join(root, "assets", folder, file), svg);
  return { file: `${folder}/${file}`, bytes: Buffer.byteLength(svg), sha256: createHash("sha256").update(svg).digest("hex") };
};
const manifest = {
  note: "Generated placeholder illustrations for a fictional business. Regenerate with node scripts/make-placeholders.mjs.",
  images: Object.entries(images).map(([file, svg]) => record("img", file, svg)),
  brand: Object.entries(brand).map(([file, svg]) => record("brand", file, svg)),
};
writeFileSync(join(root, "assets/media.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${manifest.images.length} images and ${manifest.brand.length} brand files`);
