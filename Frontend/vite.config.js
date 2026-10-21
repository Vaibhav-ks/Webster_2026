import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Web Workers are written as ES modules (they use `import`).
  worker: { format: 'es' },
  // Transformers.js ships its own WASM/ONNX files; Vite's pre-bundler breaks them.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
