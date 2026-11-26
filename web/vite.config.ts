import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const outDir = fileURLToPath(new URL('../dist', import.meta.url));

/**
 * public/sw.js precaches the cores by hand-maintained ?v= URLs, but the v2 UI
 * bundle has content-hashed names that only exist after a build. This writes
 * them into dist/sw.js at the marker, and stamps CACHE_NAME with a hash of
 * those names so every release installs into a fresh cache (the old one is
 * removed on activate). Without it the new shell was never available offline.
 */
function servicePrecache(): Plugin {
  const MARKER = '/* __V2_APP_ASSETS__ */';
  return {
    name: 'pocket-reader-sw-precache',
    apply: 'build',
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      const files = readdirSync(join(outDir, 'app')).sort().map((f) => `app/${f}`);
      let sw = readFileSync(swPath, 'utf8');
      if (!sw.includes(MARKER)) throw new Error('dist/sw.js has no __V2_APP_ASSETS__ marker; the shell would not precache.');
      const hash = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 10);
      sw = sw.replace(MARKER, files.map((f) => `, '${f}'`).join('\n    '));
      sw = sw.replace(/var CACHE_NAME = '([^']+)';/, (_m, name) => `var CACHE_NAME = '${name}-${hash}';`);
      writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  root,
  // Relative base: the app is served from the GitHub Pages subpath /pocket-reader/
  // and from capacitor://localhost inside the iOS shell.
  base: './',
  // The existing cores, workers, sw.js, sprites and fonts stay unbundled in public/.
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  plugins: [svelte(), servicePrecache()],
  // Under vitest/jsdom, Svelte must resolve to its browser build, not the SSR one.
  ...(process.env.VITEST ? { resolve: { conditions: ['browser'] } } : {}),
  server: { port: 5180, strictPort: true },
  preview: { port: 5181, strictPort: true },
  build: {
    outDir,
    emptyOutDir: true,
    // Keep bundled output apart from the unbundled public/assets/ tree.
    assetsDir: 'app',
    target: 'es2022',
  },
  test: {
    root,
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
});
