// 슬롯머신: one spin is one round. The stops are drawn when SPIN is pressed (table.ts) and noted with the ledger at
// once; the reels then roll to them, the third one slower when the first two already match.
import './style.css';
import { Bank } from '../../arcade/bank.ts';
import { mountShell, netText, toneOf, type Shell } from '../../arcade/shell.ts';
import { sfx } from '../../arcade/sound.ts';
import { h, setText } from '../../../src/ui/dom.ts';
import { PAIR, SLOT_TILT, STRIPS, SYMBOLS, TRIPLE, evaluate, lineAt, spinTilted, type Sym } from './table.ts';

// One symbol row in px, read from the page (the CSS makes it smaller on a phone).
const cellPx = (inner: HTMLElement): number => (inner.firstElementChild as HTMLElement | null)?.offsetHeight || 112;
const COPIES = 6; // strip repeats in the DOM, so a spin can travel several turns
const STOP_MS = [1100, 1600, 2100];
const TEASE_MS = 1300; // extra time on the last reel when two already match

const root = document.getElementById('app')!;
const bank = new Bank('slot');
const shell = await mountShell(root, bank, '럭키 슬롯', '🎰', rules);
if (shell) start(shell);

function rules(): HTMLElement {
  return h(
    'div',
    {},
    h('p', {}, '가운데 줄에 같은 그림이 나오면 판돈에 배율을 곱해 받습니다(판돈 포함).'),
    h(
      'table',
      {},
      ...SYMBOLS.map((s) => h('tr', {}, h('td', {}, `${s} ${s} ${s}`), h('td', {}, h('b', {}, `×${TRIPLE[s]}`)), h('td', {}, `${s} ${s}`), h('td', {}, PAIR[s] === 1 ? '본전' : `×${PAIR[s]}`))),
    ),
    h('p', {}, '릴마다 그림 비율이 다릅니다. 기대 환수율 88%.'),
  );
}

