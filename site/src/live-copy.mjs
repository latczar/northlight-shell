// Live and Preview copy from Northlight. The pages are built from site.json; staff approve new page titles and
// descriptions in the Northlight console, which first show on Preview and reach Live when someone presses Publish.
// The Worker asks the agent (SITE_COPY service binding, never the internet) for the copy and swaps it into each page.
//
// Preview: open any page with ?preview=1 (a cookie keeps it on while browsing); ?preview=0 goes back to Live.

const COOKIE = 'nl_preview';

/** Page key: the path without a trailing slash ("/" for the home page), as the agent stores it. */
export function pagePath(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

/** A ?preview=1 or ?preview=0 visit: where to send the browser and the cookie to set, or null. */
export function previewSwitch(url) {
  const value = url.searchParams.get('preview');
  if (value !== '1' && value !== '0') return null;
  const target = new URL(url);
  target.searchParams.delete('preview');
  const on = value === '1';
  return {
    location: target.pathname + target.search + target.hash,
    cookie: on ? `${COOKIE}=1; Path=/; Secure; HttpOnly; SameSite=Lax` : `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
  };
}

export function inPreview(request) {
  return (request.headers.get('cookie') ?? '').split(/;\s*/).includes(`${COOKIE}=1`);
}

const BAR = '<div role="status" style="position:sticky;top:0;z-index:1000;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:center;padding:10px 16px;background:#0f766e;color:#fff;font:600 15px/1.4 Inter,Arial,sans-serif;text-align:center">'
  + '<span>Preview: changes waiting to be published. Visitors do not see them yet.</span>'
  + '<a href="?preview=0" style="color:#fff;text-decoration:underline">See the live site</a></div>';

/** Swaps the page's title and description for the approved copy, and marks Preview pages. */
export function applyCopy(response, page, preview) {
  if (!preview && !page?.title && !page?.description) return response;
  const rewriter = new HTMLRewriter();
  if (page?.title) {
    rewriter.on('title', { element(el) { el.setInnerContent(page.title); } });
    rewriter.on('meta[property="og:title"]', { element(el) { el.setAttribute('content', page.title); } });
  }
  if (page?.description) {
    rewriter.on('meta[name="description"]', { element(el) { el.setAttribute('content', page.description); } });
    rewriter.on('meta[property="og:description"]', { element(el) { el.setAttribute('content', page.description); } });
  }
  if (preview) {
    rewriter.on('meta[name="robots"]', { element(el) { el.remove(); } });
    rewriter.on('head', { element(el) { el.append('<meta name="robots" content="noindex">', { html: true }); } });
    rewriter.on('body', { element(el) { el.prepend(BAR, { html: true }); } });
  }
  const out = rewriter.transform(response);
  if (!preview) return out;
  const headers = new Headers(out.headers);
  headers.set('cache-control', 'private, no-store');
  headers.set('x-robots-tag', 'noindex');
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
}

/**
 * Serves one request from the built pages with the Live or Preview copy applied. Anything that is not an HTML page
 * passes through untouched; if the copy cannot be read, the built page is served as it is.
 */
export async function withSiteCopy(request, env, serve) {
  const url = new URL(request.url);
  const toggle = previewSwitch(url);
  if (toggle) return new Response(null, { status: 302, headers: { location: toggle.location, 'set-cookie': toggle.cookie, 'cache-control': 'no-store' } });
  const response = await serve(request);
  const html = (response.headers.get('content-type') ?? '').includes('text/html');
  if (!html || !env.SITE_COPY || !env.NORTHLIGHT_CLIENT || (request.method !== 'GET' && request.method !== 'HEAD')) return response;
  const preview = inPreview(request);
  let pages = {};
  try {
    pages = await env.SITE_COPY.pages(env.NORTHLIGHT_CLIENT, preview ? 'preview' : 'live');
  } catch (error) {
    console.error('site copy unavailable', error instanceof Error ? error.message.slice(0, 120) : typeof error);
  }
  return applyCopy(response, pages[pagePath(url.pathname)], preview);
}
