// Overlay cards for 칩 받기 (confirm) and 정산 (settlement). Pure view builders; app.ts owns the flow.
import { CONFIG, PAID_LEVELS, type EconomyConfig } from '../config';
import { sessionNet, type EndReason, type Session } from '../game/session';
import { CHIP_SVG } from './art';
import { button, fromHtml, h, signed } from './dom';

export const END_TEXT: Record<EndReason, string> = { broke: '칩을 다 썼어요', quit: '정산', cap: `${CONFIG.economy.autoSettleAt}칩 달성! 자동 정산` };

export const chipIcon = (): Element => fromHtml(CHIP_SVG);

export function confirmCard(e: EconomyConfig, onStart: () => void, onCancel: () => void): HTMLElement {
  const chips = Array.from({ length: e.buyIn }, () => h('div', { class: 'chip-slot' }, chipIcon(), h('span', {}, '게임 칩')));
  const rates = PAID_LEVELS.map((id) => `${CONFIG.levels[id].label} ×${CONFIG.levels[id].multiplier}`).join(' · ');
  return h(
    'div',
    { class: 'card confirm', 'data-testid': 'confirm' },
    h('h2', {}, '새 손님'),
    h('p', { class: 'lead' }, `손님에게 칩 ${e.buyIn}개를 받으세요`),
    h('div', { class: 'chip-row' }, ...chips),
    h('p', { class: 'note' }, `배율 ${rates} · 맞히면 판돈 × 배율을 더 받고 틀리면 판돈을 잃어요 · 판돈 제한 없음(가진 칩까지) · 최대 ${e.autoSettleAt}칩, 되면 자동 정산`),
    h(
      'div',
      { class: 'row' },
      button('시작', onStart, { kind: 'primary', testid: 'confirm-start' }),
      button('취소', onCancel, { kind: 'ghost', key: 'Esc', testid: 'confirm-cancel' }),
    ),
  );
}

/** "돌려드릴 칩 N개" in big type; the chips pop in one by one (CSS delay by --i) to match the tick sounds. */
export function settlementCard(s: Session & { ended: EndReason }, onPaid: () => void, maxPile: number): HTMLElement {
  const wins = s.rounds.filter((r) => r.win).length;
  const pile = Array.from({ length: Math.min(s.stack, maxPile) }, (_, i) => {
    const c = chipIcon() as SVGElement;
    c.style.setProperty('--i', String(i));
    return c;
  });
  return h(
    'div',
    { class: `card settle reason-${s.ended}`, 'data-testid': 'settlement' },
    h('div', { class: 'reason', 'data-testid': 'end-reason' }, END_TEXT[s.ended]),
    h('div', { class: 'pay-label' }, '돌려드릴 칩'),
    h('div', { class: 'pay' }, h('span', { class: 'pay-n', 'data-testid': 'payout' }, s.stack), h('span', { class: 'pay-unit' }, '개')),
    h('div', { class: 'pay-chips' }, ...pile),
    h('p', { class: 'note' }, `시작 칩 ${s.econ.buyIn}개 · ${s.rounds.length}판 중 ${wins}판 맞힘 · 손님 결과 ${signed(sessionNet(s))}칩`),
    h('div', { class: 'row' }, button('지급 완료', onPaid, { kind: 'primary', testid: 'paid-out' })),
  );
}

/** Delay of chip i's pop-in, in real-time ms (CSS uses the same numbers). */
export const chipDelayMs = (i: number): number => 450 + i * 110;
