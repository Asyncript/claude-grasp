import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { headHash, readLines } from '../parser/jsonl-stream';

async function collect(path: string, start = 0) {
  const out = [];
  for await (const l of readLines(path, start)) out.push(l);
  return out;
}

describe('readLines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-grasp-jsonl-'));

  it('holds back an unterminated last line and resumes from the returned offset', async () => {
    const file = join(dir, 'a.jsonl');
    writeFileSync(file, '{"a":1}\n\n{"b":"é"}\n{"c":');
    const first = await collect(file);
    expect(first.map((l) => l.text)).toEqual(['{"a":1}', '{"b":"é"}']);
    const offset = first.at(-1)!.end;
    expect(offset).toBe(Buffer.byteLength('{"a":1}\n\n{"b":"é"}\n'));

    appendFileSync(file, '3}\n{"d":4}\n');
    expect((await collect(file, offset)).map((l) => l.text)).toEqual(['{"c":3}', '{"d":4}']);
  });

  it('handles lines larger than one read chunk', async () => {
    const file = join(dir, 'big.jsonl');
    const big = JSON.stringify({ blob: 'x'.repeat(3 << 20) });
    writeFileSync(file, `${big}\n{"after":true}\n`);
    const lines = await collect(file);
    expect(lines.map((l) => l.text.length)).toEqual([big.length, 14]);
  });

  it('hashes only the first line', async () => {
    const file = join(dir, 'h.jsonl');
    writeFileSync(file, '{"first":1}\n');
    const h1 = await headHash(file);
    appendFileSync(file, '{"second":2}\n');
    expect(await headHash(file)).toBe(h1);
    writeFileSync(file, '{"rewritten":1}\n');
    expect(await headHash(file)).not.toBe(h1);
  });
});
