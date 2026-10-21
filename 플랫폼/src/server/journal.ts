// The ledger on disk (DESIGN.md section 3): data/journal.jsonl, one JSON event per line, only ever appended.
// Every event is flushed to the disk (fsync) before the server answers, so an answered request is never lost.
// On start the file is read back in full. A last line cut off by a power failure is dropped: that request was
// never answered, and the player app sends it again. A damaged line anywhere else stops the server, because a
// ledger with a hole in it must not be trusted: the admin puts back a copy from data/backups, where every start
// first saves the journal as it was.
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export interface Journal<T> {
  readonly events: T[]; // what was on disk at the start
  readonly path: string;
  readonly dropped: string | null; // a cut-off last line that was dropped, if any
  append(e: T): void;
  close(): void;
}

const KEEP_BACKUPS = 30;

export function openJournal<T>(dir: string): Journal<T> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'journal.jsonl');
  const events: T[] = [];
  let dropped: string | null = null;
  if (existsSync(path) && statSync(path).size > 0) {
    backup(dir, path);
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    const tail = lines.pop() ?? ''; // '' when the file ends with a newline, as it always should
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try {
        events.push(JSON.parse(line) as T);
      } catch {
        throw new Error(`장부 파일 ${path}의 ${i + 1}번째 줄이 손상되었습니다. data/backups의 사본으로 바꾸세요.`);
      }
    });
    if (tail.trim()) {
      dropped = tail;
      truncateSync(path, Buffer.byteLength(text) - Buffer.byteLength(tail));
    }
  }
  const fd = openSync(path, 'a');
  return {
    events,
    path,
    dropped,
    append(e) {
      writeSync(fd, `${JSON.stringify(e)}\n`);
      fsyncSync(fd);
    },
    close() {
      closeSync(fd);
    },
  };
}

/** Copies the journal to backups/journal-<time>.jsonl and keeps the newest KEEP_BACKUPS copies. */
function backup(dir: string, path: string): void {
  const backups = join(dir, 'backups');
  mkdirSync(backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(path, join(backups, `journal-${stamp}.jsonl`));
  const old = readdirSync(backups)
    .filter((f) => /^journal-.*\.jsonl$/.test(f))
    .sort()
    .slice(0, -KEEP_BACKUPS);
  for (const f of old) rmSync(join(backups, f), { force: true });
}
