import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/cloudflare_worker.js';

const MODEL_URL = 'https://pocket-reader-proxy.example/models/Pocket%20TTS%20Onnx/english_2026-04/flow_lm_unified_block4_int8.onnx';
const ORIGIN = 'https://pocket-reader-f2y.pages.dev';

function installHarness() {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const entries = new Map();
  let fetches = 0;
  let puts = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Bz-Content-Sha1': 'test-sha1',
      },
    });
  };
  globalThis.caches = {
    default: {
      async match(key) {
        return entries.get(key.url)?.clone() || undefined;
      },
      async put(key, response) {
        puts += 1;
        entries.set(key.url, response.clone());
      },
    },
  };
  return {
    get fetches() { return fetches; },
    get puts() { return puts; },
    restore() {
      globalThis.fetch = originalFetch;
      globalThis.caches = originalCaches;
    },
  };
}

test('immutable model GETs are cached without baking in origin-specific CORS', async () => {
  const harness = installHarness();
  try {
    const pending = [];
    const ctx = { waitUntil(value) { pending.push(value); } };
    const request = new Request(MODEL_URL, { headers: { Origin: ORIGIN } });
    const first = await worker.fetch(request, {}, ctx);
    await Promise.all(pending);
    const second = await worker.fetch(request, {}, ctx);
    assert.equal(first.headers.get('X-Pocket-Edge-Cache'), 'MISS');
    assert.equal(second.headers.get('X-Pocket-Edge-Cache'), 'HIT');
    assert.equal(second.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(await second.arrayBuffer().then((value) => value.byteLength), 4);
    assert.equal(harness.fetches, 1);
    assert.equal(harness.puts, 1);
  } finally {
    harness.restore();
  }
});

test('range requests bypass whole-object edge caching', async () => {
  const harness = installHarness();
  try {
    const ctx = { waitUntil() {} };
    const request = new Request(MODEL_URL, { headers: { Origin: ORIGIN, Range: 'bytes=0-99' } });
    const response = await worker.fetch(request, {}, ctx);
    assert.equal(response.headers.get('X-Pocket-Edge-Cache'), 'BYPASS');
    assert.equal(harness.fetches, 1);
    assert.equal(harness.puts, 0);
  } finally {
    harness.restore();
  }
});

test('generic proxy rejects unauthenticated non-browser callers', async () => {
  const request = new Request(
    'https://pocket-reader-proxy.example/?url='
      + encodeURIComponent('https://archiveofourown.org/works/123'),
  );
  const response = await worker.fetch(request, { PROXY_AUTH_TOKEN: 'server-secret' }, { waitUntil() {} });
  assert.equal(response.status, 403);
});

test('generic proxy accepts allowed localhost browser origins without a proxy key', async () => {
  const originalFetch = globalThis.fetch;
  let upstream;
  globalThis.fetch = async (request) => {
    upstream = request;
    return new Response('ok');
  };
  try {
    const target = 'https://archiveofourown.org/works/123';
    const request = new Request(
      'https://pocket-reader-proxy.example/?url=' + encodeURIComponent(target),
      { headers: { Origin: 'http://localhost:3000' } },
    );
    // Loopback is a development affordance and must be opted into. Without the
    // flag, production reflected CORS for any port or scheme on localhost.
    const response = await worker.fetch(
      request,
      { ALLOW_LOCALHOST_ORIGINS: '1' },
      { waitUntil() {} },
    );
    assert.equal(response.status, 200);
    assert.equal(upstream.method, 'GET');

    const denied = await worker.fetch(
      new Request(
        'https://pocket-reader-proxy.example/?url=' + encodeURIComponent(target),
        { headers: { Origin: 'http://localhost:3000' } },
      ),
      {},
      { waitUntil() {} },
    );
    assert.equal(denied.status, 403, 'localhost must be denied unless explicitly enabled');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generic proxy accepts the backend token, strips sensitive headers, and is read-only', async () => {
  const originalFetch = globalThis.fetch;
  let upstream;
  globalThis.fetch = async (request) => {
    upstream = request;
    return new Response('ok');
  };
  try {
    const target = 'https://archiveofourown.org/works/123';
    const base = 'https://pocket-reader-proxy.example/?url=' + encodeURIComponent(target);
    const rejected = await worker.fetch(
      new Request(base, { method: 'POST', body: 'nope' }),
      { PROXY_AUTH_TOKEN: 'server-secret' },
      { waitUntil() {} },
    );
    assert.equal(rejected.status, 405);

    const accepted = await worker.fetch(
      new Request(base, {
        headers: {
          'X-Pocket-Proxy-Key': 'server-secret',
          Authorization: 'must-not-leak',
          Cookie: 'must-not-leak',
          Accept: 'text/html',
        },
      }),
      { PROXY_AUTH_TOKEN: 'server-secret' },
      { waitUntil() {} },
    );
    assert.equal(accepted.status, 200);
    assert.equal(upstream.method, 'GET');
    assert.equal(upstream.headers.get('Accept'), 'text/html');
    assert.equal(upstream.headers.has('Authorization'), false);
    assert.equal(upstream.headers.has('Cookie'), false);
    assert.equal(upstream.headers.has('X-Pocket-Proxy-Key'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HF Space proxy forwards the Worker secret as a bearer token', async () => {
  const originalFetch = globalThis.fetch;
  let upstream;
  globalThis.fetch = async (request) => {
    upstream = request;
    return new Response('ok');
  };
  try {
    const request = new Request('https://pocket-reader-proxy.example/api/sync/chapters?limit=1', {
      headers: {
        Authorization: 'must-not-leak',
      },
    });
    const response = await worker.fetch(
      request,
      { HF_TOKEN: 'hf_test_token' },
      { waitUntil() {} },
    );
    assert.equal(response.status, 200);
    assert.equal(upstream.url, 'https://alpharius6769-pocket-reader.hf.space/api/sync/chapters?limit=1');
    assert.equal(upstream.headers.get('Authorization'), 'Bearer hf_test_token');
    assert.equal(upstream.headers.has('Cookie'), false);
    assert.equal(upstream.headers.has('X-Pocket-Proxy-Key'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scheduled sync manually rejects redirects while carrying the admin secret', async () => {
  const originalFetch = globalThis.fetch;
  let options;
  globalThis.fetch = async (_url, init) => {
    options = init;
    return new Response('{}');
  };
  try {
    const pending = [];
    worker.scheduled(
      {},
      { CHAPTER_SYNC_URL: 'https://backend.example/api/sync', ADMIN_PUSH_SECRET: 'secret' },
      { waitUntil(value) { pending.push(value); } },
    );
    await Promise.all(pending);
    assert.equal(options.redirect, 'manual');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scheduled sync forwards the HF bearer token to the private Space', async () => {
  const originalFetch = globalThis.fetch;
  let options;
  globalThis.fetch = async (_url, init) => {
    options = init;
    return new Response('{}');
  };
  try {
    const pending = [];
    worker.scheduled(
      {},
      {
        CHAPTER_SYNC_URL: 'https://backend.example/api/sync',
        ADMIN_PUSH_SECRET: 'secret',
        HF_TOKEN: 'hf_test_token',
      },
      { waitUntil(value) { pending.push(value); } },
    );
    await Promise.all(pending);
    assert.equal(options.headers.Authorization, 'Bearer hf_test_token');
    assert.equal(options.headers['X-Admin-Secret'], 'secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
