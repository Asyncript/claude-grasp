// Development only: serves the dashboard build (dist/webview) in a normal browser, with the same
// GraspService the extension uses behind POST /rpc, while `vite build --watch` rebuilds the page.
//   npm run dev               your real Claude Code data (read-only), database in ~/.claude-grasp
//   npm run dev -- --demo     the bundled sample data
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../db';
import { GraspService } from '../extension/service';
import { demoShiftMs, prepareDemo } from '../demo/prepare';
import { FakeQuizModel, quizModel } from '../llm';
import { STRICT_PENALTIES, withPenalties } from '../scoring/config';
import { configDirs, dbPath, demoDir } from '../shared/paths';

const { values: v } = parseArgs({
  options: {
    demo: { type: 'boolean', default: false },
    quiz: { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
    port: { type: 'string', default: '5174' },
    'no-watch': { type: 'boolean', default: false },
  },
});

const root = join(import.meta.dirname, '..', 'dist', 'webview');
let roots: string[];
if (v.demo) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath(true) + suffix, { force: true });
  roots = prepareDemo(demoDir(), demoShiftMs()).roots;
} else {
  roots = configDirs();
}
const config = v.strict ? { scoring: withPenalties(STRICT_PENALTIES) } : {};
const service = new GraspService({
  db: openDb(dbPath(v.demo)),
  config,
  model: v.demo ? new FakeQuizModel() : quizModel(config, false),
  roots: () => roots,
  demo: v.demo,
  quizEnabled: v.demo || v.quiz,
  version: JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version,
});
console.log(`Reading ${roots.join(', ') || '(no Claude config dirs found)'}…`);
const stats = await service.ingest();
console.log(`${stats.parsed} sessions read, ${stats.edits} new edits.`);

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = createServer((req, res) => {
  // Only this machine, and only same-origin writes (no DNS rebinding, no cross-site posts).
  const host = req.headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url ?? '/', `http://${host}`);
  if (req.method === 'POST' && url.pathname === '/rpc') {
    let body = '';
    req.on('data', (d: Buffer) => (body += d));
    req.on('end', async () => {
      try {
        const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
        const result = await service.rpc(method, Array.isArray(params) ? params : []);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: result ?? null }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }));
      }
    });
    return;
  }
  const file = normalize(join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + sep) || !existsSync(file)) {
    res.writeHead(404).end('Not built yet? Wait for vite, then reload.');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
});

server.listen(Number(v.port), '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${v.port}/${v.demo ? ' (demo data)' : ''}`));

if (!v['no-watch']) {
  const vite = spawn('npx', ['--no-install', 'vite', 'build', '--watch', '--mode', 'development'], { stdio: 'inherit' });
  process.on('exit', () => vite.kill());
  process.on('SIGINT', () => process.exit(0));
}
