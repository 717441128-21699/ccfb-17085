import { defineConfig } from 'vite';

// 纯静态构建：AudioWorklet 处理器放在 public/worklets 下，原样拷贝到 dist。
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 47917,
    strictPort: false,
  },
  build: {
    target: 'es2020',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
});
