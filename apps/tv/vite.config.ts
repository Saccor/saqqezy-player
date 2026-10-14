import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { devProxy } from './vite.proxy.ts';

export default defineConfig({
  // Relative base so the build also works when loaded from a packaged file URL.
  base: './',
  plugins: [
    devProxy(),
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
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Oldest supported TV engine: Tizen 6.0 (2021 models) runs Chromium 76. Syntax is lowered to it; runtime
    // APIs newer than that are avoided or feature-detected in the code (see STACK.md, Tizen).
    target: 'chrome76',
  },
});
