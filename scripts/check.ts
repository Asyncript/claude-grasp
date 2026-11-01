// `npm run check`: everything CI would run, using only what's already installed.
// Stops at the first failing step and exits non-zero.
import { spawnSync } from 'node:child_process';

const steps: [string, string[]][] = [
  ['typecheck', ['tsc', '--noEmit']],
  ['typecheck web', ['svelte-check', '--tsconfig', 'web/tsconfig.json', '--fail-on-warnings']],
  ['lint', ['eslint', '.', '--max-warnings', '0']],
  ['tests', ['vitest', 'run']],
  ['smoke', ['tsx', 'scripts/smoke.ts']],
  ['build extension', ['tsup']],
  ['build dashboard', ['vite', 'build']],
  ['package contents', ['vsce', 'ls', '--no-dependencies']],
];

for (const [name, [bin, ...args]] of steps) {
  process.stdout.write(`\n── ${name}: ${bin} ${args.join(' ')}\n`);
  const started = Date.now();
  const r = spawnSync('npx', ['--no-install', bin!, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    process.stderr.write(`\n✗ ${name} failed (exit ${r.status ?? r.signal})\n`);
    process.exit(r.status || 1);
  }
  process.stdout.write(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
}
process.stdout.write('\nAll checks passed.\n');
