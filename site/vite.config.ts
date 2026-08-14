import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dep = (p: string) => resolve(here, 'node_modules', p);

/**
 * The site pulls a few modules out of the repo's `shared/` closure (see
 * src/seam/shared.ts). Those files live outside this directory, so Node's
 * resolution walks up from THEIR location and would find whatever
 * node_modules the repo root happens to have installed — or nothing at all
 * in a fresh checkout. Pinning the bare specifiers here makes the build
 * depend only on this package's own dependencies.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^nostr-tools$/, replacement: dep('nostr-tools') },
      { find: /^@noble\/hashes\/([^./]+)$/, replacement: `${dep('@noble/hashes')}/$1.js` },
    ],
  },
  build: {
    target: 'es2022',
    // One page, one bundle — no code splitting to reason about.
    rollupOptions: { output: { manualChunks: undefined } },
  },
  server: { port: 5183, strictPort: false },
});
