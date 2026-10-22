// 요트 다이스: one round = three rolls. The stake leaves the balance at the first roll; after every change the
// ledger is told what the round would pay if the player stopped answering (the chosen dice kept, the rest rolled
// out: rules.ts autoFinish), so leaving in the middle neither refunds nor locks in a hand early.
import './style.css';
import { Bank, type Round } from '../../arcade/bank.ts';
import { mountShell, netText, toneOf, type Shell } from '../../arcade/shell.ts';
import { sfx } from '../../arcade/sound.ts';
import { h, setText } from '../../../src/ui/dom.ts';
import { PAYTABLE, ROLLS, YACHT_TILT, autoFinish, canRoll, evaluate, firstRollTilted, keeps, rollTilted, type RoundState } from './rules.ts';

const ROLL_MS = 750;
const FACE: Record<number, string> = {
  1: 'rotateX(0deg) rotateY(0deg)',
  6: 'rotateY(180deg)',
  2: 'rotateY(90deg)',
  5: 'rotateY(-90deg)',
  3: 'rotateX(-90deg)',
  4: 'rotateX(90deg)',
};
const PIPS: Record<number, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

const root = document.getElementById('app')!;
const bank = new Bank('yacht');
const shell = await mountShell(root, bank, '요트 다이스', '🎲', rules);
if (shell) start(shell);

function rules(): HTMLElement {
  return h(
    'div',
    {},
    h('p', {}, '판돈을 걸면 주사위 다섯 개를 굴립니다. 남길 주사위를 눌러 고르고 다시 굴리기를 두 번 더 합니다(모두 3번).'),
    h('p', {}, h('b', {}, '한 번 남긴 주사위는 다음 굴림부터 고정(LOCK)'), '되어 풀 수 없고, 매번 적어도 한 개는 굴려야 합니다.'),
    h('table', {}, ...PAYTABLE.map((p) => h('tr', {}, h('td', {}, h('b', {}, p.name)), h('td', {}, p.when), h('td', {}, p.mult === 1 ? '본전' : `×${p.mult}`)))),
    h('p', {}, '판돈 포함 배율입니다. 보통 손님 기준 환수율 약 93%, 잘 고르면 100%를 넘습니다.'),
  );
}

