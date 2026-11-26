import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveVideo } from '../src/video.mjs';

const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const assets = { async fetch(request) {
  assert.equal(request.headers.get('range'), null);
  assert.equal(request.headers.get('if-range'), null);
  return new Response(request.method === 'HEAD' ? null : bytes.slice(), { headers: {
    'content-type': 'video/mp4', 'content-length': '8', etag: '"test-video"',
    'cache-control': 'public, max-age=604800', 'x-content-type-options': 'nosniff',
  } });
} };
const send = (headers = {}, method = 'GET', binding = assets) => serveVideo(new Request('https://kestrel-garage.example/video/intro.mp4', { method, headers }), binding);

test('video byte ranges return the exact prefix, suffix, open end and clamped end', async () => {
  for (const [range, expected, contentRange] of [
    ['bytes=0-1', [0, 1], 'bytes 0-1/8'], ['bytes=5-', [5, 6, 7], 'bytes 5-7/8'],
    ['bytes=-2', [6, 7], 'bytes 6-7/8'], ['bytes=6-100', [6, 7], 'bytes 6-7/8'],
  ]) {
    const response = await send({ range });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(response.headers.get('content-length'), String(expected.length));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], expected);
  }
});

test('unsatisfiable video ranges return 416 and the representation size', async () => {
  for (const range of ['bytes=8-', 'bytes=6-2', 'bytes=-0']) {
    const response = await send({ range });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */8');
    assert.equal(await response.text(), '');
  }
});

test('ordinary, malformed and multiple ranges can receive the full video', async () => {
  for (const range of [undefined, 'items=0-1', 'bytes=-', 'bytes=0-1,4-5', 'bytes=9999999999999999999-']) {
    const response = await send(range ? { range } : {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytes]);
  }
});

test('If-Range only permits partial content for the current strong validator', async () => {
  for (const [condition, status] of [['"test-video"', 206], ['"old-video"', 200], ['W/"test-video"', 200]]) {
    const response = await send({ range: 'bytes=0-1', 'if-range': condition });
    assert.equal(response.status, status);
    await response.arrayBuffer();
  }
});

test('video HEAD, missing assets and disallowed methods keep their HTTP meaning', async () => {
  const head = await send({ range: 'bytes=0-1' }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '8');
  assert.equal(await head.text(), '');
  assert.equal((await send({}, 'POST')).status, 405);
  assert.equal((await send({}, 'GET', { fetch: async () => new Response('Missing', { status: 404 }) })).status, 404);
});

test('video ranges work without Content-Length and reject an oversized asset', async () => {
  const response = await send({ range: 'bytes=0-1' }, 'GET', { fetch: async () => new Response(bytes.slice(), { headers: { 'content-type': 'video/mp4' } }) });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-1/8');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 1]);
  await assert.rejects(send({ range: 'bytes=0-1' }, 'GET', { fetch: async () => new Response(new Uint8Array(1500001), { headers: { 'content-type': 'video/mp4' } }) }), /size limit/);
});
