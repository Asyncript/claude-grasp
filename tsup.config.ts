import { defineConfig } from 'tsup';

// The extension host loads CommonJS. `vscode` is provided by the editor; node:sqlite is built in.
export default defineConfig({
  entry: { extension: 'extension/extension.ts' },
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: false,
  shims: true,
  external: ['vscode'],
});
