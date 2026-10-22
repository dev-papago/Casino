// Screens and the round flow. UI phases live in memory;
// the session and stats are saved at start, at pick (before the reveal), at 정산 and at 지급 완료.
//
// 카지노 플랫폼: opened by the player app with ?casino, the chips come from the ledger
// instead of the staff. 칩 걸고 시작 takes the stake from the player's balance, 칩 받기 gives the stack back, and
// nothing is saved here: after every change the game tells the ledger bridge what the player would get back if it
// stopped now. During a round that is the stack minus the bet, so a reload or a closed window mid-round loses the
// bet instead of undoing the round; the player app settles whatever is left at that value.
import { Sfx } from '../audio';
import { CONFIG, LEVEL_IDS, PAID_LEVELS, saveSettings, sessionEconomy, type LevelId, type Settings } from '../config';
import { cappedByPayout, maxBetFor, quit, resumePhase, sessionNet, settleRound, startSession, winText, type Session } from '../game/session';
import { tiltedShuffle } from '../game/tilt';
import { generatePlan, moveTimes, type CupId, type Plan, type Slot } from '../game/shuffle';
import { cryptoRng } from '../rng';
import { emptyStats, recordPayout, recordRound, saveState, type SavedState } from '../storage';
import { adminPanel, pinPanel } from './admin';
import { DEFS_SVG, SOUND_OFF_SVG, SOUND_ON_SVG } from './art';
import { CupsView } from './cups';
import { button, fromHtml, h, signed, sleep } from './dom';
import { END_TEXT, chipDelayMs, chipIcon, confirmCard, settlementCard, stakeCard } from './panels';
import * as casino from '../../../../sdk/casino';

export type Screen = 'idle' | 'confirm' | 'stake' | 'pin' | 'admin' | 'game' | 'settlement';
export type Phase = 'ready' | 'showBall' | 'shuffling' | 'picking' | 'reveal' | 'result';
type Mode = 'paid' | 'practice';

export interface Boot {
  settings: Settings;
  state: SavedState;
  speed: number; // animation speed-up, ?speed=N (e2e only)
}

const ALL_CUPS: readonly CupId[] = [0, 1, 2];
const OVERLAP_NOTE = '겹친 컵은 지나갈 수도, 튕겨 돌아갈 수도 있어요 (반반)';
const DEMO_LEVEL = 'normal';
const MAX_PILE = 40; // chips drawn and ticked on the settlement card
const DEMO_RATE = 0.45; // the idle demo runs slower than real time
const TITLE_CLICKS = 5;
const TITLE_GAP_MS = 1500;

/** ?speed=N, clamped to 1..100; anything else is 1. */
export function parseSpeed(search: string): number {
  const v = Number(new URLSearchParams(search).get('speed'));
  return Number.isFinite(v) && v > 1 ? Math.min(100, v) : 1;
}

