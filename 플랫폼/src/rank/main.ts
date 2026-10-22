// 순위 대시보드 (/rank on the admin PC, for a projector or a second screen): every player by 잔고, live.
import './style.css';
import type { RankReply, RankRow } from '../shared/protocol.ts';
import { chips, h, setText } from '../ui/dom.ts';
import { api } from '../ui/net.ts';

const POLL_MS = 2000;
const LIST = 20; // rows below the podium
const base = `${location.origin}/`;
const root = document.getElementById('app')!;

const clock = h('div', { class: 'rk-clock' });
const stats = h('div', { class: 'rk-stats' });
const podium = h('div', { class: 'rk-podium', 'data-testid': 'podium' });
const list = h('ol', { class: 'rk-list', start: 4, 'data-testid': 'rank-list' });
const status = h('div', { class: 'rk-status' });
root.append(
  h('header', { class: 'rk-head' }, h('h1', {}, h('span', { class: 'rk-spade' }, '♠'), ' 카지노 잔고 순위'), clock),
  stats,
  podium,
  list,
  status,
);

let prevRank = new Map<string, number>();

function tile(label: string, value: string): HTMLElement {
  return h('div', { class: 'rk-tile' }, h('div', { class: 'rk-tile-label' }, label), h('div', { class: 'rk-tile-value' }, value));
}

/** 'up' when the player climbed since the last refresh, 'new' for a new name. */
function moved(r: RankRow, i: number): string {
  const before = prevRank.get(r.name);
  return before === undefined ? 'new' : before > i ? 'up' : '';
}

function render(d: RankReply): void {
  setText(clock, new Date(d.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
  stats.replaceChildren(
    tile('참가자', `${d.players}명`),
    tile('전체 잔고 합계', chips(d.outstanding)),
    tile('지급한 실물 칩 (누적)', chips(d.settled)),
  );
  const top = d.rows.slice(0, 3);
  podium.replaceChildren(
    ...[1, 0, 2] // 2nd, 1st, 3rd from left to right
      .filter((i) => top[i])
      .map((i) => {
        const r = top[i];
        return h(
          'div',
          { class: `rk-step p${i + 1} ${moved(r, i)}` },
          h('div', { class: 'rk-medal' }, ['🥇', '🥈', '🥉'][i]),
          h('div', { class: 'rk-name' }, r.name, r.online ? h('span', { class: 'rk-dot', title: '접속 중' }) : ''),
          h('div', { class: 'rk-total' }, chips(r.total)),
          h('div', { class: 'rk-sub' }, `${r.played}판 · ${r.net >= 0 ? '+' : '−'}${Math.abs(r.net)}칩`),
          h('div', { class: 'rk-block' }, String(i + 1)),
        );
      }),
  );
  if (d.rows.length === 0) podium.replaceChildren(h('div', { class: 'rk-empty' }, '아직 참가자가 없습니다'));
  list.replaceChildren(
    ...d.rows.slice(3, 3 + LIST).map((r, k) =>
      h(
        'li',
        { class: `rk-row ${moved(r, k + 3)}` },
        h('span', { class: 'rk-pos' }, String(k + 4)),
        h('span', { class: 'rk-name' }, r.name, r.online ? h('span', { class: 'rk-dot' }) : ''),
        h('span', { class: 'rk-played' }, `${r.played}판`),
        h('span', { class: 'rk-total' }, chips(r.total)),
      ),
    ),
  );
  prevRank = new Map(d.rows.map((r, i) => [r.name, i]));
  setText(status, d.rows.length > 3 + LIST ? `외 ${d.rows.length - 3 - LIST}명` : '');
}

async function poll(): Promise<void> {
  try {
    render(await api<RankReply>(base, 'admin/rank', undefined, { retryMs: 0 }));
    status.classList.remove('off');
  } catch {
    status.classList.add('off');
    setText(status, '장부 서버에 연결할 수 없습니다 · 다시 시도하는 중');
  }
  setTimeout(() => void poll(), POLL_MS);
}
void poll();
