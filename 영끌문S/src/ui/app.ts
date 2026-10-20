// Screen layout and game flow (DESIGN.md sections 1 and 5): stock tabs on the left (easiest first), the chart
// in the middle, account and orders (매수 · 인버스 · 매도) on the right. The market never closes and never pauses
// while a game runs (not even behind the 정산 dialog); every tick moves all stocks, then liquidates positions
// that touched their price. The game ends when the player settles or goes broke. Orders on a busy stock fill
// after its fill delay, at the price of that moment (DESIGN.md section 3).
import { Sfx } from '../audio.ts';
import { CONFIG, DIFFICULTY_LABEL, VOLUME_LABEL, type StockDef } from '../config.ts';
import {
  TRADE_ERROR_TEXT,
  buy,
  equity,
  isBroke,
  liquidate,
  liquidationPrice,
  maxMargin,
  newAccount,
  openFee,
  positionValue,
  sell,
  unrealized,
  type Account,
  type Fill,
  type TradeResult,
} from '../game/account.ts';
import { Market, type Stock } from '../game/market.ts';
import { between, cryptoRng } from '../rng.ts';
import { CandleChart, type ChartLine } from './chart.ts';
import { button, h } from './dom.ts';
import { clock, num, pct, qty, signedUsd, tone, usd } from './format.ts';

export type Screen = 'title' | 'trade' | 'confirm' | 'result';
type Side = 'buy' | 'inverse' | 'sell';
type EndReason = 'settle' | 'broke';
/** An order waiting for its fill. */
interface PendingOrder {
  id: string;
  kind: 'buy' | 'sell';
  margin: number; // buy
  leverage: number; // buy
  inverse: boolean; // buy
  fraction: number; // sell
  fillAt: number; // market tick
}

const MUTE_KEY = 'yeongkkeul:v1:muted';
const BUY_STEPS = [0.1, 0.25, 0.5, 1] as const;
const SELL_STEPS = [0.25, 0.5, 0.75, 1] as const;
const AMOUNT_STEP = 50;
const DEFAULT_AMOUNT = 100;
const MAX_CATCHUP = 600; // ticks; after a longer stall the market skips ahead instead of replaying
const ENTRY_COLOR = '#f5c542';
const LIQ_COLOR = '#c04dff';
const STOCKS: readonly StockDef[] = [...CONFIG.stocks].sort((a, b) => a.difficulty - b.difficulty);
const FLOAT_MIN_X = 180; // px: room for a floating "+$123.45" left of the newest candle
const stars = (n: number): string => `${'★'.repeat(n)}${'☆'.repeat(5 - n)}`;

