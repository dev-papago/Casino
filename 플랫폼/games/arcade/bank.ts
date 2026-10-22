// Chips for the arcade games (플링코, 슬롯머신, 요트 다이스). Every round is its own ledger session: the stake
// leaves the balance when the round starts, the result is drawn right then and noted with live(), so a reload or a
// closed window still pays exactly that result (settleLeftovers), and close() sends it when the animation is done.
// Outside the player app (?casino missing) the game runs on 100 practice chips that are not real.
import * as casino from '../../sdk/casino.ts';
import { PLATFORM, type GameId } from '../../src/shared/config.ts';

export type Delivery = 'sent' | 'queued' | 'review' | 'practice';

export interface Round {
  readonly stake: number;
  /** What the round pays if it stops right now (call it again whenever that changes). */
  live(payout: number): void;
  /** Ends the round: the payout goes to the balance (or to the admin's review). */
  finish(payout: number): Promise<Delivery>;
}

export class BankError extends Error {}

const PRACTICE_CHIPS = 100;

export class Bank {
  readonly practice = !casino.inCasino();
  private playerId = '';
  private freeChips = this.practice ? PRACTICE_CHIPS : 0;
  private opening = false;
  private flying = new Map<number, number>(); // rounds still running: what each will pay
  private rounds = 0;

  readonly game: GameId;

  constructor(game: GameId) {
    this.game = game;
  }

  /** Chips the player can bet now. */
  get free(): number {
    return this.freeChips;
  }

  /** Largest stake for one round: everything the player has (no other limit). */
  get maxStake(): number {
    return Math.max(0, Math.min(this.freeChips, PLATFORM.maxChips));
  }

  /** Reads the balance (and settles this game's rounds left by a reload). */
  async load(): Promise<void> {
    if (this.practice) return;
    try {
      await casino.settleLeftovers(this.game);
      const me = await casino.player();
      this.playerId = me.id;
      this.freeChips = me.free;
    } catch (e) {
      throw new BankError(
        e instanceof casino.CasinoError && e.code === 'session' ? '로그인이 끝났습니다. 로비에서 다시 로그인하세요' : '서버에 연결할 수 없습니다',
      );
    }
  }

  /** Takes the stake out of the balance. Throws BankError with a message for the player. */
  async begin(stake: number): Promise<Round> {
    if (!Number.isInteger(stake) || stake < 1 || stake > this.maxStake) throw new BankError('걸 수 없는 칩 수입니다');
    if (this.opening) throw new BankError('앞 판을 시작하는 중입니다');
    if (this.practice) {
      this.freeChips -= stake;
      return this.practiceRound(stake);
    }
    this.opening = true;
    let s: casino.CasinoSession;
    try {
      s = await casino.open(this.game, stake, this.playerId);
    } catch (e) {
      void this.refresh();
      throw new BankError(e instanceof casino.CasinoError ? e.message : '칩을 가져오지 못했습니다');
    } finally {
      this.opening = false;
    }
    this.freeChips -= stake;
    let done = false;
    const n = ++this.rounds;
    return {
      stake,
      live: (payout) => {
        if (done) return;
        this.flying.set(n, payout);
        casino.live(s, payout);
      },
      finish: async (payout) => {
        if (done) return 'sent';
        done = true;
        this.flying.delete(n);
        const how = await casino.close(s, payout);
        if (how === 'sent') this.freeChips += payout;
        void this.refresh();
        return how;
      },
    };
  }

  /**
   * 승리 추세: the chance to keep a result that pays `payout` for the `stake` of the round being drawn (always 1 in
   * practice). The player's chips in all: the balance, this stake, what the rounds still running will pay, and
   * the chips held or in other games.
   */
  keep(stake: number, payout: number, tilt: casino.Tilt): number {
    if (this.practice) return 1;
    let before = this.freeChips + stake + casino.chipsElsewhere(this.game);
    for (const p of this.flying.values()) before += p;
    return casino.keepChance(before, before - stake + payout, tilt);
  }

  /** Back to the player app. */
  exit(): void {
    if (this.practice) location.reload();
    else casino.exit();
  }

  private practiceRound(stake: number): Round {
    let done = false;
    return {
      stake,
      live: () => {},
      finish: async (payout) => {
        if (!done) this.freeChips += payout;
        done = true;
        return 'practice';
      },
    };
  }

  private async refresh(): Promise<void> {
    if (this.practice) return;
    try {
      this.freeChips = (await casino.player()).free;
      this.onChange?.();
    } catch {
      // the next round reads it again
    }
  }

  /** Called when the balance changed in the background. */
  onChange: (() => void) | null = null;
}

/** One line for the player about where the payout went. */
export function deliveryText(how: Delivery, payout: number): string {
  if (how === 'review') return `${payout}칩 · 큰 금액이라 관리자가 확인하면 잔고에 들어갑니다`;
  if (how === 'queued') return `${payout}칩 · 서버와 다시 연결되면 잔고에 들어갑니다`;
  return '';
}