function start(shell: Shell): void {
  let state: RoundState | null = null;
  let round: Round | null = null;
  let rolling = false;
  let shown = [1, 2, 3, 4, 5];

  const cards = shown.map((_, i) => {
    const cube = h('div', { class: 'yd-cube' });
    for (let f = 1; f <= 6; f++) {
      const face = h('div', { class: `yd-face f${f}` });
      for (let p = 0; p < 9; p++) face.append(h('span', { class: PIPS[f].includes(p) ? `pip${f === 1 ? ' red' : ''}` : '' }));
      cube.append(face);
    }
    const tag = h('div', { class: 'yd-tag' });
    const card = h('button', { class: 'yd-card', type: 'button', 'data-testid': `die-${i}`, onclick: () => toggle(i) }, h('div', { class: 'yd-box' }, cube), tag);
    return { card, cube, tag };
  });
  const dots = Array.from({ length: ROLLS }, () => h('span', { class: 'yd-dot' }));
  const hand = h('div', { class: 'yd-hand', 'data-testid': 'yacht-hand' });
  const table = h(
    'aside',
    { class: 'yd-table' },
    h('h3', {}, '족보'),
    ...PAYTABLE.map((p) => h('div', { class: 'yd-row', 'data-key': p.key }, h('span', {}, p.name), h('small', {}, p.when), h('b', {}, p.mult === 1 ? '본전' : p.mult === 0 ? '×0' : `×${p.mult}`))),
  );
  const board = h(
    'div',
    { class: 'yd-board' },
    h('div', { class: 'yd-status' }, h('span', { class: 'yd-label' }, '굴림'), ...dots, hand),
    h('div', { class: 'yd-dice' }, ...cards.map((c) => c.card)),
    h('div', { class: 'yd-hint', 'data-testid': 'yacht-hint' }),
  );
  shell.stage.append(h('div', { class: 'yd-layout' }, board, table));
  const hint = board.querySelector('.yd-hint') as HTMLElement;

  const mainBtn = h('button', { class: 'ab-btn big', type: 'button', 'data-testid': 'yacht-main', onclick: () => void main() });
  shell.actions.append(mainBtn);

  function face(i: number, v: number, spin = false): void {
    const c = cards[i].cube;
    if (spin) {
      c.classList.add('rolling');
      return;
    }
    c.classList.remove('rolling');
    c.style.transform = FACE[v];
  }

  function paint(): void {
    const s = state;
    const keep = s ? keeps(s) : [];
    cards.forEach((c, i) => {
      const locked = !!s?.locked[i];
      const held = !!s && keep[i] && !locked;
      c.card.classList.toggle('held', held);
      c.card.classList.toggle('locked', locked);
      c.card.disabled = !s || rolling || locked || s.rolls >= ROLLS;
      setText(c.tag, locked ? '🔒 고정' : held ? 'HOLD' : s && s.rolls < ROLLS ? '굴림' : '');
    });
    dots.forEach((d, i) => d.classList.toggle('on', !!s && i < s.rolls));
    const cur = s ? evaluate(s.dice) : null;
    setText(hand, cur ? `${cur.name} · ${cur.mult === 1 ? '본전' : `×${cur.mult}`}` : '');
    for (const r of table.querySelectorAll('.yd-row')) r.classList.toggle('on', !!cur && (r as HTMLElement).dataset.key === cur.key);
    if (!s) {
      setText(mainBtn, `${shell.stake()}칩 걸고 굴리기`);
      mainBtn.disabled = rolling || bank.maxStake < 1 || bank.free < shell.stake();
      setText(hint, '판돈을 정하고 시작하세요');
    } else {
      const left = ROLLS - s.rolls;
      setText(mainBtn, `다시 굴리기 (남은 ${left}번)`);
      mainBtn.disabled = rolling || !canRoll(s);
      setText(hint, keeps(s).every((k) => k) ? '적어도 한 개는 굴려야 합니다' : '남길 주사위를 누르세요 · 남긴 주사위는 다음 굴림부터 고정됩니다');
    }
  }

  function toggle(i: number): void {
    if (!state || rolling || state.locked[i] || state.rolls >= ROLLS) return;
    const held = state.held.slice();
    held[i] = !held[i];
    state = { ...state, held };
    sfx.click();
    note();
    paint();
  }

  /** Tells the ledger what this round pays if it is left now. */
  function note(): void {
    if (!state || !round) return;
    round.live(round.stake * evaluate(autoFinish(state)).mult);
  }

  async function main(): Promise<void> {
    if (rolling) return;
    if (!state) {
      const stake = shell.stake();
      if (bank.free < stake) return shell.say('칩이 모자랍니다', 'bad');
      rolling = true;
      shell.lock(true);
      paint();
      try {
        round = await bank.begin(stake);
      } catch (e) {
        sfx.error();
        shell.say((e as Error).message, 'bad');
        rolling = false;
        shell.lock(false);
        paint();
        return;
      }
      shell.refresh();
      shell.delivered('sent', 0);
      const next = firstRollTilted((m) => bank.keep(stake, stake * m, YACHT_TILT));
      state = next;
      note();
      await animate(next, [false, false, false, false, false]);
    } else {
      if (!canRoll(state)) return;
      const before = keeps(state);
      const stake = round?.stake ?? 0;
      const next = rollTilted(state, (m) => bank.keep(stake, stake * m, YACHT_TILT));
      state = next;
      note();
      rolling = true;
      paint();
      await animate(next, before);
    }
    rolling = false;
    if (state && state.rolls >= ROLLS) await settle();
    paint();
  }

  async function animate(s: RoundState, kept: boolean[]): Promise<void> {
    rolling = true;
    paint();
    shell.say(`${s.rolls}번째 굴림…`, 'info');
    sfx.rattle();
    cards.forEach((_, i) => kept[i] || face(i, 0, true));
    await wait(ROLL_MS);
    s.dice.forEach((v, i) => {
      if (!kept[i]) setTimeout(() => {
        face(i, v);
        sfx.tick();
      }, i * 60);
    });
    await wait(5 * 60 + 250);
    shown = s.dice.slice();
    rolling = false;
    const cur = evaluate(s.dice);
    if (s.rolls < ROLLS) shell.say(`지금: ${cur.name}${cur.mult ? ` (×${cur.mult})` : ''}`, cur.mult > 1 ? 'win' : 'info');
  }

  async function settle(): Promise<void> {
    if (!state || !round) return;
    const r = round;
    const hand = evaluate(state.dice);
    const payout = r.stake * hand.mult;
    const tone = toneOf(r.stake, payout);
    shell.say(`${hand.name} ×${hand.mult} · ${netText(r.stake, payout)}`, tone);
    if (hand.key === 'yacht') {
      sfx.jackpot();
      shell.banner('YACHT!', `${payout}칩`, 'jackpot');
      shell.coins(board, 50);
    } else if (hand.mult >= 3) {
      sfx.bigWin();
      shell.banner(hand.name, `×${hand.mult} · ${payout}칩`);
      shell.coins(board, 24);
    } else if (tone === 'win') sfx.win();
    else if (tone === 'push') sfx.push();
    else sfx.lose();
    board.classList.add(tone === 'lose' ? 'lost' : 'won');
    const how = await r.finish(payout);
    shell.delivered(how, payout);
    await wait(900);
    board.classList.remove('lost', 'won');
    state = null;
    round = null;
    shell.lock(false);
  }

  bank.onChange = () => {
    shell.refresh();
    paint();
  };
  root.addEventListener('click', () => paint());
  shown.forEach((v, i) => face(i, v));
  paint();
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
