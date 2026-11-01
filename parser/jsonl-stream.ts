import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

export interface RawLine {
  text: string;
  /** Byte offset just past this line's newline; resume from here next time. */
  end: number;
}

/**
 * Yields complete lines from byte `start`. A trailing line without "\n" is held back,
 * since Claude Code may still be writing it.
 */
export async function* readLines(path: string, start = 0): AsyncGenerator<RawLine> {
  let pos = start;
  let carry: Buffer[] = [];
  for await (const chunk of createReadStream(path, { start, highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    let from = 0;
    let nl: number;
    while ((nl = chunk.indexOf(10, from)) !== -1) {
      const piece = chunk.subarray(from, nl);
      const buf = carry.length ? Buffer.concat([...carry, piece]) : piece;
      carry = [];
      pos += buf.length + 1;
      from = nl + 1;
      if (buf.length) yield { text: buf.toString('utf8'), end: pos };
    }
    if (from < chunk.length) carry.push(chunk.subarray(from));
  }
}

/** Hash of the first line. If it changes, the file was rewritten rather than appended to. */
export async function headHash(path: string): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    const nl = head.indexOf(10);
    return createHash('sha1')
      .update(nl === -1 ? head : head.subarray(0, nl))
      .digest('hex');
  } finally {
    await fh.close();
  }
}
