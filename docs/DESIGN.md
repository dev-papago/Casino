# 야바위 부스 게임 설계서

> 대상: 부스 운영자. 코드 식별자와 인터페이스는 영어로 둔다.
> 전제: 해킹이나 부정행위는 대비하지 않는다(직원 신뢰). 완전 오프라인, 노트북 1대, 한 번에 손님 1명.
> 숫자는 모두 `npm run sim`(= `node scripts/simulate.mjs`) 출력이다(4장). 기본값은 `src/config/defaults.json` 한 곳에 있고, 앱과 시뮬레이션이 같은 파일을 읽는다.

## 0. 한눈에 보기

- **컵 3개, 공 1개, 난이도 3개.** 쉬움과 보통은 **무료 연습**(칩 없음)이고, **최상만 칩을 건다.**
- **최상 규칙**
  1. 직원이 손님에게 칩 **6개**를 받는다. 1개는 참가비, 5개는 게임 칩이다.
  2. 한 판에 1칩을 건다. 맞히면 3칩을 돌려받고(+2), 틀리면 −1이다.
  3. 최대 8판. 게임 칩이 0개가 되거나 +10칩 이상 따면(클리어) 일찍 끝난다.
  4. 끝나면 남은 게임 칩을 그대로 돌려준다.
- **손님 쪽에서 보면** (적중률 1/3, 사람 대부분)
  - 한 세션을 하면 평균적으로 10칩 중 9칩이 남는다(세션 평균 −1칩). 절반 남짓(52.7%)은 본전 이상이다.
  - 가장 나쁜 결과는 −6칩(받은 6칩을 모두 잃음)이고, **약 4세션 중 1세션(22.9%)** 이 그렇게 끝난다. 가장 좋은 결과는 +11칩이다.
  - RTP로 말하면 한 판은 정확히 100%이고, 참가비를 넣은 세션 RTP는 **88.4%**다. "100%보다 약간 낮다"고 하기에는 차이가 크다. 부스 몫이 세션마다 1칩으로 정해져 있어서 RTP를 100%에 가깝게 하려면 판수를 늘려야 하고, 그러면 결과의 폭이 커진다(10판이면 RTP 90.1%, 다 잃는 세션은 그대로 22.9%).
  - 다 잃는 세션을 줄이려면 **최대 6판**으로 한다. 평균은 그대로 −1칩이고, 다 잃는 세션은 13.2%가 된다(RTP 85.4%).
- **눈이 아주 좋은 사람도 이길 수 없다.** 최상 셔플은 모든 프레임을 슬로모션으로 보는 완벽한 관찰자도 한 판 적중률 0.3438을 넘지 못하게 만들어진다. 세션 손익분기 적중률은 0.3766이다.
- **축제 하루 (300명 × 10칩 = 3,000칩):** 부스는 평균 +293칩을 남긴다. 5,000일을 돌려 상품 예산을 넘은 날은 0.02%(하루, 18칩)다.
- **이번 단순화로 뺀 것:** 버이인 입력(6개 고정), 별도 손실 한도(6칩이 곧 한도), 관리자 경고 배너, 관리자 화면의 셔플·경제 조정, 앱 안의 경제 계산, PIN 잠금과 횟수 제한, 재추첨 방지, 감사 해시, 서버와 네트워크.

## 1. 운영 흐름

1. **대기 화면:** [새 손님] [연습하기] 버튼, 그리고 느린 데모 셔플이 반복 재생된다.
2. **(선택) 무료 연습:** 쉬움이나 보통을 칩 없이 원하는 만큼 한다. 겹치기 동작을 미리 보여 주는 용도다.
3. **칩 받기:** [새 손님]을 누르면 "손님에게 칩 6개를 받으세요 (참가비 1 + 게임 칩 5)"가 나온다. 직원이 칩을 받고 [시작]을 누르면 세션이 생겨 저장된다. [취소]하면 아무 일도 없다.
4. **한 판:** [섞기 시작](Space) → 공 보여 주기 1초 → 셔플 약 4.4초 → "컵을 고르세요"(클릭 또는 1·2·3 키) → 고른 컵이 먼저 들리고 나머지도 들린다 → "+2" 또는 "−1"과 남은 칩 → [다음 판](Enter) 또는 [그만하기].
5. **정산:** 클리어, 칩 소진, 최대 판수 완료, 그만하기 중 하나가 되면 정산 화면에 "돌려드릴 칩 **N**개"(0~17)를 크게 보여 준다. 직원이 칩을 건네고 [지급 완료]를 누르면 대기 화면으로 돌아간다.
6. **줄이 길 때:** 관리자 화면에서 최대 판수를 8에서 6으로 줄인다(시간당 약 32세션에서 38세션으로).

