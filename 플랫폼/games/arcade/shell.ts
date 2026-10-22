// The frame every arcade game shares: title bar (balance, sound, back to the lobby), the stake control, the
// result line and the win effects. The game draws its own table into `stage`.
import './arcade.css';
import { h, setText } from '../../src/ui/dom.ts';
import { Bank, BankError, deliveryText, type Delivery } from './bank.ts';
import { isMuted, setMuted, sfx, unlock } from './sound.ts';
import { jitter } from './rng.ts';

export interface Shell {
  stage: HTMLElement;
  /** Extra controls next to the stake (difficulty, ball count …). */
  extra: HTMLElement;
  /** The game's main button(s) go here. */
  actions: HTMLElement;
  stake(): number;
  /** Disables the stake control (and the extra controls) while a round runs. */
  lock(on: boolean): void;
  /** Redraws the balance and the stake limits. */
  refresh(): void;
  say(text: string, tone?: 'win' | 'lose' | 'push' | 'info' | 'bad'): void;
  /** Where the payout went, under the result line (nothing when it is already in the balance). */
  delivered(how: Delivery, payout: number): void;
  /** Coins flying out of an element. */
  coins(from: Element, n?: number): void;
  /** A big centred banner (큰 당첨). */
  banner(title: string, sub: string, kind?: 'big' | 'jackpot'): void;
}

