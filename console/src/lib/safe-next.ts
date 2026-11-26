/**
 * Turns an untrusted `next` value into a path on this site. Anything that could leave the site
 * (`//evil.com`, `/\evil.com`, `https://…`, control characters) falls back to "/".
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  const base = "http://same-site.invalid";
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return "/";
  }
  // Dot segments can normalize into "//host" (`/%2e%2e//evil.com`), which a browser reads as another site.
  if (url.origin !== base || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
