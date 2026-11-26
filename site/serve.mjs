// Local preview of public/ (no dependencies). Usage: node serve.mjs [port]
// Applies the "/*" block of public/_headers so CSP and other headers behave as they will on Cloudflare.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, extname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(import.meta.dirname, "public");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain", ".mp4": "video/mp4", ".xml": "application/xml; charset=utf-8" };
const globalHeaders = Object.fromEntries(
  (readFileSync(join(dir, "_headers"), "utf8").split(/\n\s*\n/)[0] ?? "")
    .split("\n").slice(1).map((l) => l.trim().split(/:\s(.+)/)).filter(([k, v]) => k && v)
);
// WebKit upgrades even loopback assets to HTTPS. This server is HTTP-only and binds to loopback.
// Keep every other CSP restriction; public/_headers and the deployed Worker stay unchanged.
globalHeaders['Content-Security-Policy'] = globalHeaders['Content-Security-Policy']?.replace(/(?:^|;\s*)upgrade-insecure-requests(?=;|$)/g, '');

export function createPreviewServer({ overrides = new Map(), localOnly = false } = {}) {
  return createServer(async (req, res) => {
    const headers = { ...globalHeaders, ...(localOnly ? { 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' } : {}) };
    try {
      if (localOnly && !/^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '')) {
        res.writeHead(403, headers).end('This preview is local only.');
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { ...headers, allow: 'GET, HEAD' }).end();
        return;
      }
      let path = decodeURIComponent(new URL(req.url, 'http://preview.local').pathname).replaceAll('\\', '/');
      const override = overrides.get(path);
      if (override) {
        res.writeHead(200, { ...headers, 'content-type': override.type }).end(req.method === 'HEAD' ? undefined : override.body);
        return;
      }
      if (path.endsWith('/')) path += 'index.html';
      const file = resolve(dir, `.${path}`);
      const within = relative(dir, file);
      if (within.startsWith('..') || path === '/_headers') throw new Error('Unavailable path');
      const body = await readFile(file);
      res.writeHead(200, { ...headers, 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { ...headers, 'content-type': types['.html'] }).end(req.method === 'HEAD' ? undefined : await readFile(join(dir, '404.html')));
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createPreviewServer().listen(Number(process.argv[2] ?? 4317), '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/`));
}
