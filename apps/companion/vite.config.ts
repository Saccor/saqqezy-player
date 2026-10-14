import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { prodEnvCheck } from '../../tools/build/prodEnv.mjs';
import { buildHeaders } from './src/build/headers.ts';

/** Writes dist/_headers (Cloudflare Pages) with the relay origin of this build's VITE_RELAY_URL in the CSP. */
function companionHeaders(): Plugin {
  let relayUrl: string | undefined;
  return {
    name: 'companion-headers',
    apply: 'build',
    configResolved(config) {
      relayUrl = config.env['VITE_RELAY_URL'] as string | undefined;
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: buildHeaders(relayUrl) });
    },
  };
}

export default defineConfig({
  // Production builds warn loudly without VITE_RELAY_URL (REQUIRE_PROD_ENV=1: fail).
  plugins: [solid(), companionHeaders(), prodEnvCheck('companion')],
  resolve: { dedupe: ['solid-js'] },
  // Dev: http://localhost:5174 is a secure context, which WebCrypto needs. Production is served over https.
  server: { port: 5174, strictPort: true, host: 'localhost' },
  preview: { port: 5174, strictPort: true, host: 'localhost' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
});
