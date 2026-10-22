import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Web Workers are written as ES modules (they use `import`).
  worker: { format: 'es' },
  // Transformers.js ships its own WASM/ONNX files; Vite's pre-bundler breaks them.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  // Optional backend (saved projects). In development /api is proxied to the Express
  // server so the refresh cookie stays same-origin, exactly like production behind the
  // Cloudflare Pages Function (functions/api/[[path]].js).
  server: {
    proxy: {
      '/api': { target: process.env.API_DEV_TARGET || 'http://localhost:4000', changeOrigin: false },
    },
  },
});
