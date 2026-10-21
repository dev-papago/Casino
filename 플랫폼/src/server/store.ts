// The ledger state plus its journal. run() is the only way to change the ledger: it takes a command, writes the
// new event to the disk, then applies it. Node runs one request at a time, so a command always sees the state
// that its event will be applied to. A lock file keeps a second server off the same ledger: two writers would
// interleave their events.
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openJournal, type Journal } from './journal.ts';
import { apply, emptyState, type LedgerEvent, type Outcome, type State } from './ledger.ts';

export class Store {
  readonly state: State = emptyState();
  readonly dropped: string | null;
  private readonly journal: Journal<LedgerEvent>;
  private readonly clock: () => number;
  private readonly listeners: ((e: LedgerEvent) => void)[] = [];
  private lastAt = 0;

  private readonly lock: string;

  constructor(dir: string, clock: () => number = Date.now) {
    this.clock = clock;
    this.lock = takeLock(dir);
    try {
      this.journal = openJournal<LedgerEvent>(dir);
    } catch (e) {
      rmSync(this.lock, { force: true });
      throw e;
    }
    this.dropped = this.journal.dropped;
    for (const e of this.journal.events) {
      apply(this.state, e);
      this.lastAt = e.at;
    }
  }

  get path(): string {
    return this.journal.path;
  }

  onEvent(fn: (e: LedgerEvent) => void): void {
    this.listeners.push(fn);
  }

  /** Runs a command. A new event is saved and applied; a repeated request gets the event it made the first time. */
  run(command: (s: State) => Outcome): LedgerEvent {
    const out = command(this.state);
    if ('seq' in out) return out;
    // Event times never go backwards, even if the PC clock is set back.
    const at = (this.lastAt = Math.max(this.lastAt, this.clock()));
    const e = { ...out, seq: this.state.seq + 1, at } as LedgerEvent;
    this.journal.append(e);
    apply(this.state, e);
    for (const fn of this.listeners) fn(e);
    return e;
  }

  close(): void {
    this.journal.close();
    rmSync(this.lock, { force: true });
  }
}

/** data/server.lock holds the PID of the server using the ledger; a lock left by a server that died is taken over. */
function takeLock(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'server.lock');
  let pid = 0;
  try {
    pid = Number(readFileSync(path, 'utf8'));
  } catch {
    // no lock
  }
  if (pid && pid !== process.pid && alive(pid)) {
    throw new Error(`장부 서버가 이미 이 장부를 쓰고 있습니다 (PID ${pid}). 먼저 그 서버를 끄세요.`);
  }
  writeFileSync(path, String(process.pid));
  return path;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}
