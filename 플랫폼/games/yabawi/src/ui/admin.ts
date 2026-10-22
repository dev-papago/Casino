// Admin screen: PIN entry, stats (numbers only), settings, data.
import { CONFIG, LEVEL_IDS, PAID_LEVELS, defaultSettings, type Settings } from '../config';
import { END_REASONS, type EndReason } from '../game/session';
import type { SavedState, Stats } from '../storage';
import { button, h, signed } from './dom';

export interface AdminHost {
  settings(): Settings;
  state(): SavedState;
  /** Saves (normalized) and returns what was saved. */
  saveSettings(s: Settings): Settings;
  resetStats(): void;
  exit(): void;
}

const REASON_LABEL: Record<EndReason, string> = { broke: '칩 소진', quit: '정산', cap: '자동 정산' };

/** Plain comparison, no lockout. */
export function pinPanel(pin: string, onOk: () => void, onCancel: () => void): HTMLElement {
  const input = h('input', {
    class: 'pin-input',
    type: 'password',
    inputmode: 'numeric',
    autocomplete: 'off',
    maxlength: 12,
    'aria-label': '관리자 PIN',
    'data-testid': 'pin-input',
  });
  const err = h('p', { class: 'err', role: 'alert' });
  const submit = (): void => {
    if (input.value === pin) return onOk();
    err.textContent = 'PIN이 맞지 않아요';
    input.value = '';
    input.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    else if (e.key === 'Escape') onCancel();
  });
  setTimeout(() => input.focus());
  return h(
    'div',
    { class: 'card pin-card' },
    h('h2', {}, '관리자'),
    h('p', { class: 'lead' }, 'PIN을 입력하세요'),
    input,
    err,
    h('div', { class: 'row' }, button('확인', submit, { kind: 'primary' }), button('취소', onCancel, { kind: 'ghost' })),
  );
}

export function adminPanel(host: AdminHost): HTMLElement {
  const el = h('div', { class: 'card admin', 'data-testid': 'admin' });
  let notice = '';
  const render = (): void => {
    el.replaceChildren(
      h('div', { class: 'admin-head' }, h('h2', {}, '관리자'), button('나가기', host.exit, { kind: 'ghost', key: 'Esc' })),
      h('div', { class: 'admin-grid' }, statsView(host.state().stats), h('div', { class: 'admin-side' }, settingsForm(), dataBox())),
    );
  };

  const settingsForm = (): HTMLElement => {
    const s = host.settings();
    const soundOn = h('input', { type: 'checkbox', checked: !s.sound.muted, 'data-testid': 'set-sound' });
    const vol = h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round(s.sound.volume * 100) });
    const volOut = h('output', {}, vol.value);
    vol.addEventListener('input', () => (volOut.textContent = vol.value));
    const pin = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: 12, value: s.pin, 'data-testid': 'set-pin' });
    const msg = h('p', { class: 'saved', role: 'status', 'data-testid': 'settings-msg' }, notice);
    notice = '';
    const save = (): void => {
      const n = host.saveSettings({
        pin: pin.value.trim(),
        sound: { muted: !soundOn.checked, volume: Number(vol.value) / 100 },
      });
      pin.value = n.pin;
      msg.textContent = '저장했어요.';
    };
    return h(
      'section',
      { class: 'box' },
      h('h3', {}, '설정'),
      h('label', { class: 'field' }, h('span', {}, '소리'), soundOn, h('small', {}, '켜기')),
      h('label', { class: 'field' }, h('span', {}, '음량'), vol, volOut),
      h('label', { class: 'field' }, h('span', {}, 'PIN'), pin),
      h('div', { class: 'row' }, button('저장', save, { kind: 'primary', testid: 'settings-save' })),
      msg,
    );
  };

  const dataBox = (): HTMLElement => {
    const e = CONFIG.economy;
    return h(
      'section',
      { class: 'box' },
      h('h3', {}, '데이터'),
      h(
        'div',
        { class: 'row wrap' },
        button('JSON 내보내기', () => exportJson(host), { testid: 'export' }),
        button(
          '통계 초기화',
          () => {
            if (!window.confirm('통계를 모두 지울까요? 되돌릴 수 없어요.')) return;
            host.resetStats();
            notice = '통계를 초기화했어요.';
            render();
          },
          { kind: 'danger', testid: 'reset-stats' },
        ),
        button(
          '기본값 복원',
          () => {
            host.saveSettings(defaultSettings());
            notice = '설정을 기본값으로 되돌렸어요.';
            render();
          },
          { testid: 'restore-defaults' },
        ),
      ),
      h(
        'p',
        { class: 'note' },
        `고정값: 시작 칩 ${e.buyIn} · 배율 ${PAID_LEVELS.map((id) => `${CONFIG.levels[id].label} ×${CONFIG.levels[id].multiplier}`).join(' · ')} · 판돈 제한 없음 · 지급은 최대 ${e.autoSettleAt}칩(되면 자동 정산). `,
        '셔플·배당·연출 시간은 src/config/defaults.json에서 바꾸고 npm run sim으로 확인한 뒤 다시 빌드합니다.',
      ),
    );
  };

  render();
  return el;
}

