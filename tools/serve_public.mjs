// Minimal static server for local verification of the deployable `public/` tree.
//
// Mirrors the two things Cloudflare Pages does that the app depends on: it
// serves index.html for navigations (so client routing and the service worker
// behave as they do in production) and it sets the same long-lived cache policy
// on versioned assets. Isolation headers are deliberately NOT forced here — the
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
      // Versioned assets are immutable by construction; everything else must
      // revalidate so a local edit shows up on reload.
      'Cache-Control': url.searchParams.has('v')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
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