function start(shell: Shell): void {
  let spinning = false;
  const pos = [0, 0, 0]; // stop index shown on each reel
  const reels = STRIPS.map((strip) => {
    const inner = h('div', { class: 'sl-strip' });
    for (let c = 0; c < COPIES; c++) for (const s of strip) inner.append(h('div', { class: 'sl-cell' }, h('span', { class: `sl-sym ${symClass(s)}` }, s)));
    const win = h('div', { class: 'sl-reel' }, inner);
    return { win, inner };
  });
  const payline = h('div', { class: 'sl-payline' });
  const lights = h('div', { class: 'sl-lights' }, ...Array.from({ length: 18 }, (_, i) => h('span', { style: `--i:${i}` })));
  const machine = h(
    'div',
    { class: 'sl-machine', 'data-testid': 'slot-machine' },
    lights,
    h('div', { class: 'sl-head' }, h('span', { class: 'sl-badge' }, 'LUCKY 777'), h('span', { class: 'sl-jack' }, `JACKPOT ×${TRIPLE['7']}`)),
    h('div', { class: 'sl-window' }, ...reels.map((r) => r.win), payline),
  );
  const table = h(
    'aside',
    { class: 'sl-table' },
    h('h3', {}, '배당표'),
    ...SYMBOLS.map((s) =>
      h(
        'div',
        { class: 'sl-row', 'data-sym': s },
        h('span', { class: 'sl-combo' }, `${s}${s}${s}`),
        h('b', {}, `×${TRIPLE[s]}`),
        h('span', { class: 'sl-combo small' }, `${s}${s}`),
        h('b', { class: 'small' }, PAIR[s] === 1 ? '본전' : `×${PAIR[s]}`),
      ),
    ),
  );
  const history = h('div', { class: 'sl-history' });
  shell.stage.append(h('div', { class: 'sl-layout' }, machine, table), history);

  const spinBtn = h('button', { class: 'ab-btn big sl-spin', type: 'button', 'data-testid': 'spin', onclick: () => void doSpin() }, 'SPIN');
  shell.actions.append(spinBtn);
  document.addEventListener('keydown', (e) => {
    if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat && (e.target as HTMLElement).tagName !== 'BUTTON') {
      e.preventDefault();
      void doSpin();
    }
  });

  reels.forEach((_, i) => place(i, pos[i], false));
  window.addEventListener('resize', () => reels.forEach((_, i) => spinning || place(i, pos[i], false)));

  function place(reel: number, index: number, animate: boolean, ms = 0): void {
    const { inner } = reels[reel];
    inner.style.transition = animate ? `transform ${ms}ms cubic-bezier(0.18, 0.7, 0.25, 1.04)` : 'none';
    inner.style.transform = `translateY(${-(index - 1) * cellPx(inner)}px)`;
  }

  function paint(): void {
    spinBtn.disabled = spinning || bank.maxStake < 1 || bank.free < shell.stake();
  }

  async function doSpin(): Promise<void> {
    if (spinning) return;
    const stake = shell.stake();
    if (bank.free < stake || bank.maxStake < 1) {
      shell.say('칩이 모자랍니다', 'bad');
      return;
    }
    spinning = true;
    shell.lock(true);
    paint();
    clearWin();
    let round;
    try {
      round = await bank.begin(stake);
    } catch (e) {
      sfx.error();
      shell.say((e as Error).message, 'bad');
      spinning = false;
      shell.lock(false);
      paint();
      return;
    }
    const stops = spinTilted((m) => bank.keep(stake, stake * m, SLOT_TILT));
    const line = lineAt(stops);
    const win = evaluate(line);
    const payout = stake * win.mult;
    round.live(payout);
    shell.refresh();
    shell.say('행운을 빕니다…', 'info');
    sfx.click();

    const tease = line[0] === line[1] && (line[0] === '7' || line[0] === '🔔' || line[0] === '🍀');
    const stopAt = STOP_MS.map((t, i) => t + (i === 2 && tease ? TEASE_MS : 0));
    // Jump each reel back to its first copy, then roll forward several turns to the drawn stop.
    reels.forEach((_, i) => place(i, pos[i], false));
    void machine.offsetWidth;
    reels.forEach((r, i) => {
      const target = (COPIES - 2) * STRIPS[i].length + stops[i];
      r.win.classList.add('spinning');
      place(i, target, true, stopAt[i]);
    });
    const ticker = setInterval(() => sfx.tick(), 70);
    if (tease) setTimeout(() => machine.classList.add('tease'), STOP_MS[1]);
    await Promise.all(
      reels.map(
        (r, i) =>
          new Promise<void>((done) =>
            setTimeout(() => {
              r.win.classList.remove('spinning');
              sfx.thunk();
              pos[i] = stops[i];
              place(i, stops[i], false);
              done();
            }, stopAt[i]),
          ),
      ),
    );
    clearInterval(ticker);
    machine.classList.remove('tease');

    showWin(win.sym, win.count, stake, payout, win.label, win.mult);
    const how = await round.finish(payout);
    shell.delivered(how, payout);
    addHistory(line, win.mult);
    spinning = false;
    shell.lock(false);
    paint();
  }

  function showWin(sym: Sym | null, count: number, stake: number, payout: number, label: string, mult: number): void {
    const tone = toneOf(stake, payout);
    shell.say(mult === 0 ? `꽝 · ${netText(stake, payout)}` : `${label} ×${mult} · ${netText(stake, payout)}`, tone);
    if (!sym) {
      sfx.lose();
      return;
    }
    table.querySelector(`[data-sym="${sym}"]`)?.classList.add(count === 3 ? 'hit3' : 'hit2');
    reels.forEach((r, i) => {
      const cell = r.inner.children[pos[i]] as HTMLElement | undefined;
      if (lineAt(pos)[i] === sym) cell?.classList.add('win');
    });
    payline.classList.add(tone === 'win' ? 'win' : 'push');
    if (mult >= TRIPLE['7']) {
      sfx.jackpot();
      machine.classList.add('jackpot');
      shell.banner('JACKPOT 777', `${payout}칩!`, 'jackpot');
      shell.coins(machine, 60);
    } else if (mult >= 10) {
      sfx.bigWin();
      shell.banner(`${label}`, `×${mult} · ${payout}칩`);
      shell.coins(machine, 36);
    } else if (tone === 'win') {
      sfx.win();
      shell.coins(machine, 12);
    } else sfx.push();
  }

  function clearWin(): void {
    payline.classList.remove('win', 'push');
    machine.classList.remove('jackpot');
    for (const el of root.querySelectorAll('.sl-cell.win')) el.classList.remove('win');
    for (const el of table.querySelectorAll('.hit2, .hit3')) el.classList.remove('hit2', 'hit3');
  }

  function addHistory(line: Sym[], mult: number): void {
    const tag = h('span', { class: `sl-tag ${mult > 1 ? 'w' : mult === 1 ? 'p' : ''}` }, line.join(''), mult ? h('b', {}, ` ×${mult}`) : null);
    history.prepend(tag);
    while (history.children.length > 10) history.lastChild?.remove();
  }

  bank.onChange = () => {
    shell.refresh();
    paint();
  };
  root.addEventListener('click', () => paint());
  paint();
  setText(spinBtn, 'SPIN');
}

function symClass(s: Sym): string {
  return s === '7' ? 'seven' : '';
}
