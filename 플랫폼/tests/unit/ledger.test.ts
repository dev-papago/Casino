import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLATFORM } from '../../src/shared/config.ts';
import {
  LedgerError,
  cancelSettlement,
  closeGame,
  completeSettlement,
  directSettlement,
  edit,
  login,
  openGame,
  remove,
  requestSettlement,
  resolveBankruptcy,
  signup,
  totalOf,
  type LedgerEvent,
  type State,
} from '../../src/server/ledger.ts';
import { Store } from '../../src/server/store.ts';

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(pathJoin(tmpdir(), 'ledger-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let keyN = 0;
const key = (): string => `k${++keyN}`;
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
  return 'ok';
};

function fresh(): { store: Store; dir: string; join: (name: string) => string } {
  const dir = tempDir();
  const store = new Store(dir);
  const joinPlayer = (name: string): string => {
    const e = store.run((s) => signup(s, { name, pin: '1234', key: key() }));
    if (e.type !== 'signup') throw new Error();
    return e.player.id;
  };
  return { store, dir, join: joinPlayer };
}

const p = (s: State, id: string) => s.players.get(id)!;
/** Chips owed to players must always equal what came in minus what went out. */
function balanced(s: State): void {
  const outstanding = [...s.players.values()].reduce((t, pl) => t + totalOf(s, pl), 0);
  const { bonus, edits, games, settled, deleted } = s.totals;
  expect(outstanding).toBe(bonus + edits + games - settled - deleted);
}

describe('accounts', () => {
  it('a signup gets the bonus; names are unique whatever the case and spacing; PIN is 4 digits', () => {
    const { store, join } = fresh();
    const id = join('  홍길동 ');
    expect(p(store.state, id)).toMatchObject({ name: '홍길동', chips: PLATFORM.signupBonus, version: 1 });
    expect(code(() => store.run((s) => signup(s, { name: '홍길동', pin: '1111', key: key() })))).toBe('name_taken');
    join('Kim Lee');
    expect(code(() => store.run((s) => signup(s, { name: 'kim   LEE', pin: '1111', key: key() })))).toBe('name_taken');
    expect(code(() => store.run((s) => signup(s, { name: '새 사람', pin: '12a4', key: key() })))).toBe('pin');
    expect(code(() => store.run((s) => signup(s, { name: '새 사람', pin: '12345', key: key() })))).toBe('pin');
    expect(code(() => store.run((s) => signup(s, { name: '   ', pin: '1234', key: key() })))).toBe('name');
    expect(code(() => store.run((s) => signup(s, { name: '열세글자가넘는아주긴이름입니다', pin: '1234', key: key() })))).toBe('name');
  });

  it('a signup or login sent twice (lost answer) happens once', () => {
    const { store } = fresh();
    const k = key();
    const a = store.run((s) => signup(s, { name: '재시도', pin: '1234', key: k }));
    const b = store.run((s) => signup(s, { name: '재시도', pin: '1234', key: k }));
    expect(b).toBe(a);
    expect(store.state.players.size).toBe(1);
    const k2 = key();
    const l1 = store.run((s) => login(s, { name: '재시도', pin: '1234', key: k2 }));
    const l2 = store.run((s) => login(s, { name: '재시도', pin: '1234', key: k2 }));
    expect(l2).toBe(l1);
    expect(store.state.seq).toBe(2);
    // The same key cannot be borrowed for a different request.
    expect(code(() => store.run((s) => signup(s, { name: '다른 사람', pin: '1234', key: k })))).toBe('bad_request');
  });

  it('logs in with the right PIN only; a new login replaces the old one', () => {
    const { store, join } = fresh();
    const id = join('로그인');
    const first = p(store.state, id).login;
    expect(code(() => store.run((s) => login(s, { name: '로그인', pin: '9999', key: key() })))).toBe('login');
    expect(code(() => store.run((s) => login(s, { name: '없는 사람', pin: '1234', key: key() })))).toBe('login');
    store.run((s) => login(s, { name: ' 로그인 ', pin: '1234', key: key() }));
    expect(p(store.state, id).login).not.toBe(first);
  });
});

describe('games', () => {
  it('a game takes its stake, pays out once, and checks the secret and the limit', () => {
    const { store, join } = fresh();
    const id = join('게이머');
    const open = store.run((s) => openGame(s, { playerId: id, game: 'yabawi', stake: 3, key: key() }));
    if (open.type !== 'gameOpen') throw new Error();
    const { id: gid, secret } = open.session;
    expect(p(store.state, id).chips).toBe(2);
    expect(totalOf(store.state, p(store.state, id))).toBe(5); // staked chips still count in 잔고
    expect(code(() => store.run((s) => openGame(s, { playerId: id, game: 'yabawi', stake: 3, key: key() })))).toBe('funds');
    expect(code(() => store.run((s) => openGame(s, { playerId: id, game: 'poker', stake: 1, key: key() })))).toBe('game');
    expect(code(() => store.run((s) => closeGame(s, { id: gid, payout: 7, secret: 'wrong', by: 'player' })))).toBe('session');
    expect(code(() => store.run((s) => closeGame(s, { id: gid, payout: 51, secret, by: 'player' })))).toBe('payout');
    const close = store.run((s) => closeGame(s, { id: gid, payout: 7, secret, by: 'player' }));
    expect(p(store.state, id)).toMatchObject({ chips: 9, played: 1, net: 4 });
    // The same report again (the answer was lost) changes nothing; a different one is refused.
    expect(store.run((s) => closeGame(s, { id: gid, payout: 7, secret, by: 'player' }))).toBe(close);
    expect(code(() => store.run((s) => closeGame(s, { id: gid, payout: 9, secret, by: 'player' })))).toBe('closed');
    expect(p(store.state, id).chips).toBe(9);
    balanced(store.state);
  });

  it('opening a game twice with one key opens it once', () => {
    const { store, join } = fresh();
    const id = join('한번만');
    const k = key();
    const a = store.run((s) => openGame(s, { playerId: id, game: 'yeongkkeul', stake: 2, key: k }));
    const b = store.run((s) => openGame(s, { playerId: id, game: 'yeongkkeul', stake: 2, key: k }));
    expect(b).toBe(a);
    expect(p(store.state, id).chips).toBe(3);
  });

  it('the admin closes a session that will never report, with any payout', () => {
    const { store, join } = fresh();
    const id = join('멈춘 PC');
    const open = store.run((s) => openGame(s, { playerId: id, game: 'yabawi', stake: 4, key: key() }));
    if (open.type !== 'gameOpen') throw new Error();
    store.run((s) => closeGame(s, { id: open.session.id, payout: 4, by: 'admin' }));
    expect(p(store.state, id).chips).toBe(5);
    expect(store.state.log.at(-1)).toMatchObject({ kind: 'gameForce', delta: 0, text: expect.stringContaining('환불') });
  });
});

describe('settlements', () => {
  it('a request holds the chips until the admin pays, turns it down, or the player cancels', () => {
    const { store, join } = fresh();
    const id = join('정산');
    const req = store.run((s) => requestSettlement(s, { playerId: id, amount: 3, key: key() }));
    if (req.type !== 'settleRequest') throw new Error();
    expect(p(store.state, id).chips).toBe(2);
    expect(totalOf(store.state, p(store.state, id))).toBe(5);
    // Held chips cannot be played or asked for twice.
    expect(code(() => store.run((s) => openGame(s, { playerId: id, game: 'yabawi', stake: 3, key: key() })))).toBe('funds');
    expect(code(() => store.run((s) => requestSettlement(s, { playerId: id, amount: 1, key: key() })))).toBe('pending');
    // Only the owner can cancel it.
    const other = join('남');
    expect(code(() => store.run((s) => cancelSettlement(s, { id: req.settlement.id, by: 'player', playerId: other })))).toBe('gone');
    store.run((s) => completeSettlement(s, req.settlement.id));
    expect(totalOf(store.state, p(store.state, id))).toBe(2);
    expect(store.state.totals.settled).toBe(3);
    // Paying twice (double click) is refused.
    expect(code(() => store.run((s) => completeSettlement(s, req.settlement.id)))).toBe('gone');

    const again = store.run((s) => requestSettlement(s, { playerId: id, amount: 2, key: key() }));
    if (again.type !== 'settleRequest') throw new Error();
    store.run((s) => cancelSettlement(s, { id: again.settlement.id, by: 'admin' }));
    expect(p(store.state, id).chips).toBe(2);
    expect(store.state.log.at(-1)?.kind).toBe('settleReject');
    expect(code(() => store.run((s) => requestSettlement(s, { playerId: id, amount: 3, key: key() })))).toBe('funds');
    expect(code(() => store.run((s) => requestSettlement(s, { playerId: id, amount: 1.5, key: key() })))).toBe('amount');
    balanced(store.state);
  });

  it('the admin settles directly, once per key', () => {
    const { store, join } = fresh();
    const id = join('카운터');
    const k = key();
    store.run((s) => directSettlement(s, { playerId: id, amount: 4, key: k }));
    store.run((s) => directSettlement(s, { playerId: id, amount: 4, key: k }));
    expect(p(store.state, id).chips).toBe(1);
    expect(code(() => store.run((s) => directSettlement(s, { playerId: id, amount: 2, key: key() })))).toBe('funds');
  });
});

describe('bankruptcy', () => {
  it('losing the last chip in a game files for bankruptcy once; the admin handles it', () => {
    const { store, join } = fresh();
    const id = join('파산');
    const open = store.run((s) => openGame(s, { playerId: id, game: 'yabawi', stake: 5, key: key() }));
    if (open.type !== 'gameOpen') throw new Error();
    store.run((s) => closeGame(s, { id: open.session.id, payout: 0, secret: open.session.secret, by: 'player' }));
    expect(store.state.bankruptcies.size).toBe(1);
    expect(store.state.log.at(-1)).toMatchObject({ kind: 'bankrupt', name: '파산' });
    const [b] = store.state.bankruptcies.values();
    store.run((s) => resolveBankruptcy(s, b.id));
    expect(store.state.bankruptcies.size).toBe(0);
  });

  it('is not filed while chips are still held for a settlement or staked in another game', () => {
    const { store, join } = fresh();
    const id = join('아직');
    store.run((s) => requestSettlement(s, { playerId: id, amount: 2, key: key() }));
    const open = store.run((s) => openGame(s, { playerId: id, game: 'yabawi', stake: 3, key: key() }));
    if (open.type !== 'gameOpen') throw new Error();
    store.run((s) => closeGame(s, { id: open.session.id, payout: 0, secret: open.session.secret, by: 'player' }));
    expect(store.state.bankruptcies.size).toBe(0);
  });

  it('ends when the admin gives the player chips again', () => {
    const { store, join } = fresh();
    const id = join('재기');
    const open = store.run((s) => openGame(s, { playerId: id, game: 'yabawi', stake: 5, key: key() }));
    if (open.type !== 'gameOpen') throw new Error();
    store.run((s) => closeGame(s, { id: open.session.id, payout: 0, secret: open.session.secret, by: 'player' }));
    const pl = p(store.state, id);
    store.run((s) => edit(s, { id, version: pl.version, name: pl.name, pin: pl.pin, total: 5 }));
    expect(store.state.bankruptcies.size).toBe(0);
    expect(store.state.log.at(-1)?.text).toContain('파산 해제');
  });
});

describe('admin edits and deletes', () => {
  it('an edit must name the version it saw, and 잔고 cannot drop below held and staked chips', () => {
    const { store, join } = fresh();
    const id = join('수정');
    join('이미');
    const v = p(store.state, id).version;
    store.run((s) => requestSettlement(s, { playerId: id, amount: 2, key: key() })); // changes the version
    expect(code(() => store.run((s) => edit(s, { id, version: v, name: '수정', pin: '1234', total: 9 })))).toBe('conflict');
    const now = p(store.state, id).version;
    expect(code(() => store.run((s) => edit(s, { id, version: now, name: '수정', pin: '1234', total: 1 })))).toBe('held');
    expect(code(() => store.run((s) => edit(s, { id, version: now, name: '이미', pin: '1234', total: 5 })))).toBe('name_taken');
    expect(code(() => store.run((s) => edit(s, { id, version: now, name: '수정', pin: '1234', total: 5 })))).toBe('unchanged');
    store.run((s) => edit(s, { id, version: now, name: '고친 이름', pin: '4321', total: 12 }));
    expect(p(store.state, id)).toMatchObject({ name: '고친 이름', pin: '4321', chips: 10 });
    expect(totalOf(store.state, p(store.state, id))).toBe(12);
    expect(store.state.log.at(-1)).toMatchObject({ kind: 'edit', delta: 7, chips: 12, text: '잔고 5 → 12칩 · 이름 수정 → 고친 이름 · PIN 1234 → 4321' });
    // The old name is free again; the new one logs in.
    join('수정');
    store.run((s) => login(s, { name: '고친 이름', pin: '4321', key: key() }));
    balanced(store.state);
  });

  it('deleting an account takes its free, held and staked chips, and its open game can no longer report', () => {
    const { store, join } = fresh();
    const id = join('삭제');
    store.run((s) => requestSettlement(s, { playerId: id, amount: 1, key: key() }));
    const open = store.run((s) => openGame(s, { playerId: id, game: 'yabawi', stake: 2, key: key() }));
    if (open.type !== 'gameOpen') throw new Error();
    store.run((s) => remove(s, id));
    expect(store.state.players.size).toBe(0);
    expect(store.state.settlements.size + store.state.games.size).toBe(0);
    expect(store.state.totals.deleted).toBe(5);
    expect(store.state.log.at(-1)).toMatchObject({ kind: 'delete', delta: -5, chips: 0 });
    expect(code(() => store.run((s) => closeGame(s, { id: open.session.id, payout: 4, secret: open.session.secret, by: 'player' })))).toBe('gone');
    balanced(store.state);
  });
});

describe('journal', () => {
  /** Plays a mixed day and returns the events it made. */
  function day(store: Store, join: (n: string) => string): void {
    const a = join('가');
    const b = join('나');
    const g = store.run((s) => openGame(s, { playerId: a, game: 'yabawi', stake: 2, key: key() }));
    if (g.type !== 'gameOpen') throw new Error();
    store.run((s) => closeGame(s, { id: g.session.id, payout: 6, secret: g.session.secret, by: 'player' }));
    const r = store.run((s) => requestSettlement(s, { playerId: a, amount: 4, key: key() }));
    if (r.type !== 'settleRequest') throw new Error();
    store.run((s) => completeSettlement(s, r.settlement.id));
    const pb = p(store.state, b);
    store.run((s) => edit(s, { id: b, version: pb.version, name: '나나', pin: '0000', total: 8 }));
  }
  const view = (s: State) => ({ players: [...s.players.values()], log: s.log, totals: s.totals, seq: s.seq });

  it('a restart replays the journal into exactly the same ledger, keys included', () => {
    const { store, dir, join } = fresh();
    day(store, join);
    const before = view(store.state);
    store.close();
    const again = new Store(dir);
    expect(view(again.state)).toEqual(before);
    // A request repeated after the restart still finds its first answer.
    const first = JSON.parse(readFileSync(again.path, 'utf8').split('\n')[0]) as LedgerEvent;
    if (first.type !== 'signup') throw new Error();
    expect(again.run((s) => signup(s, { name: '가', pin: '1234', key: first.key })).seq).toBe(1);
    again.close();
    expect(readdirSync(pathJoin(dir, 'backups'))).toHaveLength(1);
  });

  it('drops a last line cut off by a power failure and refuses a damaged line in the middle', () => {
    const { store, dir, join } = fresh();
    day(store, join);
    const seq = store.state.seq;
    store.close();
    appendFileSync(pathJoin(dir, 'journal.jsonl'), '{"seq":99,"type":"sig');
    const again = new Store(dir);
    expect(again.dropped).toContain('"seq":99');
    expect(again.state.seq).toBe(seq);
    // New events go after the good lines.
    again.run((s) => signup(s, { name: '다', pin: '1234', key: key() }));
    again.close();
    expect(new Store(dir).state.seq).toBe(seq + 1);

    const lines = readFileSync(pathJoin(dir, 'journal.jsonl'), 'utf8').split('\n');
    lines[2] = lines[2].slice(0, 10);
    writeFileSync(pathJoin(dir, 'journal.jsonl'), lines.join('\n'));
    expect(() => new Store(dir)).toThrow(/3번째 줄이 손상/);
  });

  it('keeps a second server off the same ledger, and takes over a lock left by a dead one', () => {
    const { store, dir } = fresh();
    store.close();
    writeFileSync(pathJoin(dir, 'server.lock'), '1'); // PID 1 is always alive (init)
    expect(() => new Store(dir)).toThrow(/이미 이 장부를 쓰고/);
    writeFileSync(pathJoin(dir, 'server.lock'), '999999999');
    const again = new Store(dir);
    again.close();
    expect(readdirSync(dir)).not.toContain('server.lock');
  });

  it('stays balanced through a long random day', () => {
    const { store, join } = fresh();
    let r = 7;
    const rnd = (n: number): number => {
      r = (r + 0x6d2b79f5) | 0; // mulberry32
      let t = Math.imul(r ^ (r >>> 15), 1 | r);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const ids = Array.from({ length: 6 }, (_, i) => join(`p${i}`));
    for (let i = 0; i < 2000; i++) {
      const s = store.state;
      const live = ids.filter((id) => s.players.has(id));
      if (!live.length) break;
      const id = live[rnd(live.length)];
      const pl = s.players.get(id)!;
      const tries: (() => unknown)[] = [
        () => store.run((st) => openGame(st, { playerId: id, game: rnd(2) ? 'yabawi' : 'yeongkkeul', stake: 1 + rnd(4), key: key() })),
        () => {
          const g = [...s.games.values()].find((x) => x.playerId === id);
          if (g) store.run((st) => closeGame(st, { id: g.id, payout: rnd(12), secret: g.secret, by: rnd(5) ? 'player' : 'admin' }));
        },
        () => store.run((st) => requestSettlement(st, { playerId: id, amount: 1 + rnd(3), key: key() })),
        () => {
          const q = [...s.settlements.values()].find((x) => x.playerId === id);
          if (q) store.run((st) => (rnd(2) ? completeSettlement(st, q.id) : cancelSettlement(st, { id: q.id, by: 'admin' })));
        },
        () => store.run((st) => edit(st, { id, version: pl.version, name: pl.name, pin: pl.pin, total: rnd(20) })),
        () => store.run((st) => directSettlement(st, { playerId: id, amount: 1 + rnd(2), key: key() })),
        () => {
          const b = [...s.bankruptcies.values()].find((x) => x.playerId === id);
          if (b) store.run((st) => resolveBankruptcy(st, b.id));
        },
        () => rnd(100) === 0 && store.run((st) => remove(st, id)),
      ];
      try {
        tries[rnd(tries.length)]();
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
      }
      balanced(store.state);
    }
    expect(store.state.seq).toBeGreaterThan(500);
  });
});

