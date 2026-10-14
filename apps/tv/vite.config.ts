import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { prodEnvCheck } from '../../tools/build/prodEnv.mjs';
import { devProxy } from './vite.proxy.ts';

// `pnpm dev:stable`: no HMR and no client socket, so saving a file never reloads an open page (files are still
// watched, so F5 serves the new code). Used while watching streams; plain `pnpm dev` keeps live reload.
const stableDev = process.env.IPTV_DEV_STABLE === '1';

function stableDevNotice(): Plugin {
  return {
    name: 'iptv-stable-dev',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        server.config.logger.info('Stable dev: the page never reloads by itself. Press F5 to load code changes.');
      });
    },
  };
}

export default defineConfig({
  // Relative base so the build also works when loaded from a packaged file URL.
  base: './',
  plugins: [
    devProxy(),
    ...(stableDev ? [stableDevNotice()] : []),
    // Production builds warn loudly without VITE_RELAY_URL / VITE_COMPANION_ORIGIN (REQUIRE_PROD_ENV=1: fail).
    prodEnvCheck('tv'),
    // Lightning + Solid: compile JSX with Solid's universal renderer from @lightningtv/solid.
    solid({ solid: { moduleName: '@lightningtv/solid', generate: 'universal', builtIns: [] } }),
  ],
  resolve: {
    dedupe: ['solid-js', '@lightningtv/solid', '@lightningtv/solid/primitives'],
  },
  optimizeDeps: {
    // Ships untranspiled .jsx (primitives) that must go through vite-plugin-solid.
    exclude: ['@lightningtv/solid', '@lightningtv/solid/primitives'],
  },
  // Classic (IIFE) worker in the build: module workers need Chromium 80+ (see STACK.md, Tizen).
  worker: { format: 'iife' },
  server: stableDev ? { port: 5173, strictPort: true, hmr: false, ws: false } : { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Oldest supported TV engine: Tizen 6.0 (2021 models) runs Chromium 76. Syntax is lowered to it; runtime
    // APIs newer than that are avoided or feature-detected in the code (see STACK.md, Tizen).
    target: 'chrome76',
  },
});
