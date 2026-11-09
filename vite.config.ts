import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('./apps/web', import.meta.url)),
  plugins: [react()],
  // 静态构建仅依赖源码与 npm 锁定依赖，不发现/读取任何本机运行根或私人 locator。
  cacheDir: fileURLToPath(new URL('./node_modules/.vite', import.meta.url)),
  build: { outDir: fileURLToPath(new URL('./dist/web', import.meta.url)), emptyOutDir: true },
});