## 2. 난이도와 셔플

| 난이도 | 칩 | 동작 수 | 1동작 시간 | 동작 구성 |
|---|---|---|---|---|
| 쉬움 | 무료 | 4~5 | 600~700ms | 교환만 |
| 보통 | 무료 | 7~9 | 350~480ms | 교환 75%, 겹치기 25% |
| **최상** | **칩** | 14~18 | 170~300ms (겹치기는 ×1.3) | 겹치기 40%, 회전 30%, 교환 30%. 판마다 이상적 관찰자 상한 ≤ `cMax` = 11/32 |

적중률과 셔플 길이는 4장에 있다.

**동작 종류.** 칸은 왼쪽부터 0·1·2다. 공은 언제나 애니메이션에서 움직이는 바로 그 컵 안에 있다.
- **교환 `swap(a,b)`:** a칸과 b칸의 컵이 하나는 앞쪽 호, 하나는 뒤쪽 호를 그리며 자리를 바꾼다. 눈으로 따라갈 수 있다.
- **회전 `rotate(dir)`:** 컵 3개가 동시에 움직인다. i칸의 컵은 (i + dir) mod 3칸으로 간다. dir 1이면 오른쪽으로 한 칸씩, 2이면 왼쪽으로 한 칸씩이고, 끝에서 반대쪽 끝으로 가는 컵은 앞쪽으로 크게 돈다.
- **겹치기 `overlap(a,b)`:** 두 컵이 한 점으로 미끄러져 와서 60ms 동안 완전히 겹친 뒤 다시 갈라진다. 실제로 자리를 바꾸는지(pass), 제자리로 돌아가는지(bounce)는 crypto 동전으로 50:50 정한다. 두 경우의 모든 프레임이 똑같아서 슬로모션으로 봐도 알 수 없다. 이웃한 두 컵은 가운데에서, 양 끝 컵은 가운데 컵 앞쪽 지점에서 만난다.

**쉬움과 보통이 무료인 이유:** 두 난이도는 눈으로 따라갈 수 있어서 1칩을 걸고 2칩만 줘도 RTP가 113~200%가 된다(4장). 칩을 걸 수 있는 난이도는 따라가도 이길 수 없는 최상 하나뿐이다.

## 3. 최상 규칙

| 항목 | 값 |
|---|---|
| 받는 칩 | 6개 고정(`economy.buyIn`). [시작] 때 참가비 1개를 빼고 게임 칩 5개로 시작한다. 나머지 칩은 손님이 가지고 있는다. |
| 판돈과 배당 | 1칩 고정, 맞히면 3칩을 돌려받는다. 모두 정수라 반올림이 없다. |
| 종료 검사 | 매 판이 끝날 때(`settleRound` 안에서) 이 순서로 본다. ① 순이익 ≥ +10이면 클리어 ② 게임 칩이 판돈보다 적으면(0개) 칩 소진 ③ 최대 판수를 다 했으면 끝. 손님은 판과 판 사이에 언제든 [그만하기]를 누를 수 있다. 칩이 0개가 되면 바로 끝나므로 칩이 음수가 될 수 없다. |
| 결과 | 돌려줄 칩 = 현재 게임 칩 = 5 − 판 수 + 3 × 맞힌 판 수 (0~17). 순이익 = 돌려줄 칩 − 6 (−6 ~ +11). |
| 설정 변경 | 세션은 시작할 때 경제 설정(관리자가 정한 최대 판수 포함)을 복사해 둔다. 관리자가 바꾸면 다음 세션부터 적용된다. |
| 새로고침이나 창 닫힘 | 바뀔 때마다 저장한다(8장). 컵을 고르기 전에 새로고침하면 그 판은 없던 일이 된다(판돈을 빼기 전이다). 같은 판을 [섞기 시작]부터 다시 한다. 고른 뒤라면 결과가 이미 반영되어 있다. 정산 화면에서 새로고침하면 정산 화면이 다시 나온다. |

