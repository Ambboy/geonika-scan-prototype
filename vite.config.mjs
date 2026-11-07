import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'docs', emptyOutDir: true, target: 'es2022' },
  server: { host: '127.0.0.1', port: 4178, strictPort: true },
  preview: { host: '127.0.0.1', port: 4178, strictPort: true },
});
