import test from 'node:test';
import assert from 'node:assert/strict';

test('cookiesForUrl only returns cookies for the real site hostname', async () => {
  const store = new Map([
    ['pocketReaderCookies', JSON.stringify({
      fa: { a: 'fa-a', b: 'fa-b' },
      sofurry: { sf_session: 'sf-session' },
    })],
  ]);

  const sessionStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  };

  globalThis.window = { POCKET_READER_CONFIG: {} };
  globalThis.sessionStorage = sessionStorage;

  try {
    const module = await import(`../public/assets/js/api_core.js?cookie-test=${Date.now()}`);
    assert.equal(module.cookiesForUrl('https://attacker.example/?next=furaffinity.net'), null);
    assert.deepEqual(module.cookiesForUrl('https://www.furaffinity.net/view/1'), { fa: { a: 'fa-a', b: 'fa-b' } });
    assert.deepEqual(module.cookiesForUrl('https://www.sofurry.com/view/1'), { sofurry: { sf_session: 'sf-session' } });
  } finally {
    delete globalThis.window;
    delete globalThis.sessionStorage;
  }
});