## 4. 시뮬레이션 요약

- `npm run sim`은 의존성 없는 Node 스크립트다(약 6초, `--quick`, `--seed N`, `--config 파일`). 세션 수치는 모든 상태를 계산한 정확값이고, 셔플과 축제 하루는 Monte Carlo다. 사람 모델(캐주얼, 숙련, 완벽 지각)은 가정일 뿐이고, 부스가 안전하다는 결론은 이상적 관찰자 상한에 근거한다.
- 아래는 출력 맨 앞의 "요약"을 그대로 붙인 것이다. 전체 표(셔플, 적중률별 세션, 최대 판수 4~10 비교, 축제 하루, 처리량)는 `npm run sim`으로 본다.

_실행: `node scripts/simulate.mjs` (seed 20261019, config src/config/defaults.json)_

- 최상 규칙: 칩 6개를 받는다 (참가비 1 + 게임 칩 5). 한 판 1칩, 맞히면 3칩. 최대 8판. 게임 칩이 0개가 되거나 +10칩 이상 따면 끝.
- 적중률 1/3 (사람 대부분): 세션 평균 −1.00칩, 세션 RTP 88.4% (한 판 RTP 100.0%). 결과 −6 … +11, p5 / p50 / p95 = −6 / 0 / +6, 평균 7.6판.
- 같은 조건에서 6칩을 모두 잃는 세션 22.9%, 본전 이상 52.7%, +5칩 이상 8.8%, 클리어 0.7%.
- 최대 판수를 6으로 줄이면: 평균 −1.00칩, 세션 RTP 85.4%, 6칩을 모두 잃는 세션 13.2%, 결과 −6 … +11, 평균 5.9판.
- 이상적 관찰자 (모든 프레임을 슬로모션으로 보는 완벽한 관찰자): 최상 적중률 평균 0.3417 → 세션 평균 −0.81칩. 어떤 판도 cMax = 0.3438보다 높지 않다. 세션 손익분기 적중률은 0.3766.
- 매 판 0.3438로 쳐도 세션 평균 −0.76칩이고, 관리자가 고를 수 있는 최대 판수 4~10 어디서나 −0.71칩 이하다.
- 난이도별 적중률 (캐주얼 / 숙련 / 완벽 지각 / 이상적 관찰자)과 셔플 길이
  - 쉬움: 0.942 / 0.985 / 1.000 / 1.000, 셔플 2.9초
  - 보통: 0.510 / 0.551 / 0.564 / 0.601, 셔플 3.6초
  - 최상: 0.333 / 0.334 / 0.335 / 0.342, 셔플 4.4초
- 쉬움·보통에 1칩 걸고 2칩을 주면 완벽 지각만으로 RTP 200% / 113% → 부스가 진다. 그래서 무료 연습판이다.
- 축제 하루 (300명 × 10칩 = 3,000칩 발행, 5,000일): 현실적 시나리오에서 부스 평균 +293칩, 나쁜 날(p1) +137칩, 가장 나쁜 날 −18칩. 상품 예산(발행 칩)을 넘은 날 0.02%. 전원 이상적 관찰자로 3세션씩 해도 평균 +586칩, 넘은 날 0.00%. 렌더링 버그로 전원 p = 0.40이면 평균 −434칩.
- 처리량: 한 판 10.9초, 세션 1.9분 → 시간당 약 32세션 (최대 6판이면 약 38세션).

**읽는 법.** 한 판은 적중률 1/3에서 공정하다(1/3 × 3 = 1). 그래서 판수나 클리어 기준을 바꿔도 사람 대부분의 세션 평균은 언제나 −참가비(−1칩)이고, 판수를 바꾸면 결과의 폭과 RTP만 달라진다. 부스가 칩을 잃는 경우는 하나뿐이다. 겹치기의 pass와 bounce가 화면에서 구분되는 렌더링 버그가 생겨 적중률이 0.40까지 오르는 경우다. 이것은 5장의 렌더링 규칙과 9장의 `cupPoses` 테스트(①, ⑤)로 막는다.

## 5. 공정성

