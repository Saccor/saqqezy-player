import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  resolve: { dedupe: ['solid-js'] },
  // Dev: http://localhost:5174 is a secure context, which WebCrypto needs. Production is served over https.
  server: { port: 5174, strictPort: true, host: 'localhost' },
  preview: { port: 5174, strictPort: true, host: 'localhost' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
});
