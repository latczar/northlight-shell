// The client dashboard page. Static HTML; the staff pass travels in the URL fragment (#...), which
// browsers never send to the server or put in logs. The script sends it as a header and renders
// cards with textContent only, so card text can never become markup.

export function dashboardPage(clientId: string): Response {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Agent dashboard</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 860px; padding: 24px 16px; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .muted { opacity: .7; font-size: .9rem; }
  .card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 10px; padding: 14px 16px; margin: 14px 0; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; font-size: .85rem; opacity: .75; }
  .kind { font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
  .needs_approval .kind { color: #b45309; }
  .alert { border-color: #dc2626; } .alert .kind { color: #dc2626; }
  h2 { font-size: 1.1rem; margin: 6px 0; }
  p { white-space: pre-wrap; margin: 6px 0; }
  table { border-collapse: collapse; margin: 8px 0; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 3px 10px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
  th:first-child, td:first-child { text-align: left; }
  details { margin-top: 6px; } pre { overflow-x: auto; font-size: .8rem; }
</style>
</head>
<body>
<h1>Agent dashboard</h1>
<div class="muted" id="status" role="status">Loading…</div>
<main id="cards"></main>
<script nonce="${nonce}">
const pass = decodeURIComponent(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; };
const status = document.getElementById("status");
// Ads results get a readable table; anything else is shown as raw data.
function adsTable(result) {
  const rows = [];
  for (const platform of ["google", "meta"]) {
    const p = result[platform]; if (!p) continue;
    if (!p.connected || p.error) { rows.push([platform, p.error || "not connected"]); continue; }
    for (const period of ["yesterday", "last_7_days"]) {
      const t = p[period]; if (!t) continue;
      rows.push([platform + " · " + period.replace(/_/g, " "), t.currency + " " + t.spend, t.clicks, t.conversions, t.costPerConversion ?? "—"]);
    }
  }
  const table = el("table");
  if (rows.some(r => r.length > 2)) {
    const head = table.insertRow();
    for (const h of ["", "Spend", "Clicks", "Conversions", "Cost / conv."]) head.appendChild(el("th", "", h));
  }
  for (const r of rows) {
    const tr = table.insertRow();
    r.forEach((v, i) => { const td = el("td", "", v); if (r.length === 2 && i === 1) { td.colSpan = 4; td.style.textAlign = "left"; } tr.appendChild(td); });
  }
  return table;
}
async function load() {
  if (!pass) { status.textContent = "This link is missing its access pass."; return; }
  const res = await fetch(${JSON.stringify(`/v1/clients/${clientId}/dashboard`)}, { headers: { "x-dashboard-pass": pass } });
  if (!res.ok) { status.textContent = res.status === 401 ? "This link has expired or is not valid. Ask for a new one." : "Could not load the dashboard."; return; }
  const { cards } = await res.json();
  status.textContent = cards.length ? cards.length + " recent item(s)" : "Nothing yet. Your agents' reports will appear here.";
  const root = document.getElementById("cards");
  for (const c of cards) {
    const card = el("article", "card " + c.kind);
    const meta = el("div", "meta");
    meta.append(el("span", "kind", c.kind.replace(/_/g, " ")), el("span", "", c.agent), el("span", "", new Date(c.updatedAt).toLocaleString()));
    card.append(meta, el("h2", "", c.title), el("p", "", c.summary));
    for (const result of Object.values(c.data || {})) {
      if (result && (result.google || result.meta)) card.append(adsTable(result));
    }
    if (Object.keys(c.data || {}).length) {
      const d = el("details"); d.append(el("summary", "", "Source data"), el("pre", "", JSON.stringify(c.data, null, 2))); card.append(d);
    }
    root.append(card);
  }
}
load().catch(() => { status.textContent = "Could not load the dashboard."; });
</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      "x-content-type-options": "nosniff",
    },
  });
}