1. **결과는 셔플 계획(Plan)에서만 나온다.** Plan은 시작 칸과 동작 목록(겹치기마다 `pass` 동전 포함)이다. 셔플 전에 만들고, 손님의 선택과는 무관하다. 정답 칸(로직)은 `applyMove`를 접어서, 컵 위치(애니메이션)는 같은 Plan으로 `cupPoses`에서 계산한다. 렌더러가 정말 정답 칸에서 끝나는지는 9장 테스트 ①이 확인한다. 정답을 먼저 정하고 애니메이션을 끼워 맞추는 코드나, 공을 몰래 옮기는 코드는 없다.
2. **공은 셔플 중에는 DOM에 없다.** 공개할 때 공이 든 컵(cup `start`) 아래에 그린다.
3. **겹치기 렌더링 규칙:** 컵 3개는 같은 그림이고 번호나 개별 스타일이 없다. 모든 컵은 rAF 시계 하나로 움직인다. `z-index`는 위치(y, 다음 x)로만 정한다. pass와 bounce는 시간, easing, 소리가 같다. 셔플 중에는 hover와 focus 효과, 입력을 끈다.
4. **상한 규칙:** 최상 Plan은 이상적 관찰자의 사후확률 최댓값이 `cMax`(11/32) 이하일 때만 채택하고, 아니면 동작을 다시 뽑는다. 사후확률은 교환과 회전에서는 자리만 바뀌고, 겹치기에서는 두 칸의 평균이 된다. 채택 여부는 보이는 정보(시작 칸, 동작 종류와 순서)만 보고 정하며, 동전은 채택된 뒤에 뽑는다. 그래서 최종 위치가 치우치지 않는다.
5. **난수:** `crypto.getRandomValues`를 쓴다. 균등 정수는 rejection sampling으로 뽑는다(`limit = 2^32 − (2^32 % n)`, 값 ≥ limit이면 다시). `Math.random`은 쓰지 않는다.
6. **고른 뒤에는 바꿀 수 없다.** 공개 순서는 고른 컵 먼저, 그다음 나머지다. 규칙 안내에는 "겹친 컵은 지나갈 수도, 튕겨 돌아갈 수도 있어요 (반반)"라고 적는다.

## 6. 관리자 화면

- **들어가기:** 화면 위 제목을 5번 연달아 클릭하면 PIN 입력이 나온다(기본 `0000`). 단순 비교이고 잠금은 없다. 키보드 단축키는 두지 않는다(`Ctrl+Shift+A`는 Chrome과 Edge의 탭 검색과 겹친다).
- **통계** (숫자만 보여 주고 경고는 없다)
  - 난이도별: 판 수, 맞힌 수, 적중률.
  - 부스: 세션 수, 받은 칩(Σ 6), 돌려준 칩, **부스 순칩(받은 칩 − 돌려준 칩)**, 종료 사유(클리어 / 칩 소진 / 최대 판수 / 그만하기), 결과 분포(−6 … +11).
  - 하루 마감에 "부스 순칩"을 실제 칩 통과 맞춰 본다.
- **설정:** 최대 판수(기본 8, 4~10, 범위 밖 값은 저장할 때 범위 안으로 맞춤), 소리 켜기와 음량, PIN. 최대 판수 4~10은 어느 값이든 완벽한 관찰자도 평균적으로 진다(4장).
- **데이터:** JSON 내보내기(백업), 통계 초기화(확인 1회), 기본값 복원.
- **그 밖의 값**(셔플, 배당, 참가비, 받는 칩, 연출 시간)은 화면에서 바꾸지 않는다. `src/config/defaults.json`을 고치고 `npm run sim`으로 확인한 뒤 `npm run build`로 다시 만든다.

## 7. 소리와 연출

- **효과음:** Web Audio로 합성하고 오디오 파일은 쓰지 않는다. 버튼 클릭, 컵 들기와 내려놓기, 동작마다 "슥", 겹칠 때 "탁", 맞힘·틀림·클리어, 정산 때 칩 세는 틱이 있다. 교환, 회전, 겹치기, pass, bounce는 모두 같은 소리를 낸다. 첫 클릭이나 키 입력 때 `AudioContext`를 만들거나 resume한다. 음소거는 `M` 키와 화면 버튼으로 한다.
- **연출:** 공 보여 주기(컵을 들고 공을 보여 준 뒤 내려놓기) → 셔플 → 고르기(셔플이 끝난 뒤에만 hover 강조, 1·2·3 안내) → 공개(이기면 "+2" 칩이 칩 더미로 날아가고, 지면 컵이 살짝 흔들린다). 상태 표시줄에는 남은 칩, 판 수(●●●○○○○○), "클리어까지 +N"이 나온다. 끝나면 종료 배너(최대 판수 완료 / 클리어! / 칩을 다 썼어요)에 이어 정산 화면에 큰 숫자를 보여 준다.