function statsView(st: Stats): HTMLElement {
  const pct = (hits: number, rounds: number): string => (rounds ? `${((100 * hits) / rounds).toFixed(1)}%` : '—');
  const levels = h(
    'table',
    { class: 'tbl' },
    h('thead', {}, h('tr', {}, h('th', {}, '난이도'), h('th', {}, '판 수'), h('th', {}, '맞힌 수'), h('th', {}, '적중률'))),
    h(
      'tbody',
      {},
      ...LEVEL_IDS.map((id) => {
        const lv = st.levels[id];
        return h(
          'tr',
          {},
          h('th', {}, CONFIG.levels[id].label),
          h('td', { 'data-stat': `${id}-rounds` }, lv.rounds),
          h('td', { 'data-stat': `${id}-hits` }, lv.hits),
          h('td', {}, pct(lv.hits, lv.rounds)),
        );
      }),
    ),
  );
  const kv = (label: string, value: string | number, key: string, cls = ''): HTMLElement =>
    h('div', { class: `kv ${cls}`.trim() }, h('span', {}, label), h('b', { 'data-stat': key }, value));
  const net = st.chipsIn - st.chipsOut;
  return h(
    'section',
    { class: 'box stats' },
    h('h3', {}, '통계'),
    levels,
    h('h4', {}, '부스'),
    h(
      'div',
      { class: 'kvs' },
      kv('세션 수', st.sessions, 'sessions'),
      kv('받은 칩', st.chipsIn, 'chips-in'),
      kv('돌려준 칩', st.chipsOut, 'chips-out'),
      kv('부스 순칩', signed(net), 'booth-net', 'hl'),
    ),
    h('h4', {}, '종료 사유'),
    h('div', { class: 'kvs' }, ...END_REASONS.map((r) => kv(REASON_LABEL[r], st.endReasons[r], `end-${r}`))),
    h('h4', {}, '결과 분포 (세션 순이익, 칩)'),
    histogram(st.nets),
  );
}

const HIST_BARS = 30; // with no table limit a lucky guest can win hundreds of chips: wider ranges are bucketed

function histogram(nets: Record<string, number>): HTMLElement {
  let lo = -CONFIG.economy.buyIn;
  let hi = CONFIG.economy.buyIn;
  for (const k of Object.keys(nets)) {
    lo = Math.min(lo, Number(k));
    hi = Math.max(hi, Number(k));
  }
  // Losses never go below −buyIn, so they keep one bar per chip; wins share buckets of `step` chips.
  const step = Math.max(1, Math.ceil((hi + 1) / (HIST_BARS - (-lo + 1) + 1)));
  const counts = new Map<number, number>(); // bucket start → sessions
  for (const [k, c] of Object.entries(nets)) {
    const n = Number(k);
    const start = n <= 0 ? n : 1 + Math.floor((n - 1) / step) * step;
    counts.set(start, (counts.get(start) ?? 0) + c);
  }
  const starts: number[] = [];
  for (let n = lo; n <= 0; n++) starts.push(n);
  for (let n = 1; n <= hi; n += step) starts.push(n);
  const max = Math.max(1, ...counts.values());
  const bars: HTMLElement[] = [];
  for (const n of starts) {
    const c = counts.get(n) ?? 0;
    const label = n <= 0 || step === 1 ? signed(n) : `${signed(n)}~`;
    bars.push(
      h(
        'div',
        { class: n < 0 ? 'bar neg' : 'bar' },
        h('span', { class: 'cnt' }, c || ''),
        h('span', { class: 'track' }, h('i', { style: `height:${((100 * c) / max).toFixed(1)}%` })),
        h('span', { class: 'lbl' }, label),
      ),
    );
  }
  return h('div', { class: 'hist', 'data-testid': 'hist' }, ...bars);
}

function exportJson(host: AdminHost): void {
  const now = new Date();
  const data = { app: 'yabawi', configVersion: CONFIG.version, exportedAt: now.toISOString(), settings: host.settings(), state: host.state() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
  const a = h('a', { href: url, download: `yabawi-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
