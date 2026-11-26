// Workers Static Assets returns full files for Range requests. Supply single byte
// ranges for the two small, local opening clips so browsers can seek and buffer them.
export async function serveVideo(request, assets) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const incoming = new Headers(request.headers);
  incoming.delete('range');
  incoming.delete('if-range');
  const response = await assets.fetch(new Request(request, { headers: incoming }));
  if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('video/mp4')) return response;
  const headers = new Headers(response.headers);
  headers.set('accept-ranges', 'bytes');
  const full = () => new Response(response.body, { headers });
  const range = request.headers.get('range');
  const condition = request.headers.get('if-range');
  const unchanged = !condition || (!condition.startsWith('W/') &&
    (condition === headers.get('etag') || condition === headers.get('last-modified')));
  const encoding = headers.get('content-encoding');
  if (request.method === 'HEAD' || !range || !unchanged || (encoding && encoding !== 'identity')) return full();
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  // Multiple or malformed ranges are optional in HTTP. Return the full representation.
  if (!match || (!match[1] && !match[2])) return full();
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ([first, last].some(value => value !== undefined && !Number.isSafeInteger(value))) return full();
  // The assets binding may omit Content-Length. Read the small clip with an explicit
  // limit instead of relying on a header that appears only on the outer HTTP response.
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.byteLength;
      if (size > 1500000) throw new Error('Opening video exceeds the reviewed size limit');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const start = first === undefined ? Math.max(0, size - last) : first;
  const end = first === undefined || last === undefined ? size - 1 : Math.min(last, size - 1);
  if (start >= size || end < start) {
    headers.set('content-range', `bytes */${size}`);
    headers.set('content-length', '0');
    return new Response(null, { status: 416, headers });
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  headers.set('content-range', `bytes ${start}-${end}/${size}`);
  headers.set('content-length', String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}