## 8. 아키텍처

**Stack:** Vite + TypeScript (vanilla DOM, CSS, rAF), Vitest, Playwright. Runtime dependencies: none.

```
index.html
vite.config.ts          base './', plugins: [viteSingleFile()]
src/
  main.ts               boot: load settings + state, mount UI
  config/defaults.json  all defaults (scripts/simulate.mjs reads the same file)
  config.ts             types; loadSettings()/saveSettings() (merge over defaults, clamp maxRounds)
  rng.ts                Rng interface, cryptoRng (rejection sampling), seededRng (tests only)
  game/shuffle.ts       SLOT_X, generatePlan, belief, applyMove, cupPoses   (pure)
  game/session.ts       startSession, endReason, settleRound, quit         (pure)
  storage.ts            localStorage get/set for settings and state (try/catch, defaults on failure)
  audio.ts              Web Audio SFX
  ui/app.ts             screens: idle, practice, confirm, game, settlement, admin
  ui/cups.ts            rAF renderer that only draws cupPoses(plan, t)
  ui/style.css
tests/unit/{rng,shuffle,session}.test.ts
tests/e2e/{session,refresh,offline-file}.spec.ts
scripts/simulate.mjs
```

**Config** (`defaults.json` is the schema; only `Settings` change at runtime)
```ts
import defaults from './config/defaults.json';
export type GameConfig = typeof defaults;                 // ranges are inclusive [min, max]; mix weights are relative
export type LevelId = keyof GameConfig['levels'];         // 'easy' | 'normal' | 'hardest'
export type EconomyConfig = GameConfig['economy'];        // paid level (hardest) only
export interface Settings { maxRounds: number; pin: string; sound: GameConfig['sound'] } // admin screen
```

**Shuffle plan: one source for logic and animation**
```ts
export type Slot = 0 | 1 | 2;    // position, left to right
export type CupId = 0 | 1 | 2;   // physical cup; cup i starts at slot i; the ball is in cup `start`
export type Move =
  | { kind: 'swap'; a: Slot; b: Slot; durMs: number }                   // cups at slots a and b trade slots
  | { kind: 'rotate'; dir: 1 | 2; durMs: number }                       // cup at slot i moves to slot (i + dir) % 3
  | { kind: 'overlap'; a: Slot; b: Slot; pass: boolean; durMs: number }; // pass: same as swap; else both return
export interface Plan {
  level: LevelId; start: Slot; moves: Move[];
  final: Slot;      // slot of cup `start` after folding applyMove over every move
  ceiling: number;  // max of belief(start, moves)
  totalMs: number;  // sum of durMs; move k runs from t_k to t_{k+1}
}
export interface Rng { int(n: number): number; float(): number; coin(): boolean }
export const SLOT_X: readonly [number, number, number];          // x of each slot when cups are at rest
export function generatePlan(level: LevelId, cfg: GameConfig, rng: Rng): Plan;
export function belief(start: Slot, moves: Move[]): [number, number, number];
export function applyMove(cupAt: CupId[], m: Move): CupId[];     // cupAt[slot] = cup; the only permutation rule
export interface Pose { cup: CupId; x: number; y: number; z: number } // z derived from (y, x) only
export function cupPoses(plan: Plan, tMs: number, timing: GameConfig['timing']): Pose[];
```
- `generatePlan` draws `start`, then the moves, then computes `belief`. If `cMax != null` and the max exceeds `cMax`, it redraws the moves. After acceptance it draws the `pass` coins and computes `final`.
- The renderer only draws `cupPoses(plan, t)`. At every move boundary each cup is at rest at `SLOT_X` of its slot. The player picks a slot (click zone over `SLOT_X[i]`, or key 1·2·3). The round is won if `pick === plan.final`, and the reveal draws the ball under cup `start`.