export async function mountShell(root: HTMLElement, bank: Bank, title: string, icon: string, rules: () => HTMLElement): Promise<Shell | null> {
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('keydown', unlock, { capture: true });

  const balance = h('b', { 'data-testid': 'arcade-balance' });
  const mute = h('button', { class: 'ab-icon', type: 'button', title: '소리', onclick: () => toggleMute() });
  const toggleMute = (): void => {
    setMuted(!isMuted());
    setText(mute, isMuted() ? '🔇' : '🔊');
  };
  setText(mute, isMuted() ? '🔇' : '🔊');
  const rulesBox = h('div', { class: 'ab-rules', hidden: true });
  const bar = h(
    'header',
    { class: 'ab-bar' },
    h('div', { class: 'ab-title' }, h('span', { class: 'ab-logo' }, icon), title),
    h('div', { class: 'ab-wallet' }, bank.practice ? '연습 칩 ' : '보유 ', balance),
    h(
      'button',
      {
        class: 'ab-icon',
        type: 'button',
        title: '규칙',
        onclick: () => {
          rulesBox.hidden = !rulesBox.hidden;
          if (!rulesBox.hidden) rulesBox.replaceChildren(rules());
        },
      },
      '📖',
    ),
    mute,
    h('button', { class: 'ab-btn ghost', type: 'button', 'data-testid': 'to-lobby', onclick: () => bank.exit() }, bank.practice ? '처음으로' : '로비로'),
  );
  root.replaceChildren(bar, rulesBox, h('div', { class: 'ab-loading' }, '잔고를 불러오는 중…'));

  try {
    await bank.load();
  } catch (e) {
    root.replaceChildren(
      bar,
      h(
        'div',
        { class: 'ab-fatal' },
        h('p', {}, e instanceof BankError ? e.message : '오류가 났습니다'),
        h('button', { class: 'ab-btn', type: 'button', onclick: () => location.reload() }, '다시 시도'),
      ),
    );
    return null;
  }

  let stake = Math.min(1, bank.maxStake) || 1;
  let locked = false;
  const stakeVal = h('b', { class: 'ab-stake-val', 'data-testid': 'stake' });
  const minus = h('button', { class: 'ab-step', type: 'button', 'data-testid': 'stake-down', onclick: () => setStake(stake - 1) }, '−');
  const plus = h('button', { class: 'ab-step', type: 'button', 'data-testid': 'stake-up', onclick: () => setStake(stake + 1) }, '+');
  const quick = [1, 5, 10].map((n) => h('button', { class: 'ab-chip', type: 'button', onclick: () => setStake(n) }, String(n)));
  const maxBtn = h('button', { class: 'ab-chip', type: 'button', onclick: () => setStake(bank.maxStake) }, '최대');
  const extra = h('div', { class: 'ab-extra' });
  const actions = h('div', { class: 'ab-actions' });
  const line = h('div', { class: 'ab-line', 'data-testid': 'result-line', 'aria-live': 'polite' });
  const note = h('div', { class: 'ab-note', 'data-testid': 'delivery' });
  const stage = h('main', { class: 'ab-stage' });
  const fx = h('div', { class: 'ab-fx', 'aria-hidden': 'true' });
  const panel = h(
    'section',
    { class: 'ab-panel' },
    h('div', { class: 'ab-stake' }, h('span', { class: 'ab-label' }, '판돈'), minus, stakeVal, plus, ...quick, maxBtn),
    extra,
    actions,
  );
  root.replaceChildren(bar, rulesBox, stage, line, note, panel, fx);

  function setStake(n: number): void {
    if (locked) return;
    const next = Math.max(1, Math.min(bank.maxStake || 1, Math.round(n)));
    if (next !== stake) sfx.bet();
    stake = next;
    refresh();
  }

  function refresh(): void {
    setText(balance, `${bank.free.toLocaleString('ko-KR')}칩`);
    if (stake > bank.maxStake && bank.maxStake > 0) stake = bank.maxStake;
    setText(stakeVal, `${stake}칩`);
    const max = bank.maxStake;
    minus.disabled = locked || stake <= 1;
    plus.disabled = locked || stake >= max;
    for (const b of [...quick, maxBtn]) b.disabled = locked || max < 1;
    quick.forEach((b, i) => (b.disabled = locked || [1, 5, 10][i] > max));
    for (const el of extra.querySelectorAll('button')) el.disabled = locked;
  }
  bank.onChange = refresh;

  const shell: Shell = {
    stage,
    extra,
    actions,
    stake: () => stake,
    lock(on) {
      locked = on;
      refresh();
    },
    refresh,
    say(text, tone = 'info') {
      line.className = `ab-line ${tone}`;
      setText(line, text);
    },
    delivered(how, payout) {
      setText(note, deliveryText(how, payout));
    },
    coins(from, n = 18) {
      const r = from.getBoundingClientRect();
      for (let i = 0; i < n; i++) {
        const c = h('span', { class: 'ab-coin' });
        c.style.left = `${r.left + r.width / 2}px`;
        c.style.top = `${r.top + r.height / 2}px`;
        c.style.setProperty('--dx', `${jitter(-160, 160)}px`);
        c.style.setProperty('--dy', `${jitter(-220, -40)}px`);
        c.style.animationDelay = `${jitter(0, 0.15)}s`;
        fx.append(c);
        setTimeout(() => c.remove(), 1300);
      }
    },
    banner(title, sub, kind = 'big') {
      const b = h('div', { class: `ab-banner ${kind}` }, h('div', { class: 'ab-banner-title' }, title), h('div', { class: 'ab-banner-sub' }, sub));
      fx.append(b);
      for (let i = 0; i < (kind === 'jackpot' ? 80 : 40); i++) {
        const c = h('span', { class: 'ab-confetti' });
        c.style.left = `${jitter(0, 100)}vw`;
        c.style.background = `hsl(${Math.floor(jitter(0, 360))} 90% 60%)`;
        c.style.animationDelay = `${jitter(0, 0.6)}s`;
        c.style.animationDuration = `${jitter(1.6, 2.8)}s`;
        fx.append(c);
        setTimeout(() => c.remove(), 3600);
      }
      setTimeout(() => b.remove(), kind === 'jackpot' ? 3200 : 2400);
    },
  };
  refresh();
  if (bank.practice) shell.say('연습 모드입니다. 카지노 앱에서 열면 진짜 칩으로 합니다.', 'info');
  return shell;
}

/** Tone for a result: profit, stake back or loss. */
export const toneOf = (stake: number, payout: number): 'win' | 'push' | 'lose' => (payout > stake ? 'win' : payout === stake ? 'push' : 'lose');

/** "+12칩", "본전", "−3칩" from the player's point of view. */
export function netText(stake: number, payout: number): string {
  const net = payout - stake;
  return net > 0 ? `+${net}칩` : net === 0 ? '본전' : `−${-net}칩`;
}
