// Regression guards for the full-codebase audit fixes.
// Each test pins the specific defect it replaced, so a future refactor that
// reintroduces the shape fails here rather than in production.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFile(path.join(ROOT, relative), 'utf8');

test('the Cloudflare Worker /api proxy refuses callers with neither an origin nor a token', async () => {
  const source = await read('worker/cloudflare_worker.js');
  const apiBlock = source.slice(
    source.indexOf('if (url.pathname.startsWith("/api/"))'),
    source.indexOf('if (request.method !== "GET" && request.method !== "HEAD")'),
  );
  assert.ok(apiBlock.length > 0, '/api/ proxy block not found');

  // The HF_TOKEN is attached inside this block, so an absent Origin header must
  // not skip authorisation — that let anyone curl the private Space.
  assert.match(apiBlock, /!allowedOrigin && !backendAuthorized/);
  const gateIndex = apiBlock.indexOf('!allowedOrigin && !backendAuthorized');
  // Anchor on the credential-attaching statement, not the identifier, so a
  // mention of HF_TOKEN in a comment cannot satisfy or break the ordering check.
  const tokenIndex = apiBlock.indexOf('hfHeaders.set("Authorization"');
  assert.ok(gateIndex >= 0, 'the /api/ proxy must gate on origin or token');
  assert.ok(tokenIndex > gateIndex,
    'the auth gate must run before the HF token is attached to the upstream request');

  // backendAuthorized is resolved once and shared with the generic ?url= proxy.
  assert.equal(source.match(/const backendAuthorized = Boolean\(/g)?.length, 1);
  assert.equal(source.match(/!allowedOrigin && !backendAuthorized/g)?.length, 2);
});

test('inline onclick handlers never interpolate an unescaped single quote', async () => {
  // encodeURIComponent leaves ' unescaped and HTML entity decoding runs before
  // the JS parser, so every value reaching a single-quoted JS string inside an
  // attribute must be %27-encoded (or whitelist-stripped) at its definition.
  const files = (await fs.readdir(path.join(ROOT, 'public/assets/js')))
    .filter((name) => name.endsWith('.js'));
  const unguarded = [];

  for (const name of files) {
    const text = await read(`public/assets/js/${name}`);
    const call = /onclick="[^"]*'\$\{([^}]*)\}'/g;
    let match;
    while ((match = call.exec(text)) !== null) {
      const expr = match[1].trim();
      if (/%27|inlineArg|_encodeForInlineHandler/.test(expr)) continue;
      const escaped = expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const definition = text.match(new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*([^;\\n]*)`));
      const source = definition ? definition[1] : '';
      // %27 encoding, or a whitelist strip that cannot emit a quote at all.
      const safe = /%27/.test(source) || /replace\(\/\[\^[^/]*\]\/g,\s*''\)/.test(source);
      if (!safe) unguarded.push(`${name}: \${${expr}} = ${source.trim() || '<no local definition>'}`);
    }
  }

  assert.deepEqual(unguarded, [], `unescaped inline-handler interpolation:\n  ${unguarded.join('\n  ')}`);
});

test('a completed Pocket generation releases its worker slot exactly once', async () => {
  const source = await read('public/assets/js/audio_core.js');
  const onMessage = source.slice(
    source.indexOf("data.type === 'generate_done'"),
    source.indexOf('worker.onerror = (err)'),
  );
  assert.ok(onMessage.length > 0, 'generate_done handler not found');
  // The finally in _runPocketWorkerGeneration owns the release; decrementing
  // here too drove activeTasks to 0 for a still-busy worker and broke the
  // least-loaded dispatch across a two-worker cache pool.
  assert.doesNotMatch(onMessage, /activeTasks = Math\.max/);

  const increments = source.match(/workerObj\.activeTasks\+\+/g) || [];
  const decrements = source.match(/activeTasks = Math\.max\(0, \w+\.activeTasks - 1\)/g) || [];
  assert.equal(increments.length, 1, 'activeTasks should be incremented in one place');
  assert.equal(decrements.length, 1, 'activeTasks should be decremented in one place');
});

test('a voice that resolved to a fallback asset is memoised under the requested id', async () => {
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /_pocketVoiceFallbacks/);
  // Without memoising targetVoice the early-return never hit, so every
  // paragraph re-ran fetch -> candidate chain -> worker re-registration.
  assert.match(source, /_encodedPocketVoices\.add\(targetVoice\)/);
  assert.match(source, /_pocketVoiceFallbacks\.set\(targetVoice, loadedVoice\)/);
  // ...and the early return must hand back the asset the workers actually hold.
  assert.match(source, /_pocketVoiceFallbacks\.get\(targetVoice\) \|\| targetVoice/);
  // Every teardown path clears both structures together.
  assert.match(source, /function _resetPocketVoiceRegistry/);
  assert.ok((source.match(/_resetPocketVoiceRegistry\(\)/g) || []).length >= 5);
});

test('the cache loop only skips its delay for a hidden page, not an unfocused one', async () => {
  const source = await read('public/assets/js/buffer_manager.js');
  const scheduler = source.slice(
    source.indexOf('_scheduleLoop(gen, delay = 0)'),
    source.indexOf('_recordThermalSample'),
  );
  assert.ok(scheduler.length > 0, '_scheduleLoop not found');
  // hasFocus() in the zero-delay condition cancelled every deliberate backoff
  // (notably the 1500ms post-failure pause) on any unfocused window.
  assert.doesNotMatch(scheduler, /hasFocus/);
  assert.match(scheduler, /if \(delay === 0\)/);
  assert.match(scheduler, /if \(document\.hidden\)/);
});

test('loadStory clears the active-abort slot only when it still owns it', async () => {
  const source = await read('public/assets/js/api_core.js');
  assert.match(source, /if \(_activeLoadAbort === ownAbort\) _activeLoadAbort = null;/);
  assert.doesNotMatch(source, /finally \{\s*_activeLoadAbort = null;\s*\}/);
  // The non-AO3 scrape path must register a controller too, or it cannot be
  // superseded and can clobber currentStory after the user moved on.
  assert.match(source, /ownAbort = scrapeController;/);
  assert.match(source, /scrapeController\._superseded/);
});

test('the profile write strips chapters before cloning, not after', async () => {
  const source = await read('public/assets/js/library_manager.js');
  const flush = source.slice(
    source.indexOf('function _flushLocalData'),
    source.indexOf('// ── Coalesced profile-commit batch'),
  );
  assert.ok(flush.length > 0, '_flushLocalData not found');
  // This runs once per narrated paragraph; the old order deep-cloned the whole
  // opened story's text and then deleted it.
  assert.match(flush, /const \{ library, avatar, \.\.\.profileRest \} = window\.userProfile;/);
  assert.match(flush, /const \{ chapters, \.\.\.rest \} = story;/);
  assert.doesNotMatch(flush, /JSON\.parse\(JSON\.stringify\(window\.userProfile\)\)/);
  assert.doesNotMatch(flush, /if \(story\.chapters\) delete story\.chapters;/);
});

test('the cache-job resume record is not rewritten on every UI tick', async () => {
  const source = await read('public/assets/js/buffer_manager.js');
  assert.match(source, /CACHE_JOB_PERSIST_INTERVAL_MS/);
  // updateUI runs on a 1s interval for the whole job.
  assert.match(source, /_persistCacheJob\(this, \{ force: false \}\)/);
  // pagehide / visibilitychange / pause still force an immediate write.
  assert.ok((source.match(/_persistCacheJob\((?:this|BufferManager)\)/g) || []).length >= 3);
});

test('reading cached chapters compares structurally instead of stringifying twice', async () => {
  const source = await read('public/assets/js/storage_core.js');
  assert.match(source, /function _chaptersDiffer/);
  assert.match(source, /if \(_chaptersDiffer\(stored, canonical\)\)/);
  assert.doesNotMatch(source, /JSON\.stringify\(canonical\) !== JSON\.stringify\(stored\)/);
});

test('app.py carries no leftovers from the never-wired scrape path', async () => {
  const source = await read('backend/app.py');
  assert.doesNotMatch(source, /def _resolve_is_blocked/);
  for (const dead of ['zyte_fetch_binary', 'zyte_fetch,']) {
    assert.ok(!source.includes(dead), `${dead} is imported but unused`);
  }
  // ...and the machinery that DID exist is now actually reachable.
  assert.match(source, /@app\.post\("\/api\/scrape"\)/);
  assert.match(source, /class ScrapeRequest/);
});