**Game state machine** (UI phases live in memory; session and stats are saved)
```
idle ─새 손님→ confirm ─시작: startSession + save→ ready          confirm ─취소→ idle
ready ─섞기 시작→ showBall → shuffling → picking
picking ─pick: settleRound (ended도 여기서 정함) + 최상 통계 + save→ reveal → result
result ─다음 판 (ended = null)→ ready          result ─(ended ≠ null)→ settlement
ready | result ─그만하기: quit + save→ settlement
settlement ─지급 완료: 세션 통계 반영, session = null, save→ idle
idle ─연습하기→ practice (같은 단계, 칩 없음, 판마다 통계 + save) → idle
```
```ts
export type EndReason = 'clear' | 'broke' | 'rounds' | 'quit';
export interface RoundRecord { pick: Slot; ball: Slot; win: boolean }
export interface Session {
  id: string; startedAt: number;
  econ: EconomyConfig;            // snapshot at start, maxRounds taken from Settings
  stack: number;                  // game chips = chips to hand back right now
  rounds: RoundRecord[];
  ended: EndReason | null;
}
export function startSession(econ: EconomyConfig, now: number): Session;  // stack = buyIn - fee
export function endReason(s: Session): EndReason | null;                  // clear → broke → rounds (section 3)
export function settleRound(s: Session, pick: Slot, plan: Plan): Session; // -stake, +returnOnWin on win, ended = endReason(next)
export function quit(s: Session): Session;                                // ended = 'quit'
```

**Persistence** (`storage.ts`)
- Two keys. `yabawi:v1:settings` holds `Settings`. `yabawi:v1:state` holds `{ session: Session | null; stats: Stats }`.
- One rule: every change to the session or stats writes the whole state in one `setItem`, so the session and stats never disagree. The writes happen at start, at pick (before the reveal), at quit, at 지급 완료, and after each practice round.
- On boot: no session → `idle`; `session.ended` set → `settlement`; otherwise → `ready`.
```ts
export interface Stats {
  levels: Record<LevelId, { rounds: number; hits: number }>;  // updated every round
  sessions: number; chipsIn: number; chipsOut: number;        // updated at 지급 완료
  endReasons: Record<EndReason, number>;
  nets: Record<string, number>;                               // histogram: session net -> count
}
```

**Build and offline use**
- `npm run build` (`vite build` + `vite-plugin-singlefile`) makes one file, `dist/index.html`, with JS and CSS inlined; double-click opens it in Chrome or Edge over `file://`. `npm run dev` runs the dev server.
- No external assets: system fonts (`"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`), inline SVG and CSS, synthesized sound. localStorage persists on `file://` in Chromium; use the same browser and profile every day.
- Layout: landscape 1366×768 to 1920×1080, mouse and keyboard first (1·2·3, Space, Enter, M); pointer events, so touch works but is not a target. `?speed=20` speeds up animations for e2e only.
- Scripts: `dev`, `build`, `test` (vitest run), `e2e` (playwright test), `sim`. Dev deps: `vite`, `typescript`, `vite-plugin-singlefile`, `vitest`, `@playwright/test`.

## 9. 테스트 계획

**Vitest** (모두 seeded `Rng`라 결과가 재현된다)
- `rng.test.ts`: `int(n)`이 항상 `[0, n)` 안에 있다(n = 1, 2, 3, 7). n = 3으로 6만 번 뽑으면 χ² < 9.21. stub 소스가 `0xFFFFFFFF`를 주면 n = 3에서 거절하고 다시 뽑는다.
- `shuffle.test.ts`
  - ① **렌더러 = 로직.** 모든 난이도에서 1만 Plan씩 만든다. 각 동작 경계 t_k에서 `cupPoses(plan, t_k)`의 모든 컵은 y = 0이고, x = `SLOT_X[applyMove를 k번 접은 뒤 그 컵의 칸]`이다. t = `totalMs`에서 cup `start`의 x = `SLOT_X[plan.final]`이다.
  - ② 최상은 모든 Plan에서 `ceiling ≤ cMax`.
  - ③ 최상의 최종 칸이 시작 칸과 무관하게 균등하다(χ² < 16.81).
  - ④ 이상적 관찰자 적중률이 평균 `ceiling` ± 4 SE 안에 든다(5만 Plan). `belief`가 `applyMove`와 동전에 맞는지 확인한다.
  - ⑤ 겹치기 하나에서 `pass = true`와 `false`의 `cupPoses`를 시각 50곳에서 비교한다. cup id를 빼고 정렬한 (x, y, z) 목록이 같아야 한다.