export function mountApp(root: HTMLElement, boot: Boot): void {
  const CASINO = casino.inCasino();
  // Booth mode hands out physical chips, so it stops at economy.autoSettleAt; the casino keeps game chips unlimited.
  const NO_LIMIT = 1_000_000;
  let settings = boot.settings;
  // In the casino the ledger keeps the chips: the booth's saved session and stats are not used.
  let state = CASINO ? { session: null, stats: emptyStats() } : boot.state;
  let ticket: casino.CasinoSession | null = null; // the ledger's game session for the chips on the table
  let outside = 0; // the player's chips left outside this 야바위 (for the 승리 추세)
  const speed = boot.speed;
  const T = CONFIG.timing;
  const rng = cryptoRng();
  const sfx = new Sfx(settings.sound);
  const ms = (x: number): number => x / speed;

  let screen: Screen = 'idle';
  let phase: Phase = 'ready';
  let mode: Mode = 'paid';
  let level: LevelId = 'easy'; // practice level
  let paidLevel: LevelId = PAID_LEVELS[0]; // paid: level and bet picked before each round
  let bet = 1;
  let tally = { rounds: 0, hits: 0 }; // this practice visit only
  let plan: Plan | null = null;
  let lastWin = false;
  let lastDelta = 0;
  let roundToken = 0; // bumps to abandon an async round sequence
  let demoToken = 0;
  let titleClicks = { n: 0, at: 0 };

  // ------------------------------------------------------------ skeleton
  document.body.append(fromHtml(DEFS_SVG));
  root.classList.add('app');
  root.style.setProperty('--speed', String(speed));
  const title = h('h1', { class: 'title', 'data-testid': 'title' }, '야바위');
  const badge = h('div', { class: 'badge', 'data-testid': 'badge' });
  const muteBtn = h('button', { class: 'mute', type: 'button', 'data-testid': 'mute' });
  const status = h('div', { class: 'status', 'data-testid': 'status' });
  const cups = new CupsView(T, (slot) => void pick(slot));
  const banner = h('div', { class: 'banner', 'data-testid': 'banner', hidden: true });
  const message = h('div', { class: 'message', 'data-testid': 'message', 'aria-live': 'polite' });
  const controls = h('div', { class: 'controls', 'data-testid': 'controls' });
  const overlay = h('div', { class: 'overlay', 'data-testid': 'overlay' });
  cups.el.append(banner);
  root.replaceChildren(
    h('header', { class: 'top' }, h('div', { class: 'lights' }), h('div', { class: 'brand' }, title), badge, muteBtn),
    status,
    h('main', { class: 'table' }, cups.el),
    message,
    controls,
    overlay,
  );

  // ------------------------------------------------------------ input
  root.addEventListener('pointerdown', () => sfx.unlock(), { capture: true });
  root.addEventListener('click', (e) => {
    const b = (e.target as Element).closest('button');
    if (!b) return;
    if (!b.classList.contains('zone')) sfx.play('click');
    b.blur(); // Space and Enter belong to the game, never to a focused button
  });
  muteBtn.addEventListener('click', toggleMute);
  title.addEventListener('click', () => {
    const now = performance.now();
    titleClicks = now - titleClicks.at < TITLE_GAP_MS ? { n: titleClicks.n + 1, at: now } : { n: 1, at: now };
    if (titleClicks.n < TITLE_CLICKS || CASINO) return; // no booth admin screen in the casino
    titleClicks = { n: 0, at: 0 };
    if (screen === 'idle') showPin();
  });
  const typing = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
  window.addEventListener('keydown', (e) => {
    sfx.unlock();
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const space = e.code === 'Space' || e.key === ' ';
    if (space || e.key === 'Enter') e.preventDefault();
    if (e.repeat) return;
    if (e.code === 'KeyM') return toggleMute();
    if (e.key === 'Escape' && (screen === 'confirm' || screen === 'stake' || screen === 'pin' || screen === 'admin')) return showIdle();
    if (screen !== 'game') return;
    const digit = '123'.indexOf(e.key);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return void (e.preventDefault(), stepLevel(e.key === 'ArrowLeft' ? -1 : 1));
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return void (e.preventDefault(), stepBet(e.key === 'ArrowUp' ? 1 : -1));
    if (e.key === 'PageUp' || e.key === 'PageDown') return void (e.preventDefault(), stepBet(e.key === 'PageUp' ? 10 : -10));
    if (e.key === 'End' || e.key === 'Home') return void (e.preventDefault(), stepBet(e.key === 'End' ? Infinity : -Infinity));
    if (space) void startRound();
    else if (e.key === 'Enter') void next();
    else if (digit >= 0) void pick(digit as Slot);
  });
  window.addEventListener('keyup', (e) => {
    if (!typing(e.target) && (e.code === 'Space' || e.key === ' ')) e.preventDefault();
  });

  // ------------------------------------------------------------ helpers
  function setScreen(s: Screen): void {
    // Leftovers from the previous screen: the win chip in flight and settlement count ticks.
    document.querySelectorAll('.flyer').forEach((el) => el.remove());
    sfx.stopTicks();
    screen = s;
    root.dataset.screen = s;
  }

  function session(): Session | null {
    return state.session;
  }

  function persist(next: SavedState): void {
    state = next;
    if (!CASINO) saveState(state);
    else if (ticket && state.session && !state.session.ended) casino.live(ticket, state.session.stack);
  }

  function renderMute(): void {
    const muted = settings.sound.muted;
    muteBtn.replaceChildren(fromHtml(muted ? SOUND_OFF_SVG : SOUND_ON_SVG), h('span', {}, muted ? '소리 꺼짐' : '소리 켜짐'), h('kbd', {}, 'M'));
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.classList.toggle('off', muted);
  }

  function toggleMute(): void {
    settings = saveSettings({ ...settings, sound: { ...settings.sound, muted: !settings.sound.muted } });
    sfx.set(settings.sound);
    renderMute();
    if (screen === 'admin') showAdmin();
  }

  // ------------------------------------------------------------ idle (+ confirm, PIN, admin on top of it)
  function showIdle(): void {
    roundToken++;
    setScreen('idle');
    root.dataset.phase = '';
    overlay.replaceChildren();
    banner.hidden = true;
    badge.textContent = '';
    cups.setPickable(false);
    status.replaceChildren(
      h('div', { class: 'pill' }, chipIcon(), `시작 칩 ${CONFIG.economy.buyIn}개`),
      h('div', { class: 'pill' }, PAID_LEVELS.map((id) => `${CONFIG.levels[id].label} ×${CONFIG.levels[id].multiplier}`).join(' · ')),
      h('div', { class: 'pill' }, '맞히면 +판돈 × 배율 · 틀리면 −판돈'),
      ...(CASINO ? [] : [h('div', { class: 'pill' }, `최대 ${CONFIG.economy.autoSettleAt}칩 · 되면 자동 정산`)]),
    );
    message.replaceChildren(
      h('div', { class: 'msg-main' }, '컵 속의 공을 찾아라!'),
      h('div', { class: 'msg-sub' }, `${OVERLAP_NOTE} · 정산할 때까지 계속 · 연습은 무료`),
    );
    controls.replaceChildren(
      CASINO
        ? button('칩 걸고 시작', () => void showStake(), { kind: 'primary', testid: 'new-guest' })
        : button('새 손님', showConfirm, { kind: 'primary', testid: 'new-guest' }),
      button('연습하기 (무료)', () => enterGame('practice'), { testid: 'practice' }),
      ...(CASINO ? [button('로비로', () => casino.exit(), { kind: 'ghost', testid: 'to-lobby' })] : []),
    );
    if (CASINO) status.firstElementChild?.replaceChildren(chipIcon(), '내 잔고의 칩으로 시작');
    void demo(++demoToken);
  }

  /** 칩 걸고 시작 (casino): how many chips to bring from the player's balance. */
  async function showStake(): Promise<void> {
    if (screen !== 'idle') return;
    setScreen('stake');
    overlay.replaceChildren(h('div', { class: 'card confirm' }, h('p', { class: 'lead' }, '잔고를 확인하는 중…')));
    let me: casino.CasinoPlayer;
    try {
      me = await casino.player();
    } catch (e) {
      overlay.replaceChildren(casinoError(e instanceof casino.CasinoError && e.code === 'session' ? '로그인이 끝났습니다. 로비에서 다시 로그인하세요' : '서버에 연결할 수 없습니다'));
      return;
    }
    if ((screen as Screen) !== 'stake') return; // closed while waiting
    const max = me.free; // in the casino there is no stake or payout limit (only physical chips are capped, per player)
    if (max < 1) return void overlay.replaceChildren(casinoError('사용할 수 있는 칩이 없습니다'));
    overlay.replaceChildren(
      stakeCard(me.free, max, (stake) => void startCasino(me.id, stake), showIdle),
    );
  }

  async function startCasino(playerId: string, stake: number): Promise<void> {
    try {
      ticket = await casino.open('yabawi', stake, playerId);
    } catch (e) {
      overlay.replaceChildren(casinoError(e instanceof casino.CasinoError ? e.message : '칩을 가져오지 못했습니다'));
      return;
    }
    outside = Math.max(0, (await casino.player().then((me) => me.free).catch(() => 0)));
    if (screen !== 'stake') {
      // Left the card while the chips were on their way: give them straight back.
      void casino.close(ticket, stake);
      ticket = null;
      return;
    }
    persist({ ...state, session: startSession({ ...sessionEconomy(settings), buyIn: stake, autoSettleAt: NO_LIMIT }, Date.now()) });
    enterGame('paid');
  }

  function casinoError(text: string): HTMLElement {
    return h(
      'div',
      { class: 'card confirm', 'data-testid': 'casino-error' },
      h('p', { class: 'lead' }, text),
      h('div', { class: 'row' }, button('확인', showIdle, { kind: 'primary' })),
    );
  }

  async function demo(token: number): Promise<void> {
    cups.reset();
    await sleep(ms(800));
    while (token === demoToken) {
      const p = generatePlan(DEMO_LEVEL, CONFIG, rng);
      cups.show(p, 0);
      if (!(await cups.play(p, DEMO_RATE * speed))) return;
      await sleep(ms(1600));
    }
  }

  function stopDemo(): void {
    demoToken++;
    cups.stop();
  }

  function showConfirm(): void {
    if (screen !== 'idle') return;
    setScreen('confirm');
    overlay.replaceChildren(confirmCard(sessionEconomy(settings), startPaid, showIdle));
  }

  function showPin(): void {
    setScreen('pin');
    overlay.replaceChildren(pinPanel(settings.pin, showAdmin, showIdle));
  }

  function showAdmin(): void {
    setScreen('admin');
    overlay.replaceChildren(
      adminPanel({
        settings: () => settings,
        state: () => state,
        saveSettings: (s) => {
          settings = saveSettings(s);
          sfx.set(settings.sound);
          renderMute();
          return settings;
        },
        resetStats: () => persist({ ...state, stats: emptyStats() }),
        exit: showIdle,
      }),
    );
  }

  // ------------------------------------------------------------ game (paid and practice share every phase)
  function startPaid(): void {
    if (screen !== 'confirm') return;
    persist({ ...state, session: startSession(sessionEconomy(settings), Date.now()) });
    enterGame('paid');
  }

  function enterGame(m: Mode): void {
    stopDemo();
    roundToken++;
    mode = m;
    tally = { rounds: 0, hits: 0 };
    plan = null;
    clampChoice();
    overlay.replaceChildren();
    setScreen('game');
    cups.reset();
    setPhase('ready');
  }

  function setPhase(p: Phase): void {
    phase = p;
    root.dataset.phase = p;
    cups.setPickable(p === 'picking');
    renderGame();
  }

  async function startRound(): Promise<void> {
    if (screen !== 'game' || phase !== 'ready') return;
    const s = session();
    if (mode === 'paid' && (!s || s.ended || bet < 1 || bet > maxBetFor(s, paidLevel))) return;
    const token = ++roundToken;
    // 승리 추세 (casino): the round may be shuffled like 쉬움 or 최상, paid as the level chosen (game/tilt.ts).
    const shuffleLike =
      CASINO && mode === 'paid' && s
        ? tiltedShuffle(paidLevel, outside + s.stack + casino.chipsElsewhere('yabawi'), CONFIG, () => rng.float())
        : undefined;
    const p = generatePlan(mode === 'paid' ? paidLevel : level, CONFIG, rng, shuffleLike);
    plan = p;
    // From here the bet is on the table: stopping before the pick loses it.
    if (CASINO && mode === 'paid' && ticket && s) casino.live(ticket, s.stack - bet);
    // Show the ball under cup `start`, then lower the cup; the ball leaves the DOM before the shuffle.
    cups.reset();
    cups.show(p, 0);
    cups.putBall(p.start);
    setPhase('showBall');
    cups.lift([p.start], true, ms(T.showBallMs * 0.26));
    sfx.play('lift');
    await sleep(ms(T.showBallMs * 0.7));
    if (token !== roundToken) return;
    cups.lift([p.start], false, ms(T.showBallMs * 0.22));
    sfx.play('drop', ms(T.showBallMs * 0.18));
    await sleep(ms(T.showBallMs * 0.3));
    if (token !== roundToken) return;
    cups.removeBall();
    setPhase('shuffling');
    shuffleSounds(p);
    if (!(await cups.play(p, speed)) || token !== roundToken) return;
    setPhase('picking');
  }

  /** One 'swish' per move whatever its kind, one 'tak' when overlapping cups meet (same for pass and bounce). */
  function shuffleSounds(p: Plan): void {
    const times = moveTimes(p);
    p.moves.forEach((m, k) => {
      sfx.play('swish', ms(times[k]));
      if (m.kind === 'overlap') sfx.play('tak', ms(times[k] + (m.durMs - Math.min(T.overlapDwellMs, m.durMs)) / 2));
    });
  }

  async function pick(slot: Slot): Promise<void> {
    if (screen !== 'game' || phase !== 'picking' || !plan) return;
    const p = plan;
    const token = roundToken;
    const win = slot === p.final;
    const s = session();
    if (mode === 'paid') {
      if (!s) return;
      const next = settleRound(s, p.level, bet, slot, p, rng);
      lastDelta = next.rounds[next.rounds.length - 1].delta;
      persist({ session: next, stats: recordRound(state.stats, p.level, win) });
    } else {
      persist({ ...state, stats: recordRound(state.stats, p.level, win) });
      tally = { rounds: tally.rounds + 1, hits: tally.hits + (win ? 1 : 0) };
    }
    lastWin = win;
    setPhase('reveal');
    // The picked cup first, then the others; the ball is drawn under cup `start`.
    const picked = cups.cupAt(slot);
    cups.putBall(p.start);
    cups.lift([picked], true, ms(320));
    sfx.play('lift');
    await sleep(ms(T.revealMs * 0.42));
    if (token !== roundToken) return;
    cups.lift(
      ALL_CUPS.filter((c) => c !== picked),
      true,
      ms(320),
    );
    sfx.play('lift');
    await sleep(ms(T.revealMs * 0.58));
    if (token !== roundToken) return;
    setPhase('result');
    if (win) {
      sfx.play('win');
      if (mode === 'paid') flyChip();
      if (mode === 'paid' && (lastDelta >= 10 || session()?.ended === 'cap')) sfx.play('clear', 450);
    } else {
      sfx.play('lose');
      cups.shake(picked, ms(T.resultMs * 0.6));
    }
  }

  async function next(): Promise<void> {
    if (screen !== 'game' || phase !== 'result') return;
    if (mode === 'paid' && session()?.ended) return showSettlement();
    roundToken++;
    cups.lowerAll(ms(260));
    sfx.play('drop', ms(200));
    clampChoice();
    setPhase('ready');
  }

  // ------------------------------------------------------------ paid: level and bet for the next round
  /** Keeps the chosen level playable and the bet within 1..(what the stack can lose). */
  function clampChoice(): void {
    const s = session();
    if (mode !== 'paid' || !s) return;
    if (maxBetFor(s, paidLevel) < 1) paidLevel = PAID_LEVELS.find((id) => maxBetFor(s, id) >= 1) ?? PAID_LEVELS[0];
    bet = Math.max(1, Math.min(bet, maxBetFor(s, paidLevel)));
  }

  function chooseLevel(id: LevelId): void {
    const s = session();
    if (screen !== 'game' || phase !== 'ready' || mode !== 'paid' || !s || maxBetFor(s, id) < 1) return;
    paidLevel = id;
    clampChoice();
    renderGame();
  }

  function stepLevel(dir: -1 | 1): void {
    if (mode === 'practice') {
      if (phase !== 'ready' && phase !== 'result') return;
      const i = LEVEL_IDS.indexOf(level) + dir;
      if (i >= 0 && i < LEVEL_IDS.length) level = LEVEL_IDS[i];
      return renderGame();
    }
    const s = session();
    if (!s) return;
    for (let i = PAID_LEVELS.indexOf(paidLevel) + dir; i >= 0 && i < PAID_LEVELS.length; i += dir) {
      if (maxBetFor(s, PAID_LEVELS[i]) >= 1) return chooseLevel(PAID_LEVELS[i]);
    }
  }

  /** Changes the bet by `d` (±Infinity: to the minimum or the maximum). */
  function stepBet(d: number): void {
    const s = session();
    if (screen !== 'game' || phase !== 'ready' || mode !== 'paid' || !s) return;
    bet = Math.max(1, Math.min(bet + d, maxBetFor(s, paidLevel)));
    renderGame();
  }

  function quitSession(): void {
    const s = session();
    if (screen !== 'game' || mode !== 'paid' || !s || s.ended) return;
    if (phase !== 'ready' && phase !== 'result') return;
    persist({ ...state, session: quit(s) });
    showSettlement();
  }

  function flyChip(): void {
    const from = cups.ballRect();
    const target = status.querySelector('[data-testid="stack"] .chip-svg');
    const s = session();
    if (!from || !target || !s) return;
    const to = target.getBoundingClientRect();
    const fly = h('div', { class: 'flyer' }, chipIcon(), h('b', {}, signed(lastDelta)));
    document.body.append(fly);
    const x0 = from.left + from.width / 2;
    const y0 = from.top;
    const x1 = to.left + to.width / 2;
    const y1 = to.top + to.height / 2;
    const at = (x: number, y: number, k: number): string => `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${k})`;
    const anim = fly.animate(
      [
        { transform: at(x0, y0, 0.6), opacity: 0 },
        { transform: at(x0, y0 - 70, 1.5), opacity: 1, offset: 0.3 },
        { transform: at(x1, y1, 0.5), opacity: 0.8 },
      ],
      { duration: ms(T.resultMs), easing: 'cubic-bezier(.45,0,.55,1)' },
    );
    anim.onfinish = () => {
      fly.remove();
      status.querySelector('[data-testid="stack"]')?.classList.add('pulse');
    };
  }

  // ------------------------------------------------------------ game rendering
  function renderGame(): void {
    const s = session();
    const lv = CONFIG.levels[mode === 'paid' ? paidLevel : level];
    badge.textContent = mode === 'paid' ? `칩 게임 · ${lv.label} ×${lv.multiplier}` : `무료 연습 · ${lv.label}`;
    badge.className = mode === 'paid' ? 'badge paid' : 'badge';
    if (phase !== 'reveal') renderStatus(s); // the status bar must not give the answer away before the cups lift
    renderMessage(s);
    renderControls(s);
    const ended = mode === 'paid' && phase === 'result' ? (s?.ended ?? null) : null; // 종료 배너
    banner.hidden = !ended;
    banner.textContent = ended ? END_TEXT[ended] : '';
    banner.dataset.reason = ended ?? '';
  }

  function renderStatus(s: Session | null): void {
    if (mode === 'practice') {
      const canSwitch = phase === 'ready' || phase === 'result';
      status.replaceChildren(
        h('div', { class: 'pill' }, '무료 연습 · 칩 없음'),
        h(
          'div',
          { class: 'seg', role: 'group', 'aria-label': '난이도' },
          ...LEVEL_IDS.map((id) => {
            const b = button(CONFIG.levels[id].label, () => {
              level = id;
              renderGame();
            });
            b.classList.toggle('on', id === level);
            b.disabled = !canSwitch;
            return b;
          }),
        ),
        h('div', { class: 'pill' }, '맞힌 판 ', h('b', {}, `${tally.hits} / ${tally.rounds}`)),
      );
      return;
    }
    if (!s) return status.replaceChildren();
    status.replaceChildren(
      h('div', { class: 'pill big', 'data-testid': 'stack' }, chipIcon(), '칩 ', h('b', { 'data-testid': 'stack-n' }, s.stack), '개'),
      h('div', { class: 'pill' }, '판 ', h('b', { 'data-testid': 'rounds' }, s.rounds.length)),
      h('div', { class: 'pill' }, '손님 결과 ', h('b', { 'data-testid': 'net' }, signed(sessionNet(s)))),
      ...(s.ended || phase === 'result'
        ? []
        : [h('div', { class: 'pill stakes', 'data-testid': 'stakes' }, `판돈 ${bet} · 맞히면 `, h('b', { class: 'win' }, winText(bet, paidLevel)), ' · 틀리면 ', h('b', { class: 'lose' }, `−${bet}`))]),
    );
  }

  function renderMessage(s: Session | null): void {
    const set = (main: string, sub?: string, cls = ''): void =>
      message.replaceChildren(h('div', { class: `msg-main ${cls}`.trim() }, main), ...(sub ? [h('div', { class: 'msg-sub' }, sub)] : []));
    switch (phase) {
      case 'ready':
        if (mode === 'paid') return set('난이도와 판돈을 고르고 [섞기 시작]', `← → 난이도 · ↑ ↓ 판돈 · ${OVERLAP_NOTE}`);
        return set('[섞기 시작]을 누르면 공을 보여 주고 컵을 섞어요', OVERLAP_NOTE);
      case 'showBall':
        return set('공은 이 컵 안에 있어요!');
      case 'shuffling':
        return set('잘 보세요…');
      case 'picking':
        return set('컵을 고르세요', '클릭하거나 키보드 1 · 2 · 3', 'pulse-text');
      case 'reveal':
        return set('과연…');
      case 'result': {
        if (mode === 'practice') return set(lastWin ? '맞혔어요!' : '아쉬워요! 공은 다른 컵에 있었어요', undefined, lastWin ? 'win' : 'lose');
        if (!s) return;
        const delta = lastDelta;
        message.replaceChildren(
          h(
            'div',
            { class: `msg-main ${lastWin ? 'win' : 'lose'}` },
            h('span', { class: 'delta', 'data-testid': 'delta' }, signed(delta)),
            lastWin ? ' 맞혔어요! ' : ' 아쉬워요. ',
            `남은 칩 ${s.stack}개`,
          ),
        );
        return;
      }
    }
  }

  function renderControls(s: Session | null): void {
    const paid = mode === 'paid';
    const leave = paid
      ? button('정산하기', quitSession, { kind: 'ghost', testid: 'quit' })
      : button('연습 끝내기', showIdle, { kind: 'ghost', testid: 'practice-exit' });
    if (phase === 'ready') {
      controls.replaceChildren(
        ...(paid && s ? [levelPicker(s), betPicker(s)] : []),
        button('섞기 시작', () => void startRound(), { kind: 'primary', key: 'Space', testid: 'start-round' }),
        leave,
      );
    } else if (phase === 'result') {
      controls.replaceChildren(
        ...(paid && s?.ended
          ? [button('정산하기', () => void next(), { kind: 'primary', key: 'Enter', testid: 'to-settlement' })]
          : [button('다음 판', () => void next(), { kind: 'primary', key: 'Enter', testid: 'next-round' }), leave]),
      );
    } else {
      controls.replaceChildren(); // no input while the ball is shown, the cups move or the reveal runs
    }
  }

  function levelPicker(s: Session): HTMLElement {
    return h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': '난이도', 'data-testid': 'level-picker' },
      ...PAID_LEVELS.map((id) => {
        const lv = CONFIG.levels[id];
        const b = button(`${lv.label} ×${lv.multiplier}`, () => chooseLevel(id), { testid: `level-${id}` });
        b.classList.toggle('on', id === paidLevel);
        b.disabled = maxBetFor(s, id) < 1;
        return b;
      }),
    );
  }

  function betPicker(s: Session): HTMLElement {
    const max = maxBetFor(s, paidLevel);
    const minus = button('−', () => stepBet(-1), { testid: 'bet-minus' });
    const plus = button('+', () => stepBet(1), { testid: 'bet-plus' });
    const all = button('최대', () => stepBet(Infinity), { testid: 'bet-max' });
    minus.disabled = bet <= 1;
    plus.disabled = all.disabled = bet >= max;
    return h(
      'div',
      { class: 'bet', role: 'group', 'aria-label': '판돈' },
      h('span', { class: 'bet-label' }, '판돈'),
      minus,
      h('b', { class: 'bet-n', 'data-testid': 'bet-n' }, bet),
      plus,
      all,
      h('small', {}, cappedByPayout(s, paidLevel) ? `최대 ${max} (${s.econ.autoSettleAt ?? CONFIG.economy.autoSettleAt}칩 한도)` : `최대 ${max} · PgUp/PgDn ±10`),
    );
  }

  // ------------------------------------------------------------ settlement
  function showSettlement(): void {
    const s = session();
    if (!s?.ended) return showIdle();
    stopDemo();
    roundToken++;
    setScreen('settlement');
    root.dataset.phase = '';
    cups.setPickable(false);
    controls.replaceChildren();
    overlay.replaceChildren(settlementCard({ ...s, ended: s.ended }, payout, MAX_PILE, CASINO));
    if (CASINO && ticket) casino.live(ticket, s.stack);
    for (let i = 0; i < Math.min(s.stack, MAX_PILE); i++) sfx.play('tick', ms(chipDelayMs(i)));
  }

  function payout(): void {
    const s = session();
    if (screen !== 'settlement' || !s?.ended) return;
    if (CASINO && ticket) {
      const t = ticket;
      ticket = null;
      const back = overlay.querySelector<HTMLButtonElement>('[data-testid="paid-out"]');
      if (back) back.disabled = true;
      void casino.close(t, s.stack).then((how) => {
        persist({ session: null, stats: recordPayout(state.stats, s) });
        showIdle();
        message.replaceChildren(
          h(
            'div',
            { class: 'msg-main win', 'data-testid': 'casino-done' },
            how === 'sent' ? `${s.stack}칩이 내 잔고로 들어갔어요` : how === 'review' ? `${s.stack}칩, 관리자 확인 중이에요` : `${s.stack}칩 정산을 보내는 중이에요`,
          ),
          h(
            'div',
            { class: 'msg-sub' },
            how === 'sent'
              ? '다시 하려면 [칩 걸고 시작]'
              : how === 'review'
                ? '큰 금액이라 관리자가 확인하면 잔고에 들어갑니다'
                : '서버와 다시 연결되면 자동으로 잔고에 들어갑니다',
          ),
        );
      });
      return;
    }
    persist({ session: null, stats: recordPayout(state.stats, s) });
    showIdle();
  }

  // ------------------------------------------------------------ boot (refresh rule, section 3)
  renderMute();
  if (CASINO) {
    showIdle();
    void casino.settleLeftovers('yabawi'); // a 야바위 that stopped without 칩 받기 (reload, window closed)
    return;
  }
  const resume = resumePhase(state.session);
  if (resume === 'settlement') showSettlement();
  else if (resume === 'ready') enterGame('paid');
  else showIdle();
}
