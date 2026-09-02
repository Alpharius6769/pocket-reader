// The Capacitor build serves its pages from https://localhost, and the Worker
// used to 403 that origin on EVERY route before any route gate ran -- including
// the public B2 model assets a caller sending no Origin at all could already
// fetch. These lock in the split that fixed it: a native origin is reflectable
// for CORS but authorises nothing, so public assets flow and the
// credential-attaching routes still demand a real key.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import worker from '../worker/cloudflare_worker.js';

const PROXY = 'https://pocket-reader-proxy.example';
const WEB_ORIGIN = 'https://alpharius6769.github.io';
const NATIVE_ORIGINS = ['https://localhost', 'http://localhost', 'capacitor://localhost'];
const MODEL_PATH = '/models/onnxruntime/1.27.0/ort-wasm-simd-threaded.jsep.mjs';
const APP_TOKEN = 'native-app-token';

function stubFetch(body = 'ok', headers = {}) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    seen.push(input instanceof Request ? input : new Request(input, init));
    return new Response(body, { status: 200, headers });
  };
  return {
    seen,
    restore() { globalThis.fetch = original; },
  };
}

const ctx = { waitUntil() {} };

test('native app origins reach the public model assets they were locked out of', async () => {
  const stub = stubFetch(new Uint8Array([1, 2, 3, 4]), { 'Content-Type': 'application/octet-stream' });
  try {
    for (const origin of NATIVE_ORIGINS) {
      const response = await worker.fetch(
        new Request(PROXY + MODEL_PATH, { headers: { Origin: origin } }),
        {},
        ctx,
      );
      assert.equal(response.status, 200, `${origin} must reach model assets`);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(response.headers.get('Vary'), 'Origin');
    }
  } finally {
    stub.restore();
  }
});

test('an unknown origin is still refused outright on every route', async () => {
  const stub = stubFetch();
  try {
    for (const path of [MODEL_PATH, '/api/health', '/catalog-api/community-snapshot']) {
      const response = await worker.fetch(
        new Request(PROXY + path, { headers: { Origin: 'https://evil.example' } }),
        { APP_PROXY_TOKEN: APP_TOKEN },
        ctx,
      );
      assert.equal(response.status, 403, `${path} must refuse an unknown origin`);
    }
    assert.equal(stub.seen.length, 0, 'a refused origin must never reach upstream');
  } finally {
    stub.restore();
  }
});

test('a native origin alone does not unlock the credential-attaching routes', async () => {
  const stub = stubFetch();
  try {
    const routes = [
      '/api/health',
      '/catalog-api/community-snapshot',
      '/?url=' + encodeURIComponent('https://archiveofourown.org/works/1'),
    ];
    for (const origin of NATIVE_ORIGINS) {
      for (const route of routes) {
        const response = await worker.fetch(
          new Request(PROXY + route, { headers: { Origin: origin } }),
          { APP_PROXY_TOKEN: APP_TOKEN, HF_TOKEN: 'hf-secret' },
          ctx,
        );
        assert.equal(response.status, 403, `${origin} ${route} must still require a key`);
        // The build engineer gets a message they can act on rather than the
        // generic refusal, which is what made this cost a debugging session.
        const body = await response.text();
        assert.match(body, /inject_native_app_key/);
      }
    }
    assert.equal(stub.seen.length, 0, 'an unkeyed native caller must never reach upstream');
  } finally {
    stub.restore();
  }
});

test('the injected app key unlocks exactly the routes the app needs', async () => {
  const stub = stubFetch('{}', { 'Content-Type': 'application/json' });
  try {
    for (const route of ['/api/health', '/catalog-api/community-snapshot']) {
      const response = await worker.fetch(
        new Request(PROXY + route, {
          headers: { Origin: 'https://localhost', 'X-Pocket-Proxy-Key': APP_TOKEN },
        }),
        { APP_PROXY_TOKEN: APP_TOKEN, HF_TOKEN: 'hf-secret' },
        ctx,
      );
      assert.equal(response.status, 200, `${route} must accept the app key`);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://localhost');
    }
  } finally {
    stub.restore();
  }
});

