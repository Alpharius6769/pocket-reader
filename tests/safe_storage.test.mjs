// Storage that cannot throw, and the boundary of where it may be used.
//
// localStorage.setItem raises QuotaExceededError once the origin is full, and
// every method can raise SecurityError where site data is blocked. An uncaught
// throw does not degrade the feature that wanted to remember something -- it
// aborts whatever handler was running, which is how a full disk becomes
// "narration stopped working".
//
// The subtlety these guard is that the facade must NOT be applied everywhere.
// Two call sites depend on the throw and would be silently broken by it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

// The mock must stay installed for the duration of the assertions, not just
// the import: the module resolves globalThis.localStorage lazily on every call
// (deliberately, since the property access itself can throw), so restoring it
// before the caller runs would test the absence of storage instead.
const withStorage = async (impl, body) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: impl, configurable: true });
  try {
    const mod = await import(`../public/assets/js/safe_storage.js?t=${Math.random()}`);
    return await body(mod);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
};

const throwing = (error) => ({
  getItem() { throw error; },
  setItem() { throw error; },
  removeItem() { throw error; },
  clear() { throw error; },
});

test('a quota-exceeded write is survivable and reports that it did not stick', async () => {
  const err = new DOMException('exceeded the quota', 'QuotaExceededError');
  await withStorage(throwing(err), ({ prLocal }) => {
    assert.equal(prLocal.setItem('k', 'v'), false, 'a refused write must report false, not throw');
    assert.equal(prLocal.getItem('k'), null);
    assert.equal(prLocal.removeItem('k'), false);
    assert.equal(prLocal.clear(), false);
  });
});

test('storage blocked outright is survivable too', async () => {
  await withStorage(throwing(new DOMException('denied', 'SecurityError')), ({ prLocal }) => {
    assert.doesNotThrow(() => prLocal.getItem('k'));
    assert.doesNotThrow(() => prLocal.setItem('k', 'v'));
  });
});

test('even reaching for the storage object can throw, and that is handled', async () => {
  // Some embedded contexts throw on the property ACCESS, before any method
  // call. Resolving it at module scope would break the import for every
  // consumer instead of one call, which is why it is resolved lazily.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    get() { throw new DOMException('denied', 'SecurityError'); },
    configurable: true,
  });
  try {
    const mod = await import(`../public/assets/js/safe_storage.js?t=${Math.random()}`);
    assert.equal(mod.prLocal.getItem('k'), null);
    assert.equal(mod.prLocal.setItem('k', 'v'), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('the success path keeps the real API semantics exactly', async () => {
  const map = new Map();
  await withStorage({
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }, ({ prLocal }) => {
    assert.equal(prLocal.getItem('missing'), null, 'missing must be null, as getItem returns');
    assert.equal(prLocal.setItem('a', '1'), true);
    assert.equal(prLocal.getItem('a'), '1');
    prLocal.removeItem('a');
    assert.equal(prLocal.getItem('a'), null);
  });
});

test('the profile save keeps the RAW api, because it needs the throw', async () => {
  // saveLocalData catches QuotaExceededError and retries with a slimmed
  // payload. A non-throwing setItem there would skip that recovery silently and
  // lose the write instead of shedding weight -- strictly worse than the
  // unguarded original.
  const library = await read('public/assets/js/library_manager.js');
  const save = library.slice(library.indexOf('function _flushLocalData'), library.indexOf('// ── Coalesced profile-commit batch'));
  assert.match(save, /localStorage\.setItem\('pocketReaderData'/,
    'the primary profile write must still be able to throw');
  assert.match(save, /localStorage\.setItem\('pocketReaderData', JSON\.stringify\(slim\)\)/,
    'and so must the slim retry');
  assert.doesNotMatch(save, /prLocal\.setItem\('pocketReaderData'/);
});

test('the storage self-test keeps the RAW api, because it is testing storage', async () => {
  // This test's whole job is to report whether storage works. Routed through
  // the facade it would report "write-read mismatch" instead of the actual
  // QuotaExceededError, which is the half of the message that tells a reader
  // what to do about it.
  const diagnostics = await read('public/assets/js/diagnostics.js');
  const block = diagnostics.slice(diagnostics.indexOf("timedTest('LocalStorage'"), diagnostics.indexOf("timedTest('Storage quota'"));
  assert.match(block, /localStorage\.setItem\('_diag_test', '1'\)/);
  assert.doesNotMatch(block, /prLocal\./);
  assert.doesNotMatch(diagnostics, /safe_storage\.js/, 'diagnostics must not import the facade at all');
});

test('every module using the facade imports it', async () => {
  for (const rel of [
    'public/assets/js/buffer_manager.js',
    'public/assets/js/ui_controller.js',
    'public/assets/js/sync_core.js',
    'public/assets/js/library_manager.js',
    'public/assets/js/audio_core.js',
  ]) {
    const source = await read(rel);
    if (!/\bprLocal\.|\bprSession\./.test(source)) continue;
    assert.match(source, /import \{ prLocal, prSession \} from '\.\/safe_storage\.js\?v=/,
      `${rel} uses the facade and must import it`);
  }
});

test('the shell and the service worker both ship it', async () => {
  // Five modules import it, so unlike the setup-only probes this genuinely
  // belongs in the atomic core list: the shell cannot run without it.
  const sw = await read('public/sw.js');
  const core = sw.slice(sw.indexOf('var CORE_ASSETS = ['), sw.indexOf('// Best-effort cache fill'));
  assert.match(core, /safe_storage\.js\?v=/);
  assert.match(await read('public/index.html'), /modulepreload" href="assets\/js\/safe_storage\.js\?v=/);
});
