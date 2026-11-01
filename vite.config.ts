import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The dashboard webview, built into dist/webview with fixed file names so the extension can
// link them (extension/panel.ts). `npm run dev` serves the same build through scripts/preview.ts.
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [tailwindcss(), svelte({ configFile: fileURLToPath(new URL('./svelte.config.js', import.meta.url)) })],
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: { output: { entryFileNames: 'assets/index.js', chunkFileNames: 'assets/[name].js', assetFileNames: (a) => (a.names[0]?.endsWith('.css') ? 'assets/index.css' : 'assets/[name][extname]') } },
  },
});