test('the app key is separate from the backend hop token in both directions', async () => {
  const stub = stubFetch('{}', { 'Content-Type': 'application/json' });
  try {
    // A leaked app key must not let its holder speak as the backend, and the
    // backend's own token must keep working. Rotating one cannot disturb the other.
    const appKeyOnly = await worker.fetch(
      new Request(PROXY + '/api/health', { headers: { 'X-Pocket-Proxy-Key': APP_TOKEN } }),
      { PROXY_AUTH_TOKEN: 'backend-hop-token' },
      ctx,
    );
    assert.equal(appKeyOnly.status, 403, 'the app key must not authenticate against the backend token');

    const backendToken = await worker.fetch(
      new Request(PROXY + '/api/health', { headers: { 'X-Pocket-Proxy-Key': 'backend-hop-token' } }),
      { PROXY_AUTH_TOKEN: 'backend-hop-token', APP_PROXY_TOKEN: APP_TOKEN },
      ctx,
    );
    assert.equal(backendToken.status, 200, 'the backend hop must be unaffected');
  } finally {
    stub.restore();
  }
});

test('an unset APP_PROXY_TOKEN authorises nobody', async () => {
  const stub = stubFetch();
  try {
    for (const env of [{}, { APP_PROXY_TOKEN: '' }]) {
      for (const key of ['', 'anything']) {
        const response = await worker.fetch(
          new Request(PROXY + '/api/health', {
            headers: { Origin: 'https://localhost', 'X-Pocket-Proxy-Key': key },
          }),
          env,
          ctx,
        );
        assert.equal(response.status, 403, 'an inert app-key path must never authorise');
      }
    }
    assert.equal(stub.seen.length, 0);
  } finally {
    stub.restore();
  }
});

test('preflight is answered for native origins so the keyed header is allowed', async () => {
  for (const origin of NATIVE_ORIGINS) {
    const response = await worker.fetch(
      new Request(PROXY + '/api/health', { method: 'OPTIONS', headers: { Origin: origin } }),
      {},
      ctx,
    );
    assert.ok(response.status < 400, `${origin} preflight must not be refused`);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.match(response.headers.get('Access-Control-Allow-Headers'), /X-Pocket-Proxy-Key/);
  }
  const refused = await worker.fetch(
    new Request(PROXY + '/api/health', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }),
    {},
    ctx,
  );
  assert.equal(refused.status, 403);
});

test('the trusted web origin keeps working without any key', async () => {
  const stub = stubFetch('{}', { 'Content-Type': 'application/json' });
  try {
    for (const route of ['/api/health', '/catalog-api/community-snapshot', MODEL_PATH]) {
      const response = await worker.fetch(
        new Request(PROXY + route, { headers: { Origin: WEB_ORIGIN } }),
        { HF_TOKEN: 'hf-secret' },
        ctx,
      );
      assert.equal(response.status, 200, `${route} must still serve the web build`);
    }
  } finally {
    stub.restore();
  }
});

// --- the client half -------------------------------------------------------

test('the shipped key slot is empty, because public/ is published verbatim', async () => {
  const source = await readFile('public/assets/js/native_app_key.js', 'utf8');
  const match = source.match(/^const NATIVE_APP_PROXY_KEY = '([^']*)';/m);
  assert.ok(match, 'the injectable key line must exist for the injector to find');
  assert.equal(match[1], '', 'a key committed to public/ would be served on GitHub Pages');
});

test('the key decorator covers the credential routes and spares the model routes', async () => {
  const source = await readFile('public/assets/js/native_app_key.js', 'utf8');
  const module = await import('../public/assets/js/native_app_key.js');
  assert.equal(module.nativeAppProxyKey(), '');
  assert.equal(module.installNativeAppProxyKey({}), false, 'no key means no decoration at all');

  // Model and ORT traffic must stay preflight-free: a non-safelisted header on
  // those would add a round trip in front of every weight fetch.
  assert.match(source, /KEYED_PATH_PREFIXES = \['\/api\/', '\/catalog-api'\]/);
  assert.doesNotMatch(source, /KEYED_PATH_PREFIXES[^\]]*\/models/);
});

test('the injector refuses to write into the published source tree', async () => {
  const source = await readFile('tools/inject_native_app_key.mjs', 'utf8');
  assert.match(source, /refusing to write into public\//);
  // Resolved-path comparison, not a substring test: a mistyped --target that
  // lands in public/ is the single mistake that publishes the key.
  assert.match(source, /path\.resolve\('public'\)/);
  assert.match(source, /resolved\.startsWith\(forbidden \+ path\.sep\)/);
});
