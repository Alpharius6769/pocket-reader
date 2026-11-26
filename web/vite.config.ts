import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  // Relative base: the app is served from the GitHub Pages subpath /pocket-reader/
  // and from capacitor://localhost inside the iOS shell.
  base: './',
  // The existing cores, workers, sw.js, sprites and fonts stay unbundled in public/.
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  plugins: [svelte()],
  // Under vitest/jsdom, Svelte must resolve to its browser build, not the SSR one.
  ...(process.env.VITEST ? { resolve: { conditions: ['browser'] } } : {}),
  server: { port: 5180, strictPort: true },
  preview: { port: 5181, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('../dist', import.meta.url)),
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