export function mountApp(root: HTMLElement): void {
  const econ = CONFIG.economy;
  const T = CONFIG.timing;
  const rng = cryptoRng();
  const sfx = new Sfx(loadMuted());

  let market = new Market(rng);
  let account: Account = newAccount(econ);
  let screen: Screen = 'title';
  let selected = STOCKS[0].id;
  let side: Side = 'buy';
  let leverage = econ.leverages[0];
  let amount = DEFAULT_AMOUNT;
  let sellFraction = 1;
  let prevPrices = market.prices();
  let ending: { reason: EndReason; account: Account } | null = null;
  let pending: PendingOrder[] = [];

  // ------------------------------------------------------------ skeleton
  root.classList.add('app');
  const chart = new CandleChart(T.visibleCandles, T.zoomCandles, (T.ticksPerCandle * T.tickMs) / 1000);
  const fx = h('div', { class: 'fx' });
  chart.el.append(fx);

  const muteBtn = h('button', { class: 'icon-btn', type: 'button', 'data-testid': 'mute', title: '소리 (M)' });
  const settleBtn = button('정산하기', () => openConfirm(), { kind: 'ghost', testid: 'settle' });
  const clockLabel = h('span', { class: 'clock-label' }, '경과');
  const clockEl = h('div', { class: 'clock', 'data-testid': 'clock' }, clock(0));

  // Left: stock tabs + detail
  const tabs = STOCKS.map((def) => {
    const price = h('span', { class: 'tab-price' });
    const chg = h('span', { class: 'tab-chg' });
    const hold = h('span', { class: 'tab-hold', hidden: true });
    const el = h(
      'button',
      { class: 'tab', type: 'button', 'data-testid': `tab-${def.id}`, onclick: () => select(def.id) },
      h('span', { class: 'tab-top' }, h('span', { class: 'tab-name' }, def.name), hold),
      h(
        'span',
        { class: 'tab-ticker' },
        def.ticker,
        h('span', { class: 'level', 'data-level': def.difficulty, title: `난이도 ${stars(def.difficulty)}` }, DIFFICULTY_LABEL[def.difficulty]),
      ),
      h('span', { class: 'tab-bottom' }, price, chg),
    );
    return { def, el, price, chg, hold };
  });
  const detailName = h('h2', { class: 'detail-name' });
  const detailTicker = h('span', { class: 'detail-ticker' });
  const detailLevel = h('div', { class: 'level-row', 'data-testid': 'detail-level' });
  const detailDesc = h('p', { class: 'detail-desc', 'data-testid': 'detail-desc' });
  const detailStart = h('dd', {});
  const detailHigh = h('dd', { class: 'up' });
  const detailLow = h('dd', { class: 'down' });
  const detailVolume = h('dd', { 'data-testid': 'detail-volume' });

  // Center: chart header
  const headName = h('span', { class: 'head-name' });
  const headTicker = h('span', { class: 'head-ticker' });
  const headPrice = h('span', { class: 'head-price', 'data-testid': 'price' });
  const headChg = h('span', { class: 'head-chg' });

  // Right: account
  const accEquity = h('div', { class: 'acc-equity', 'data-testid': 'equity' });
  const accRate = h('span', { class: 'acc-rate', 'data-testid': 'equity-rate' });
  const accPnl = h('div', { class: 'acc-pnl' });
  const accCash = h('dd', { 'data-testid': 'cash' });
  const accInvested = h('dd', {});

  // Right: order
  const sideBuy = h('button', { class: 'side-tab buy', type: 'button', 'data-testid': 'side-buy', onclick: () => setSide('buy') }, '매수');
  const sideInverse = h(
    'button',
    { class: 'side-tab inverse', type: 'button', 'data-testid': 'side-inverse', title: '가격이 내리면 이익', onclick: () => setSide('inverse') },
    '인버스',
  );
  const sideSell = h('button', { class: 'side-tab sell', type: 'button', 'data-testid': 'side-sell', onclick: () => setSide('sell') }, '매도');
  const levBtns = econ.leverages.map((L) =>
    h('button', { class: 'seg-btn', type: 'button', 'data-testid': `lev-${L}`, onclick: () => setLeverage(L) }, `${L}×`),
  );
  const sideNote = h('div', { class: 'side-note', 'data-testid': 'side-note' });
  const levNote = h('div', { class: 'note', hidden: true }, '보유 중인 레버리지로 고정');
  const levLockNote = h('div', { class: 'note', 'data-testid': 'lev-lock', hidden: true }, `평가 자산 ${usd(econ.leverageFrom, 0)}부터 레버리지 사용 가능`);
  const amountInput = h('input', {
    class: 'amount-input',
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    'data-testid': 'amount',
  });
  const buyStepBtns = BUY_STEPS.map((f) =>
    h('button', { class: 'seg-btn', type: 'button', onclick: () => setAmountShare(f) }, f === 1 ? '최대' : `${f * 100}%`),
  );
  const pvSize = h('dd', {});
  const pvQty = h('dd', {});
  const pvFee = h('dd', {});
  const pvLiq = h('dd', { class: 'liq' });
  const buyMsg = h('div', { class: 'order-msg', 'data-testid': 'buy-msg' });
  const buyBtn = h('button', { class: 'big-btn buy', type: 'button', 'data-testid': 'buy', onclick: () => doBuy() }, '매수');
  const hvSide = h('dd', {});

  const hvQty = h('dd', {});
  const hvEntry = h('dd', {});
  const hvLev = h('dd', {});
  const hvPnl = h('dd', { 'data-testid': 'position-pnl' });
  const hvLiq = h('dd', { class: 'liq' });
  const sellStepBtns = SELL_STEPS.map((f) =>
    h('button', { class: 'seg-btn', type: 'button', 'data-testid': `sell-${f * 100}`, onclick: () => setSellFraction(f) }, `${f * 100}%`),
  );
  const svQty = h('dd', {});
  const svCash = h('dd', {});
  const sellMsg = h('div', { class: 'order-msg' });
  const sellBtn = h('button', { class: 'big-btn sell', type: 'button', 'data-testid': 'sell', onclick: () => doSell() }, '매도');

  const buyPane = h(
    'div',
    { class: 'pane' },
    sideNote,
    h('div', { class: 'field-label' }, '레버리지'),
    h('div', { class: 'seg' }, ...levBtns),
    levNote,
    levLockNote,
    h('div', { class: 'field-label' }, '증거금 (투자 금액)'),
    h(
      'div',
      { class: 'amount' },
      h('button', { class: 'step-btn', type: 'button', onclick: () => nudgeAmount(-AMOUNT_STEP) }, '−'),
      h('span', { class: 'amount-box' }, h('span', { class: 'amount-cur' }, '$'), amountInput),
      h('button', { class: 'step-btn', type: 'button', onclick: () => nudgeAmount(AMOUNT_STEP) }, '+'),
    ),
    h('div', { class: 'seg small' }, ...buyStepBtns),
    h(
      'dl',
      { class: 'rows' },
      h('dt', {}, '주문 규모'),
      pvSize,
      h('dt', {}, '예상 수량'),
      pvQty,
      h('dt', {}, '수수료'),
      pvFee,
      h('dt', {}, '청산가'),
      pvLiq,
    ),
    buyMsg,
    buyBtn,
  );
  const sellPane = h(
    'div',
    { class: 'pane', hidden: true },
    h('dl', { class: 'rows' }, h('dt', {}, '방향'), hvSide, h('dt', {}, '보유 수량'), hvQty, h('dt', {}, '평균 단가'), hvEntry, h('dt', {}, '레버리지'), hvLev, h('dt', {}, '평가 손익'), hvPnl, h('dt', {}, '청산가'), hvLiq),
    h('div', { class: 'field-label' }, '매도 비율'),
    h('div', { class: 'seg' }, ...sellStepBtns),
    h('dl', { class: 'rows' }, h('dt', {}, '매도 수량'), svQty, h('dt', {}, '예상 정산금'), svCash),
    sellMsg,
    sellBtn,
  );
  const holdingsList = h('div', { class: 'holdings-list', 'data-testid': 'holdings' });
  let holdingsKey = '';

  const overlay = h('div', { class: 'overlay', 'data-testid': 'overlay' });
  const toasts = h('div', { class: 'toasts', 'data-testid': 'toasts' });
  const flash = h('div', { class: 'flash' });

  root.replaceChildren(
    h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, '영끌문', h('b', {}, 'S')), h('span', { class: 'tagline' }, '모의 투자 시뮬레이터')),
      h('div', { class: 'top-mid' }, h('span', { class: 'live-dot' }), 'LIVE', clockLabel, clockEl),
      h('div', { class: 'top-actions' }, muteBtn, settleBtn),
    ),
    h(
      'aside',
      { class: 'col left' },
      h(
        'div',
        { class: 'panel tabs-panel' },
        h('div', { class: 'panel-title' }, '종목 · 쉬운 순'),
        h('div', { class: 'tabs' }, ...tabs.map((t) => t.el)),
      ),
      h(
        'div',
        { class: 'panel detail', 'data-testid': 'detail' },
        h('div', { class: 'detail-head' }, detailName, detailTicker),
        detailLevel,
        detailDesc,
        h(
          'dl',
          { class: 'rows' },
          h('dt', {}, '시작가'),
          detailStart,
          h('dt', {}, '게임 중 최고'),
          detailHigh,
          h('dt', {}, '게임 중 최저'),
          detailLow,
          h('dt', {}, '거래량'),
          detailVolume,
        ),
      ),
    ),
    h(
      'main',
      { class: 'col center panel' },
      h('div', { class: 'chart-head' }, h('div', { class: 'head-title' }, headName, headTicker), h('div', { class: 'head-quote' }, headPrice, headChg)),
      chart.el,
      toasts,
    ),
    h(
      'aside',
      { class: 'col right' },
      h(
        'div',
        { class: 'panel account' },
        h('div', { class: 'panel-title' }, '평가 자산'),
        h('div', { class: 'acc-equity-row' }, accEquity, accRate),
        accPnl,
        h('dl', { class: 'rows' }, h('dt', {}, '주문 가능 예탁금'), accCash, h('dt', {}, '투자 중 (평가)'), accInvested),
      ),
      h('div', { class: 'panel order' }, h('div', { class: 'side-tabs' }, sideBuy, sideInverse, sideSell), buyPane, sellPane),
      h('div', { class: 'panel holdings' }, h('div', { class: 'panel-title' }, '보유 종목'), holdingsList),
    ),
    flash,
    overlay,
  );

  // Session high / low per stock since the game started.
  let extremes = freshExtremes(market);

  // ------------------------------------------------------------ actions
  function select(id: string): void {
    if (id === selected) return;
    selected = id;
    sfx.play('click');
    chart.reset();
    const pos = account.positions[id];
    if (pos) leverage = pos.leverage;
    render();
  }

  function setSide(s: Side): void {
    if (side === s) return;
    side = s;
    sfx.play('click');
    render();
  }

  function setLeverage(L: number): void {
    if (account.positions[selected] || (L > 1 && leverageLocked())) return;
    leverage = L;
    sfx.play('click');
    render();
  }

  function setAmount(v: number): void {
    amount = Number.isFinite(v) ? Math.max(0, Math.floor(v * 100) / 100) : 0;
    amountInput.value = amount ? String(amount) : '';
    render();
  }

  function nudgeAmount(d: number): void {
    sfx.play('click');
    const max = maxMargin(account.cash, effectiveLeverage(), econ);
    setAmount(Math.min(max, Math.max(econ.minOrder, Math.round((amount + d) / AMOUNT_STEP) * AMOUNT_STEP)));
  }

  function setAmountShare(f: number): void {
    sfx.play('click');
    const max = maxMargin(account.cash, effectiveLeverage(), econ);
    setAmount(f >= 1 ? max : Math.floor(max * f));
  }

  function setSellFraction(f: number): void {
    sellFraction = f;
    sfx.play('click');
    render();
  }

  /** The held position's leverage, else the chosen one within the stock's limit (one of econ.leverages). */
  const effectiveLeverage = (): number => account.positions[selected]?.leverage ?? leverage;
  /** Leverage above 1× opens once the equity reaches econ.leverageFrom. */
  const leverageLocked = (): boolean => equity(account, market.prices()) < econ.leverageFrom;
  const current = (): Stock => market.get(selected);

  const isPending = (id: string): boolean => pending.some((o) => o.id === id);

  function doBuy(): void {
    if (screen !== 'trade' || side === 'sell' || isPending(selected)) return;
    place({ id: selected, kind: 'buy', margin: amount, leverage: effectiveLeverage(), inverse: side === 'inverse', fraction: 0 });
  }

  function doSell(): void {
    if (screen !== 'trade' || isPending(selected)) return;
    place({ id: selected, kind: 'sell', margin: 0, leverage: 0, inverse: false, fraction: sellFraction });
  }

  /** A quiet stock fills at once at the shown price; a busy one after its fill delay, at the price by then. */
  function place(order: Omit<PendingOrder, 'fillAt'>): void {
    const def = market.get(order.id).def;
    const delay = Math.round((between(rng, def.volume.fillDelay) * 1000) / T.tickMs);
    if (delay <= 0) return fill(order);
    pending.push({ ...order, fillAt: market.ticks + delay });
    sfx.play('click');
    toast(`${def.name} ${order.kind === 'sell' ? '매도' : order.inverse ? '인버스' : '매수'} 주문 접수 · 체결 대기 중`, 'flat');
    render();
  }

  function fill(order: Omit<PendingOrder, 'fillAt'>): void {
    if (screen !== 'trade' && screen !== 'confirm') return; // the game ended in the meantime
    const st = market.get(order.id);
    const { id, margin, leverage: L, inverse } = order;
    const r =
      order.kind === 'buy'
        ? buy(account, { stockId: id, price: st.price, margin, leverage: L, inverse }, econ, equity(account, market.prices()))
        : sell(account, id, st.price, order.fraction, econ);
    applyTrade(r, st);
  }

  function applyTrade(r: TradeResult, st: Stock): void {
    if (!r.ok) {
      sfx.play('error');
      toast(TRADE_ERROR_TEXT[r.error], 'warn');
      return;
    }
    account = r.account;
    const f = r.fill;
    const name = st.def.name;
    if (f.kind === 'buy') {
      const what = f.inverse ? '인버스' : '매수';
      sfx.play('buy');
      toast(`${name} ${qty(f.qty)}주 ${what} 체결 · ${usd(f.price, st.def.decimals)}`, f.inverse ? 'inverse' : 'up');
      floatText(`${what} ${usd(f.margin)}`, f.inverse ? 'inverse' : 'up');
      // A fresh buy cannot exceed what is left; keep the amount sane for the next order.
      if (amount > account.cash) setAmount(maxMargin(account.cash, effectiveLeverage(), econ));
    } else {
      sfx.play('sell');
      sfx.play(f.pnl >= 0 ? 'profit' : 'loss', 120);
      toast(`${name}${f.inverse ? ' 인버스' : ''} ${qty(f.qty)}주 매도 · 손익 ${signedUsd(f.pnl)}`, tone(f.pnl) === 'down' ? 'down' : 'up');
      floatText(signedUsd(f.pnl), tone(f.pnl));
      if (!account.positions[selected]) sellFraction = 1;
    }
    render();
    checkBroke();
  }

  function onLiquidated(fills: readonly Fill[]): void {
    sfx.play('liquidate');
    root.classList.remove('shake');
    void root.offsetWidth; // restart the animation
    root.classList.add('shake');
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');
    for (const f of fills) {
      const def = market.get(f.stockId).def;
      toast(`강제청산! ${def.name}${f.inverse ? ' 인버스' : ''} 증거금 ${usd(f.margin)} 손실`, 'liq');
      if (f.stockId === selected) banner('강제청산', `${def.name} −${usd(f.margin)}`);
    }
  }

  function checkBroke(): void {
    if (screen === 'trade' && isBroke(account, econ)) finish('broke');
  }

  // ------------------------------------------------------------ game flow
  function startGame(): void {
    sfx.unlock();
    sfx.play('start');
    // The market was created fresh for the title screen and has not moved since.
    account = newAccount(econ);
    extremes = freshExtremes(market);
    prevPrices = market.prices();
    selected = STOCKS[0].id;
    side = 'buy';
    leverage = econ.leverages[0];
    sellFraction = 1;
    ending = null;
    pending = [];
    setAmount(DEFAULT_AMOUNT);
    chart.reset();
    holdingsKey = '';
    toasts.replaceChildren();
    fx.replaceChildren();
    setScreen('trade');
  }

  function openConfirm(): void {
    if (screen !== 'trade') return;
    sfx.play('click');
    setScreen('confirm');
  }

  /** Sells everything at the current prices and shows the result. */
  function finish(reason: EndReason): void {
    if (screen !== 'trade' && screen !== 'confirm') return;
    pending = []; // orders still waiting are dropped; everything held is sold below
    for (const id of Object.keys(account.positions)) {
      const r = sell(account, id, market.get(id).price, 1, econ);
      if (r.ok) account = r.account;
    }
    ending = { reason, account };
    sfx.play(reason === 'broke' ? 'liquidate' : 'end');
    setScreen('result');
    renderClock(); // stops at the time the game ended
  }

  /** Back to the title with a fresh, still market (the next game starts from it). */
  function backToTitle(): void {
    sfx.play('click');
    market = new Market(rng);
    extremes = freshExtremes(market);
    prevPrices = market.prices();
    chart.reset();
    setScreen('title');
    renderClock();
  }

  function setScreen(s: Screen): void {
    screen = s;
    root.dataset.screen = s;
    renderOverlay();
    render();
  }

  function renderOverlay(): void {
    overlay.hidden = screen === 'trade';
    if (screen === 'title') {
      overlay.replaceChildren(
        h(
          'div',
          { class: 'card title-card' },
          h('div', { class: 'big-logo' }, '영끌문', h('b', {}, 'S')),
          h('p', { class: 'lead' }, '영혼까지 끌어모아 달까지!'),
          h(
            'ul',
            { class: 'rules' },
            h('li', {}, `기본예탁금 `, h('b', {}, usd(econ.deposit, 0)), '으로 시작합니다'),
            h('li', {}, '좌측 종목을 골라 차트를 보고 우측에서 매수 / 매도'),
            h('li', {}, h('b', {}, '인버스'), '는 가격이 내리면 이익, 오르면 손실'),
            h(
              'li',
              {},
              `평가 자산 `,
              h('b', {}, usd(econ.leverageFrom, 0)),
              `부터 레버리지 최대 `,
              h('b', {}, `${Math.max(...econ.leverages)}배`),
              ' — 청산가에 닿으면 증거금 전액 손실',
            ),
            h('li', {}, `매수·매도 때 주문 규모의 ${num(econ.feeRate * 100, 1)}% 수수료`),
            h('li', {}, h('b', {}, '장 마감 없음'), ' — 원할 때 정산하기를 눌러 끝냅니다'),
          ),
          button('게임 시작', () => startGame(), { kind: 'primary', key: 'Enter', testid: 'start' }),
        ),
      );
    } else if (screen === 'confirm') {
      overlay.replaceChildren(
        h(
          'div',
          { class: 'card confirm-card', 'data-testid': 'confirm' },
          h('h2', {}, '정산할까요?'),
          h('p', {}, '보유 종목을 모두 현재가로 매도하고 게임을 끝냅니다.'),
          h('p', { class: 'note' }, '시장은 멈추지 않습니다.'),
          h(
            'div',
            { class: 'btn-row' },
            button('계속하기', () => {
              sfx.play('click');
              setScreen('trade');
            }, { kind: 'ghost', key: 'Esc', testid: 'confirm-cancel' }),
            button('정산하기', () => finish('settle'), { kind: 'primary', testid: 'confirm-settle' }),
          ),
        ),
      );
    } else if (screen === 'result' && ending) {
      const a = ending.account;
      const total = a.cash;
      const net = total - econ.deposit;
      overlay.replaceChildren(
        h(
          'div',
          { class: `card result-card is-${tone(net)}`, 'data-testid': 'result' },
          h('h2', {}, ending.reason === 'broke' ? '파산했습니다…' : '정산 결과'),
          h('div', { class: 'result-time' }, `플레이 시간 ${clock((market.ticks * T.tickMs) / 1000)}`),
          h('div', { class: 'result-total', 'data-testid': 'result-total' }, usd(total)),
          h('div', { class: `result-net ${tone(net)}` }, `${signedUsd(net)} (${pct(net / econ.deposit)})`),
          h(
            'dl',
            { class: 'rows' },
            h('dt', {}, '시작 예탁금'),
            h('dd', {}, usd(econ.deposit)),
            h('dt', {}, '거래 횟수'),
            h('dd', {}, `${a.trades}회`),
            h('dt', {}, '강제청산'),
            h('dd', {}, `${a.liquidations}회`),
            h('dt', {}, '낸 수수료'),
            h('dd', {}, usd(a.fees)),
          ),
          button('처음으로', () => {
            backToTitle();
          }, { kind: 'primary', key: 'Enter', testid: 'restart' }),
        ),
      );
    } else {
      overlay.replaceChildren();
    }
  }

  // ------------------------------------------------------------ rendering
  function render(): void {
    const prices = market.prices();
    const st = current();
    const def = st.def;
    const d = def.decimals;
    const pos = account.positions[selected];

    // Tabs
    for (const t of tabs) {
      const p = prices[t.def.id];
      const chg = p / t.def.start - 1;
      t.el.classList.toggle('active', t.def.id === selected);
      setText(t.price, usd(p, t.def.decimals));
      setText(t.chg, pct(chg));
      setTone(t.chg, chg);
      setTone(t.price, p - prevPrices[t.def.id]);
      const held = account.positions[t.def.id];
      t.hold.hidden = !held;
      if (held) setText(t.hold, `${held.inverse ? '인버스' : '보유'} ${held.leverage}×`);
      t.hold.classList.toggle('inverse', !!held?.inverse);
    }

    // Detail
    setText(detailName, def.name);
    setText(detailTicker, def.ticker);
    setText(detailLevel, `난이도 ${stars(def.difficulty)} ${DIFFICULTY_LABEL[def.difficulty]}`);
    detailLevel.dataset.level = String(def.difficulty);
    setText(detailDesc, def.description);
    setText(detailStart, usd(def.start, d));
    setText(detailHigh, usd(extremes[selected].hi, d));
    setText(detailLow, usd(extremes[selected].lo, d));
    const vol = def.volume;
    setText(detailVolume, `${'▮'.repeat(vol.level)}${'▯'.repeat(5 - vol.level)} ${VOLUME_LABEL[vol.level]}`);

    // Chart head
    setText(headName, def.name);
    setText(headTicker, def.ticker);
    setText(headPrice, usd(st.price, d));
    setTone(headPrice, st.price - prevPrices[selected]);
    const chg = st.price / def.start - 1;
    setText(headChg, `${signedPrice(st.price - def.start, d)} (${pct(chg)})`);
    setTone(headChg, chg);

    // Account
    const eq = equity(account, prices);
    const net = eq - econ.deposit;
    setText(accEquity, usd(eq));
    setText(accRate, pct(net / econ.deposit));
    setTone(accRate, net);
    setText(accPnl, `${signedUsd(net)} (기본예탁금 ${usd(econ.deposit, 0)} 대비)`);
    setTone(accPnl, net);
    setText(accCash, usd(account.cash));
    setText(accInvested, usd(eq - account.cash));

    // Order
    const inverse = side === 'inverse';
    sideBuy.classList.toggle('active', side === 'buy');
    sideInverse.classList.toggle('active', inverse);
    sideSell.classList.toggle('active', side === 'sell');
    buyPane.hidden = side === 'sell';
    sellPane.hidden = side !== 'sell';
    setText(sideNote, inverse ? '인버스: 가격이 내리면 이익, 오르면 손실' : '매수: 가격이 오르면 이익, 내리면 손실');
    sideNote.classList.toggle('inverse', inverse);
    const locked = eq < econ.leverageFrom;
    if (!pos && locked) leverage = 1; // fell below the line: back to 1×
    const L = effectiveLeverage();
    levBtns.forEach((b, i) => {
      const Li = econ.leverages[i];
      b.classList.toggle('active', Li === L);
      b.disabled = pos ? Li !== L : locked && Li > 1;
    });
    levNote.hidden = !pos;
    levLockNote.hidden = !locked;
    if (document.activeElement !== amountInput && amountInput.value !== (amount ? String(amount) : '')) {
      amountInput.value = amount ? String(amount) : '';
    }
    const fee = openFee(amount, L, econ);
    const size = amount * L;
    setText(pvSize, `${usd(size)} (${L}×)`);
    setText(pvQty, `${qty(size / st.price)}주`);
    setText(pvFee, usd(fee));
    // After this order the entry is the average of what is held and what is bought.
    const entryAfter = pos ? (pos.qty * pos.entry + size) / (pos.qty + size / st.price) : st.price;
    setText(pvLiq, liqText(liquidationPrice({ entry: entryAfter, leverage: L, inverse }, econ), d));
    const buyError =
      pos && pos.inverse !== inverse
        ? TRADE_ERROR_TEXT.side
        : L > 1 && locked
        ? TRADE_ERROR_TEXT.locked
        : amount < econ.minOrder
          ? `최소 주문 ${usd(econ.minOrder, 0)}`
          : amount + fee > account.cash + 1e-9
            ? TRADE_ERROR_TEXT.cash
            : '';
    setText(buyMsg, buyError);
    const busy = isPending(selected);
    buyBtn.disabled = screen !== 'trade' || !!buyError || busy;
    setText(buyBtn, busy ? '체결 중…' : inverse ? '인버스' : '매수');
    buyBtn.classList.toggle('buy', !inverse);
    buyBtn.classList.toggle('inverse', inverse);

    if (pos) {
      const pnl = unrealized(pos, st.price);
      setText(hvSide, pos.inverse ? '인버스 (내리면 이익)' : '매수 (오르면 이익)');
      hvSide.className = pos.inverse ? 'inverse' : 'up';
      setText(hvQty, `${qty(pos.qty)}주`);
      setText(hvEntry, usd(pos.entry, d));
      setText(hvLev, `${pos.leverage}×`);
      setText(hvPnl, `${signedUsd(pnl)} (${pct(pnl / pos.margin)})`);
      setTone(hvPnl, pnl);
      setText(hvLiq, liqText(liquidationPrice(pos, econ), d));
      const sellQty = pos.qty * sellFraction;
      const back = positionValue(pos, st.price) * sellFraction - sellQty * st.price * econ.feeRate;
      setText(svQty, `${qty(sellQty)}주`);
      setText(svCash, usd(Math.max(0, back)));
    } else {
      for (const el of [hvSide, hvQty, hvEntry, hvLev, hvPnl, hvLiq, svQty, svCash]) setText(el, '—');
      hvSide.className = '';
      hvPnl.className = '';
    }
    sellStepBtns.forEach((b, i) => b.classList.toggle('active', SELL_STEPS[i] === sellFraction));
    setText(sellMsg, pos ? '' : '이 종목을 보유하고 있지 않습니다');
    sellBtn.disabled = screen !== 'trade' || !pos || busy;
    setText(sellBtn, busy ? '체결 중…' : '매도');

    renderHoldings(prices);
  }

  function renderHoldings(prices: Record<string, number>): void {
    const ids = Object.keys(account.positions);
    const key = ids.join(',');
    if (key !== holdingsKey) {
      holdingsKey = key;
      holdingsList.replaceChildren(
        ...(ids.length === 0
          ? [h('div', { class: 'empty' }, '보유 종목이 없습니다')]
          : ids.map((id) => {
              const def = market.get(id).def;
              return h(
                'button',
                { class: 'holding', type: 'button', 'data-id': id, onclick: () => select(id) },
                h('span', { class: 'h-name' }, def.name),
                h('span', { class: 'h-lev' }),
                h('span', { class: 'h-val' }),
                h('span', { class: 'h-pnl' }),
              );
            })),
      );
    }
    for (const row of holdingsList.querySelectorAll<HTMLElement>('.holding')) {
      const id = row.dataset.id!;
      const pos = account.positions[id];
      if (!pos) continue;
      const pnl = unrealized(pos, prices[id]);
      row.classList.toggle('active', id === selected);
      setText(row.querySelector('.h-lev')!, `${pos.inverse ? '인버스 ' : ''}${pos.leverage}×`);
      row.classList.toggle('inverse', pos.inverse);
      setText(row.querySelector('.h-val')!, usd(positionValue(pos, prices[id])));
      const pnlEl = row.querySelector<HTMLElement>('.h-pnl')!;
      setText(pnlEl, pct(pnl / pos.margin, 1));
      setTone(pnlEl, pnl);
    }
  }

  function chartLines(): ChartLine[] {
    const pos = account.positions[selected];
    if (!pos || screen === 'title') return [];
    const lines: ChartLine[] = [{ price: pos.entry, label: `${pos.inverse ? '인버스 ' : ''}평단 ${pos.leverage}×`, color: ENTRY_COLOR }];
    const liq = liquidationPrice(pos, econ);
    if (liq > 0) lines.push({ price: liq, label: '청산가', color: LIQ_COLOR });
    return lines;
  }

  // ------------------------------------------------------------ effects
  function toast(text: string, kind: 'up' | 'down' | 'inverse' | 'flat' | 'warn' | 'liq'): void {
    const el = h('div', { class: `toast ${kind}` }, text);
    toasts.append(el);
    while (toasts.children.length > 4) toasts.firstElementChild?.remove();
    setTimeout(() => el.classList.add('out'), kind === 'liq' ? 3200 : 2200);
    setTimeout(() => el.remove(), kind === 'liq' ? 3700 : 2700);
  }

  function floatText(text: string, kind: string): void {
    const p = chart.lastPoint();
    // The text ends at the newest candle; early in a game that candle is at the left edge, so keep it on screen.
    const el = h('div', { class: `float ${kind}`, style: `left:${Math.max(p.x, FLOAT_MIN_X)}px;top:${p.y}px` }, text);
    fx.append(el);
    setTimeout(() => el.remove(), 1400);
  }

  function banner(title: string, sub: string): void {
    const el = h('div', { class: 'banner' }, h('div', { class: 'banner-title' }, title), h('div', { class: 'banner-sub' }, sub));
    fx.append(el);
    setTimeout(() => el.remove(), 1900);
  }

  // ------------------------------------------------------------ input
  amountInput.addEventListener('input', () => {
    const clean = amountInput.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    if (clean !== amountInput.value) amountInput.value = clean;
    const v = Number(clean);
    amount = Number.isFinite(v) ? Math.floor(v * 100) / 100 : 0;
    render();
  });
  amountInput.addEventListener('blur', () => setAmount(amount));
  amountInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      amountInput.blur();
      doBuy();
    }
  });

  muteBtn.addEventListener('click', () => {
    sfx.unlock();
    sfx.setMuted(!sfx.isMuted);
    saveMuted(sfx.isMuted);
    renderMute();
  });
  function renderMute(): void {
    muteBtn.textContent = sfx.isMuted ? '🔇' : '🔊';
    muteBtn.classList.toggle('off', sfx.isMuted);
  }

  window.addEventListener('pointerdown', () => sfx.unlock(), { capture: true });
  window.addEventListener('keydown', (e) => {
    sfx.unlock();
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Enter' && (screen === 'title' || screen === 'result')) {
      e.preventDefault();
      if (screen === 'title') startGame();
      else backToTitle();
    } else if (e.key === 'Escape' && screen === 'confirm') {
      setScreen('trade');
    } else if ((e.key === 'm' || e.key === 'M') && !e.repeat) {
      muteBtn.click();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && screen === 'trade') {
      e.preventDefault();
      const i = STOCKS.findIndex((s) => s.id === selected);
      const n = STOCKS.length;
      select(STOCKS[(i + (e.key === 'ArrowUp' ? n - 1 : 1)) % n].id);
    }
  });
  // No context menu, no text selection drag, no wheel-zoom tricks on the inputs.
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // ------------------------------------------------------------ clock
  function tick(): void {
    prevPrices = market.prices();
    market.step();
    const prices = market.prices();
    for (const st of market.stocks) {
      const e = extremes[st.def.id];
      if (st.price > e.hi) e.hi = st.price;
      if (st.price < e.lo) e.lo = st.price;
    }
    if (screen === 'trade' || screen === 'confirm') {
      const r = liquidate(account, prices, econ);
      if (r.fills.length) {
        account = r.account;
        onLiquidated(r.fills);
        if (isBroke(account, econ)) finish('broke');
      }
      const due = pending.filter((o) => o.fillAt <= market.ticks);
      if (due.length) {
        pending = pending.filter((o) => o.fillAt > market.ticks);
        for (const o of due) fill(o);
      }
    }
  }

  /** Time played: the market has no close. */
  function renderClock(): void {
    setText(clockEl, clock((market.ticks * T.tickMs) / 1000));
  }

  let lastAt = performance.now();
  let owed = 0;
  setInterval(() => {
    const now = performance.now();
    owed += (now - lastAt) / T.tickMs;
    lastAt = now;
    // The title screen shows a frozen market; drop the time so the game does not start with a catch-up.
    if (screen === 'title') {
      owed = 0;
      return;
    }
    let n = Math.floor(owed);
    owed -= n;
    if (n === 0) return;
    if (n > MAX_CATCHUP) n = MAX_CATCHUP;
    for (let i = 0; i < n; i++) tick();
    if (screen === 'trade' || screen === 'confirm') renderClock();
    render();
  }, T.tickMs / 2);

  const frame = (): void => {
    chart.draw(current(), chartLines());
    requestAnimationFrame(frame);
  };

  renderMute();
  setAmount(DEFAULT_AMOUNT);
  setScreen('title');
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------ helpers
function freshExtremes(m: Market): Record<string, { hi: number; lo: number }> {
  return Object.fromEntries(m.stocks.map((s) => [s.def.id, { hi: s.price, lo: s.price }]));
}

function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function setTone(el: HTMLElement, v: number): void {
  const t = tone(v);
  el.classList.toggle('up', t === 'up');
  el.classList.toggle('down', t === 'down');
}

/** A 1× position borrows nothing and has no liquidation price. */
function liqText(price: number, d: number): string {
  return price > 0 ? usd(price, d) : '없음';
}

function signedPrice(v: number, d: number): string {
  return v > 0 ? `+${num(v, d)}` : v < 0 ? `−${num(-v, d)}` : num(0, d);
}

function loadMuted(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(muted: boolean): void {
  try {
    globalThis.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // Storage blocked: the setting lasts until the window closes.
  }
}
