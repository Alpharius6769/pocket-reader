// Frontend <-> backend API route contract.
//
// Why this exists: /api/scrape and /api/upload were called by the frontend on
// every story ingestion path but were never defined in backend/app.py. In
// production both returned 404, so all non-AO3 sources failed behind a
// misleading "Cloudflare Shield Active" dialog, and every upload (including the
// AO3 FicHub EPUB step) silently fell back to readAsText() on a zip container
// and stored binary mojibake as the story text. 209 tests passed throughout,
// because nothing asserted that a called route actually exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function readIfPresent(relative) {
  const full = path.join(ROOT, relative);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

function frontendSources() {
  const jsDir = path.join(ROOT, 'public/assets/js');
  const files = fs.readdirSync(jsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => `public/assets/js/${name}`);
  return [...files, 'public/index.html', 'public/sw.js'];
}

// Every /api/... path reachable from a frontend fetch against OUR backend.
// Template-literal interpolations are normalised to a ':param' segment so a
// route built as `/api/send-push/${id}` still matches /api/send-push/{user_id}.
//
// Two accepted shapes, both anchored so a third-party absolute URL that merely
// contains "/api/" (FicHub's https://fichub.net/api/v0/epub) is never counted:
//   1. interpolated against our API base -- `${window.HF_API_BASE}/api/x`
//   2. a bare internal reference literal -- '/api/library/curated/'
const SEGMENT = '[A-Za-z0-9_\\-/{}.]';
const CALL_PATTERNS = [
  new RegExp(`\\$\\{[^}]*(?:HF_API_BASE|apiBase)[^}]*\\}(\\/api\\/(?:${SEGMENT}|\\$\\{[^}]*\\})*)`, 'g'),
  new RegExp(`(?:^|[\`'"(\\s,=])(\\/api\\/(?:${SEGMENT}|\\$\\{[^}]*\\})*)`, 'gm'),
];

function calledApiPaths() {
  const found = new Map(); // path -> Set(source files)
  for (const relative of frontendSources()) {
    const text = readIfPresent(relative);
    if (!text) continue;
    for (const pattern of CALL_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const normalised = match[1]
          .replace(/\$\{[^}]*\}/g, ':param')
          .replace(/[.,)'"`;]+$/, '')
          .replace(/\/+$/, '');
        if (!normalised.startsWith('/api/')) continue;
        if (!found.has(normalised)) found.set(normalised, new Set());
        found.get(normalised).add(relative);
      }
    }
  }
  return found;
}

function backendRoutes() {
  const app = readIfPresent('backend/app.py');
  const routes = new Set();
  const re = /@app\.(get|post|put|delete)\(\s*["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(app)) !== null) routes.add(match[2].replace(/\/+$/, '') || '/');
  return routes;
}

// A called path matches a route when their segment counts agree and every
// segment is either identical or a parameter on both sides.
function routeMatches(called, route) {
  const a = called.split('/');
  const b = route.split('/');
  if (a.length !== b.length) return false;
  return a.every((segment, index) => {
    const other = b[index];
    if (other.startsWith('{') && other.endsWith('}')) return true;
    if (segment === ':param') return other.startsWith('{');
    return segment === other;
  });
}

test('every backend API path the frontend calls is defined in app.py', () => {
  const called = calledApiPaths();
  const routes = backendRoutes();
  assert.ok(routes.size > 0, 'no @app routes were parsed out of backend/app.py');

  const missing = [];
  for (const [calledPath, sources] of called) {
    // A path the frontend only ever builds dynamically from a stored ref (e.g.
    // '/api/' prefix checks) has no fixed route to verify.
    if (calledPath === '/api' || calledPath === '/api/:param') continue;
    if (![...routes].some((route) => routeMatches(calledPath, route))) {
      missing.push(`${calledPath}  (called from ${[...sources].join(', ')})`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Frontend calls backend routes that do not exist:\n  ${missing.join('\n  ')}`,
  );
});

test('story ingestion routes stay wired to the frontend contract', () => {
  const routes = backendRoutes();
  // These three carry every story into the app. /api/scrape is the only path
  // for non-AO3 sources, /api/upload is the only parser for uploaded files AND
  // the parse step of the AO3 FicHub flow.
  for (const required of ['/api/scrape', '/api/upload', '/api/search']) {
    assert.ok(routes.has(required), `backend/app.py must define ${required}`);
  }

  const apiCore = readIfPresent('public/assets/js/api_core.js');
  assert.match(apiCore, /\/api\/scrape/, 'api_core.js should still call /api/scrape');
  assert.match(apiCore, /\/api\/upload/, 'api_core.js should still call /api/upload');
});

test('the scrape route keeps its SSRF guard and admission control', () => {
  const app = readIfPresent('backend/app.py');
  const start = app.indexOf('@app.post("/api/scrape")');
  assert.ok(start > 0, '/api/scrape route not found');
  const body = app.slice(start, app.indexOf('@app.post("/api/upload")'));

  assert.match(body, /assert_public_url/, 'scrape must reject private/internal targets');
  assert.match(body, /_require_scrape_budget/, 'scrape must be rate limited per caller');
  assert.match(body, /_SCRAPE_CONCURRENCY/, 'scrape must be bounded by the concurrency semaphore');
  assert.match(body, /CloudflareBlocked/, 'scrape must surface cloudflare_blocked to the client');
});

test('the upload route bounds file size and type without buffering in memory', () => {
  const app = readIfPresent('backend/app.py');
  const start = app.indexOf('@app.post("/api/upload")');
  assert.ok(start > 0, '/api/upload route not found');
  const body = app.slice(start, app.indexOf('@app.get("/api/fetch-epub")'));

  assert.match(body, /MAX_UPLOAD_BYTES/, 'upload must enforce a byte ceiling');
  assert.match(body, /_UPLOAD_SUFFIXES/, 'upload must restrict file extensions');
  assert.match(body, /await file\.read\(/, 'upload must stream rather than read the whole body at once');
  assert.doesNotMatch(body, /await file\.read\(\)/, 'upload must not read the entire file into memory');
});
