// Minimal static server for local verification of the deployable `public/` tree.
//
// Mirrors the two things the static host does that the app depends on: it
// serves index.html for navigations (so client routing and the service worker
// behave as they do in production) and it sets a long-lived cache policy on
// versioned assets.
//
// Note that production is GitHub Pages, which sends no custom headers at all --
// public/_headers is inert there, and this server is deliberately no stricter.
// Isolation headers are also NOT forced here: the
// service worker injects COOP/COEP itself for ?tts_fast=1 sessions, and forcing
// them globally would mask a regression in that path.
//
// Usage: node tools/serve_public.mjs [port]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, normalize, sep } from 'node:path';

const root = resolve('public');
const port = Number(process.argv[2]) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

async function resolveFile(pathname) {
  const decoded = decodeURIComponent(pathname);
  const candidate = normalize(resolve(root, `.${decoded}`));
  // Containment check: never serve outside public/.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  try {
    const info = await stat(candidate);
    if (info.isDirectory()) return resolveFile(`${decoded.replace(/\/$/, '')}/index.html`);
    return candidate;
  } catch {
    return null;
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    let file = await resolveFile(url.pathname);
    // SPA fallback for navigations only, so a missing asset still 404s loudly
    // instead of silently returning HTML and failing as a syntax error.
    if (!file && request.headers.accept?.includes('text/html')) {
      file = resolve(root, 'index.html');
    }
    if (!file) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
      return;
    }
    const body = await readFile(file);
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': type,
      // Deliberately unlike production: nothing here is cacheable.
      //
      // This used to mirror the real cache policy and serve any ?v= asset as
      // immutable for a year. That is correct for a deploy and actively
      // misleading for a dev server, because the whole point of running one is
      // that the files ARE changing under URLs whose version has not moved yet.
      // Edit theme.css or a module without bumping its ?v= and the browser can
      // never show you the change -- it serves the year-old copy from disk
      // cache, through a hard reload, through unregistering the service worker.
      // Two separate fixes were "verified" against stale bytes before this was
      // spotted. Production caching comes from the host, never from here.
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Service-Worker-Allowed': '/',
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain' });
    response.end(String(error?.message || error));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Pocket Reader public/ served at http://127.0.0.1:${port}`);
});
