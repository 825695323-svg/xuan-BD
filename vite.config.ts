import { fileURLToPath } from 'node:url';
import { ResourceBindings, locateRuntimeRoot } from './platform/resources/bindings.js';
import { ProcessRuntime } from './platform/runtime/programs.js';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('./apps/web', import.meta.url)),
  plugins: [react()],
  cacheDir: new ProcessRuntime(new ResourceBindings(locateRuntimeRoot())).directory('cache', 'vite'),
  build: { outDir: fileURLToPath(new URL('./dist/web', import.meta.url)), emptyOutDir: true },
});