- `session.test.ts`: 시작할 때 참가비를 빼서 칩 5개. 이기면 +2, 지면 −1. 최대 판수 4~10 각각에서 모든 승패 순서를 돌려 클리어(+10), 칩 소진, 최대 판수에서 끝나고 `ended`가 `settleRound` 안에서 정해지며 칩이 음수가 되지 않는다. `quit`은 `ended = 'quit'`. JSON으로 저장했다가 복원해도 같다.

**Playwright** (`launchOptions.executablePath: '/opt/pw-browsers/chromium'`, `playwright install`은 실행하지 않음, `?speed=20` 사용)
1. `session.spec.ts` (dev 서버): 새 손님 → 시작 → "게임 칩 5개" → `1` 키로 끝날 때까지 진행. 정산 화면 숫자 = 마지막 칩 표시이고 0~17 사이다. [지급 완료] 뒤 제목 5번 클릭, `0000` → 통계에 세션 1, 최상 판 수 ≥ 1.
2. `refresh.spec.ts`: 2판을 하고 3판째 셔플 도중 `page.reload()` → 칩과 판 수(2)가 그대로이고 [섞기 시작]부터 다시 할 수 있다. [그만하기] → 정산 화면에서 새로고침해도 같은 숫자다.
3. `offline-file.spec.ts`: `npm run build` 뒤 `dist/`에 `index.html` 하나만 있다. `file://…/dist/index.html`을 열었을 때 `file:`, `data:`, `blob:` 말고는 요청이 0건이다(`page.on('request')`로 모으고 http(s)는 `route.abort()`). 쉬움 연습 1판을 끝까지 하고 새로고침해도 통계가 남아 있다.

## 10. 기본값과 가정 (모두 바꿀 수 있음)

| 항목 | 기본값 | 바꾸는 곳 |
|---|---|---|
| 방문자 / 1인 지급 칩 | 300명 / 10칩 → 3,000칩 발행 | `booth` (시뮬레이션용) |
| 칩 가치와 상품 예산 | 1칩 = 상품 원가 200원 → 3,000 × 200 = **60만 원**. 발행 칩만큼 상품을 준비하면 평균 약 10%가 남는다(4장 축제 하루) | `booth.chipValueKrw` |
| 상품표 | 칩 수에 비례하게 정한다. 큰 상품의 칩당 가치가 더 좋으면 안 된다(부채가 "칩 × 칩 가치"를 넘는다) | 운영 |
| 게임 값 | 최상 경제는 3장, 셔플은 2장. 연출 시간은 공 보여 주기 1.0s, 공개 2.0s, 결과 1.0s, 겹침 60ms, 겹치기 ×1.3 | `economy`, `levels`, `timing` |
| PIN, 소리, 최대 판수 | `0000`, 켬(음량 0.7), 8 | 관리자 화면 |
| 시뮬레이션 가정 | 80%가 플레이, 25%가 다시 줄 섬(최대 3세션, 칩 6개 이상일 때). 최상 추적 실수 확률(교환 / 회전) 캐주얼 0.10 / 0.20, 숙련 0.03 / 0.06, 완벽 지각 0, 겹치기에서는 모두 반반. 고르는 시간 2.5초, 접수와 정산 30초 | `scripts/simulate.mjs`의 `ASSUME` |
| 운영 가정 | 노트북 1대, 손님 1명씩, 직원 신뢰, 인터넷 없음, Chrome 또는 Edge | — |

## 검토 메모

- 이번 검토 9건은 모두 타당해서 반영했다(기각 없음). 제안과 다르게 고친 곳은 두 군데다.
- 버이인은 7개가 아니라 6개로 고정했다. 칩이 0개가 되면 끝나는 규칙 하나로 예전 손실 한도 6과 같은 분포(−6 … +11)가 나오므로, 손실 한도 규칙과 음수 칩 문제가 함께 사라진다.
- 관리자 진입은 다른 단축키로 바꾸지 않고 제목 5번 클릭 하나만 남겼다.
