# 야바위 부스 게임 설계서

> 대상: 부스 운영자. 코드 식별자와 인터페이스는 영어로 둔다.
> 전제: 해킹이나 부정행위는 대비하지 않는다(직원 신뢰). 완전 오프라인, 노트북 1대, 한 번에 손님 1명.
> 숫자는 모두 `npm run sim`(= `node scripts/simulate.mjs`) 출력이다(4장). 기본값은 `src/config/defaults.json` 한 곳에 있고, 앱과 시뮬레이션이 같은 파일을 읽는다.

## 0. 한눈에 보기 (규칙 v3: 배당)

- **컵 3개, 공 1개, 난이도 4개.** 쉬움은 무료 연습이고, **중간 ×1 · 높음 ×1.2 · 최상 ×1.8**은 칩을 건다. 배율은 **배당**이다: 맞히면 판돈에 더해 `판돈 × 배율`을 받는다.
- **규칙**
  1. 직원이 손님에게 칩 **5개**를 받고 세션을 시작한다.
  2. 판마다 난이도와 판돈을 고른다. **판돈 상한은 없다**(모든 난이도 같음).
  3. 맞히면 `floor(판돈 × 배율)`만큼 얻고, 틀리면 **판돈만** 잃는다. 예: 최상 판돈 5 → +9 / −5, 높음 판돈 5 → +6 / −5, 중간 판돈 5 → +5 / −5.
  4. 판돈은 1칩부터 가진 칩 전부까지, 모든 난이도 같다(칩이 음수가 되지 않는다).
  5. **[정산하기]를 누를 때까지 계속**한다. 칩이 0개가 되면, 또는 **칩이 50개가 되면**(`economy.autoSettleAt`) 그 판에서 바로 정산 화면으로 간다(자동 정산). **지급은 50칩을 넘지 않는다:** 맞혔을 때 50칩을 넘게 되는 판돈은 고를 수 없다(예: 49칩이면 최상 판돈은 1까지).
- **부스가 안전한 이유:** 한 판 기대값은 약 `판돈 × (p × (1 + 배율) − 1)`이다. 적중률 p가 본전 적중률 `1 / (1 + 배율)`(중간 0.5 · 높음 0.455 · 최상 0.357)보다 낮으면 부스에 유리하다. 숙련 손님의 적중률은 0.44 · 0.39 · 0.34라 모두 그 아래다. 완벽한 관찰자도 중간과 최상은 넘지 못하고, 높음만 이론상 +2%다(4장 B).
- **지급 상한 50칩:** 판돈 제한이 없어서 칩을 전부 거는 손님이 연속으로 맞히면 칩이 빠르게 불어난다. 한 손님에게 주는 칩은 50개를 넘지 않는다. 이긴 칩을 잘라 내지 않고 판돈을 막는 이유는, 손님이 걸고도 못 받는 칩이 생기지 않게 하기 위해서다. 숫자와 운영 권장 사항은 [BALANCE.md](BALANCE.md)에 정리했다.

## 1. 운영 흐름

1. **대기 화면:** [새 손님] [연습하기] 버튼, 그리고 느린 데모 셔플이 반복 재생된다.
2. **(선택) 무료 연습:** 쉬움이나 보통을 칩 없이 원하는 만큼 한다. 겹치기 동작을 미리 보여 주는 용도다.
3. **칩 받기:** [새 손님]을 누르면 "손님에게 칩 5개를 받으세요"가 나온다. 직원이 칩을 받고 [시작]을 누르면 세션이 생겨 저장된다. [취소]하면 아무 일도 없다.
4. **한 판:** 난이도(←→)와 판돈(↑↓ ±1, PageUp/PageDown ±10, Home 1, End 또는 [최대] 버튼) 고르기 → [섞기 시작](Space) → 공 보여 주기 1초 → 셔플 → "컵을 고르세요"(클릭 또는 1·2·3 키) → 고른 컵이 먼저 들리고 나머지도 들린다 → "+N" 또는 "−N"과 남은 칩 → [다음 판](Enter) 또는 [정산하기].
5. **정산:** [정산하기]를 누르거나, 칩이 0개가 되거나, 칩이 50개가 되면("50칩 달성! 자동 정산" 배너) 정산 화면에 "돌려드릴 칩 **N**개"를 크게 보여 준다. 직원이 칩을 건네고 [지급 완료]를 누르면 대기 화면으로 돌아간다.

## 2. 난이도와 셔플

| 난이도 | 배율 | 동작 수 | 1동작 시간 | 동작 구성 |
|---|---|---|---|---|
| 쉬움 | 무료 | 4~5 | 600~700ms | 교환만 |
| 중간 | ×1 | 7~9 | 350~480ms | 교환 60%, 겹치기 40% |
| 높음 | ×1.2 | 10~12 | 260~380ms | 교환 45%, 회전 20%, 겹치기 35% |
| **최상** | **×1.8** | 14~18 | 170~300ms (겹치기는 ×1.3) | 겹치기 40%, 회전 30%, 교환 30%. 판마다 이상적 관찰자 상한 ≤ `cMax` = 11/32 |

적중률과 셔플 길이는 4장에 있다.

**동작 종류.** 칸은 왼쪽부터 0·1·2다. 공은 언제나 애니메이션에서 움직이는 바로 그 컵 안에 있다.
- **교환 `swap(a,b)`:** a칸과 b칸의 컵이 하나는 앞쪽 호, 하나는 뒤쪽 호를 그리며 자리를 바꾼다. 눈으로 따라갈 수 있다.
- **회전 `rotate(dir)`:** 컵 3개가 동시에 움직인다. i칸의 컵은 (i + dir) mod 3칸으로 간다. dir 1이면 오른쪽으로 한 칸씩, 2이면 왼쪽으로 한 칸씩이고, 끝에서 반대쪽 끝으로 가는 컵은 앞쪽으로 크게 돈다.
- **겹치기 `overlap(a,b)`:** 두 컵이 한 점으로 미끄러져 와서 60ms 동안 완전히 겹친 뒤 다시 갈라진다. 실제로 자리를 바꾸는지(pass), 제자리로 돌아가는지(bounce)는 crypto 동전으로 50:50 정한다. 두 경우의 모든 프레임이 똑같아서 슬로모션으로 봐도 알 수 없다. 이웃한 두 컵은 가운데에서, 양 끝 컵은 가운데 컵 앞쪽 지점에서 만난다.

**쉬움이 무료인 이유:** 쉬움은 눈으로 거의 100% 따라갈 수 있어서 칩을 걸면 부스가 진다. 칩을 거는 세 난이도는 겹치기를 섞어 적중률을 낮추고, 어려울수록 배당을 크게 했다. 배당은 숙련 손님의 적중률이 본전 적중률 `1 / (1 + 배율)`보다 낮도록 정했다(4장 B).

## 3. 칩 규칙

| 항목 | 값 |
|---|---|
| 시작 칩 | 5개 (`economy.buyIn`) |
| 배율 (배당) | 중간 1 · 높음 1.2 · 최상 1.8 (`levels.*.multiplier`) |
| 판돈 | 1 ~ 가진 칩 전부. 단, 맞혔을 때 칩이 50개를 넘게 되는 판돈은 고를 수 없다(`maxBetFor`). 난이도와 상관없다. 화면에 "최대 N (50칩 한도)"로 표시. |
| 결과 | 맞히면 +`floor(판돈 × 배율)`, 틀리면 −판돈. 정수만 쓰고 소수점은 버린다(작은 판돈에서는 부스에 조금 유리: 최상 판돈 1 → +1). |
| 끝 | [정산하기]를 누를 때(`quit`)까지 계속. 칩이 0개가 되면 `broke`, 50개가 되면 `cap`(자동 정산)으로 그 판에서 끝난다. 지급은 최대 50칩. |
| 새로고침 | 컵을 고르기 전에 새로고침하면 그 판은 없던 일이 된다. 고른 뒤라면 결과가 이미 반영되어 있다. 정산 화면에서 새로고침하면 정산 화면이 다시 나온다. |

## 4. 시뮬레이션 (`npm run sim`)

난이도별 적중률(A), 한 판 기대값(B), 세션 결과(C), 부스의 하루(D)를 출력한다. 아래는 기본값 그대로의 출력이다.

#### A. 난이도별 셔플과 적중률 (seed 20261019, 난이도마다 200,000판)

| 난이도 | 배율 | 동작 수 | 겹치기 / 회전 | 셔플 시간 | 이상적 관찰자 (평균 / 최대) | 완벽 지각 | 숙련 | 캐주얼 | 무작위 |
|---|---|---|---|---|---|---|---|---|---|
| 쉬움 | 무료 | 4.5 | 0.0 / 0.0 | 2.9s | 1.0000 / 1.0000 | 1.0000 | 0.9850 | 0.9420 | 0.3357 |
| 중간 | ×1 | 8.0 | 3.2 / 0.0 | 3.7s | 0.4965 / 1.0000 | 0.4476 | 0.4401 | 0.4223 | 0.3318 |
| 높음 | ×1.2 | 11.0 | 3.8 / 2.2 | 3.9s | 0.4632 / 1.0000 | 0.4149 | 0.3942 | 0.3697 | 0.3318 |
| 최상 | ×1.8 | 16.3 | 7.8 / 4.2 | 4.4s | 0.3417 / 0.3438 | 0.3357 | 0.3347 | 0.3347 | 0.3327 |

이상적 관찰자 = 매 판 사후확률이 가장 큰 칸을 고르는 완벽한 관찰자. 적중률이 0.5보다 낮으면 그 난이도는 부스에 유리하다.

#### B. 한 판 기대값 (맞히면 +floor(판돈 × 배율), 틀리면 −판돈; 걸린 칩 1개당, 판돈 10칩 기준)

| 난이도 | 배율 | 판돈 1 → + / − | 판돈 5 → + / − | 판돈 10 → + / − | 본전 적중률 | 무작위 1/3 | 캐주얼 | 숙련 | 완벽 지각 | 이상적 관찰자 (평균 / 최대) |
|---|---|---|---|---|---|---|---|---|---|---|
| 중간 | ×1 | +1 / −1 | +5 / −5 | +10 / −10 | 0.5000 | −0.333 | −0.155 | −0.120 | −0.105 | −0.007 / +1.000 |
| 높음 | ×1.2 | +1 / −1 | +6 / −5 | +12 / −10 | 0.4545 | −0.267 | −0.187 | −0.133 | −0.087 | +0.019 / +1.200 |
| 최상 | ×1.8 | +1 / −1 | +9 / −5 | +18 / −10 | 0.3571 | −0.067 | −0.063 | −0.063 | −0.060 | −0.043 / −0.037 |

본전 적중률 = 1 / (1 + 배율). 적중률이 이보다 낮으면 그 난이도는 부스에 유리하다. 판돈이 작으면 소수점을 버려서 부스에 조금 더 유리하다.

#### C. 세션 (시작 5칩, 지급 최대 50칩 · 되면 자동 정산, 숙련 적중률, 200,000세션)

| 난이도 | 손님 | 적중률 | 평균 판 수 | 손님 평균 | 이익 | 2배 이상 | 10배 이상 | 자동 정산 | p99 | 최대 | 칩 0개 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 중간 | 1칩씩 10판 | 0.440 | 9.5 | −1.14 | 24.1% | 2.3% | 0.00% | 0.00% | +6 | +10 | 18.9% |
| 중간 | 절반씩 10판 | 0.440 | 8.3 | −2.07 | 11.7% | 7.5% | 1.21% | 1.21% | +45 | +45 | 48.8% |
| 중간 | 올인 10판 | 0.440 | 1.8 | −1.88 | 6.3% | 6.3% | 6.21% | 6.21% | +45 | +45 | 93.7% |
| 중간 | 올인, 2배(10칩)면 정산 | 0.440 | 1.0 | −0.60 | 44.0% | 44.0% | 0.00% | 0.00% | +5 | +5 | 56.0% |
| 중간 | 올인, 자동 정산까지 | 0.440 | 1.8 | −1.85 | 6.3% | 6.3% | 6.29% | 6.29% | +45 | +45 | 93.7% |
| 높음 | 1칩씩 10판 | 0.394 | 9.2 | −1.94 | 15.7% | 1.1% | 0.00% | 0.00% | +6 | +10 | 27.0% |
| 높음 | 절반씩 10판 | 0.394 | 7.9 | −2.95 | 7.1% | 4.6% | 0.84% | 0.84% | +34 | +45 | 59.7% |
| 높음 | 올인 10판 | 0.394 | 1.7 | −1.93 | 6.2% | 6.2% | 6.14% | 6.14% | +45 | +45 | 93.8% |
| 높음 | 올인, 2배(10칩)면 정산 | 0.394 | 1.0 | −0.65 | 39.5% | 39.5% | 0.00% | 0.00% | +6 | +6 | 60.5% |
| 높음 | 올인, 자동 정산까지 | 0.394 | 1.7 | −1.85 | 6.3% | 6.3% | 6.30% | 6.30% | +45 | +45 | 93.7% |
| 최상 | 1칩씩 10판 | 0.335 | 8.8 | −2.90 | 7.8% | 0.3% | 0.00% | 0.00% | +4 | +10 | 40.4% |
| 최상 | 절반씩 10판 | 0.335 | 7.2 | −2.50 | 7.7% | 5.8% | 2.55% | 2.55% | +45 | +45 | 70.0% |
| 최상 | 올인 10판 | 0.335 | 1.9 | −0.93 | 8.5% | 8.5% | 6.57% | 6.57% | +45 | +45 | 91.5% |
| 최상 | 올인, 2배(10칩)면 정산 | 0.335 | 1.0 | −0.31 | 33.5% | 33.5% | 0.00% | 0.00% | +9 | +9 | 66.5% |
| 최상 | 올인, 자동 정산까지 | 0.335 | 2.0 | −0.98 | 8.0% | 8.0% | 8.04% | 8.04% | +45 | +45 | 92.0% |

2배·10배 = 정산할 때 칩이 시작 칩의 2·10배 이상. 자동 정산 = 칩이 50개가 되어 그 판에서 바로 끝남.

#### D. 하루 운영 (손님 300명이 모두 같은 방식, 숙련 적중률, 10,000일)

| 난이도 | 손님 | 부스 순칩 평균 | 부스 순칩 p5 | 최악의 날 | 부스 적자인 날 | 자동 정산 손님 (하루 평균) | 한 손님 최대 지급 |
|---|---|---|---|---|---|---|---|
| 중간 | 1칩씩 10판 | +341 | +257 | +150 | 0.0% | 0.00 | 15 |
| 중간 | 절반씩 10판 | +618 | +409 | −76 | 0.0% | 3.63 | 50 |
| 중간 | 올인 10판 | +562 | +200 | −350 | 0.4% | 18.68 | 50 |
| 중간 | 올인, 2배(10칩)면 정산 | +179 | +40 | −120 | 1.7% | 0.00 | 10 |
| 중간 | 올인, 자동 정산까지 | +556 | +200 | −300 | 0.4% | 18.87 | 50 |
| 높음 | 1칩씩 10판 | +583 | +503 | +406 | 0.0% | 0.00 | 15 |
| 높음 | 절반씩 10판 | +886 | +709 | +469 | 0.0% | 2.52 | 50 |
| 높음 | 올인 10판 | +576 | +200 | −200 | 0.3% | 18.46 | 50 |
| 높음 | 올인, 2배(10칩)면 정산 | +197 | +48 | −205 | 1.7% | 0.00 | 11 |
| 높음 | 올인, 자동 정산까지 | +556 | +200 | −250 | 0.4% | 18.89 | 50 |
| 최상 | 1칩씩 10판 | +870 | +800 | +708 | 0.0% | 0.00 | 15 |
| 최상 | 절반씩 10판 | +753 | +495 | −67 | 0.0% | 7.63 | 50 |
| 최상 | 올인 10판 | +280 | −117 | −669 | 12.0% | 19.73 | 50 |
| 최상 | 올인, 2배(10칩)면 정산 | +93 | −96 | −362 | 19.9% | 0.00 | 14 |
| 최상 | 올인, 자동 정산까지 | +297 | −100 | −650 | 8.8% | 24.07 | 50 |

부스 순칩 = 그날 받은 칩 − 돌려준 칩. 한 손님 최대 지급 = 정산 때 돌려준 칩(시작 칩 포함)의 최댓값.

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
  - 부스: 세션 수, 받은 칩(Σ 6), 돌려준 칩, **부스 순칩(받은 칩 − 돌려준 칩)**, 종료 사유(칩 소진 / 정산 / 자동 정산), 결과 분포(진 쪽은 1칩마다, 이긴 쪽은 큰 당첨이 있으면 칸을 묶어 30칸 안팎).
  - 하루 마감에 "부스 순칩"을 실제 칩 통과 맞춰 본다.
- **설정:** 소리 켜기와 음량, PIN. (최대 판돈 설정은 없앴다. 예전 버전이 저장한 값은 읽을 때 버린다.)
- **데이터:** JSON 내보내기(백업), 통계 초기화(확인 1회), 기본값 복원.
- **그 밖의 값**(셔플, 배율, 시작 칩, 연출 시간)은 화면에서 바꾸지 않는다. `src/config/defaults.json`을 고치고 `npm run sim`으로 확인한 뒤 `npm run build`로 다시 만든다.

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
  config.ts             types; loadSettings()/saveSettings() (merge over defaults)
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
export interface Settings { pin: string; sound: GameConfig['sound'] } // admin screen
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
ready (난이도·판돈 고르기) ─섞기 시작→ showBall → shuffling → picking
picking ─pick: settleRound (칩 0개면 ended = broke) + 난이도별 통계 + save→ reveal → result
result ─다음 판 (ended = null)→ ready          result ─(ended = broke)→ settlement
ready | result ─정산하기: quit + save→ settlement
settlement ─지급 완료: 세션 통계 반영, session = null, save→ idle
idle ─연습하기→ practice (같은 단계, 칩 없음, 판마다 통계 + save) → idle
```
```ts
export type EndReason = 'broke' | 'quit';
export interface RoundRecord { level: LevelId; bet: number; pick: Slot; ball: Slot; win: boolean; delta: number }
export interface Session {
  id: string; startedAt: number;
  econ: EconomyConfig;            // snapshot at start
  stack: number;                  // chips to hand back right now
  rounds: RoundRecord[];
  ended: EndReason | null;
}
export function startSession(econ: EconomyConfig, now: number): Session;  // stack = buyIn
export function winAmount(bet: number, level: LevelId): number;           // floor(bet × multiplier); a miss loses the bet
export function maxBetFor(s: Session, level: LevelId): number;            // the whole stack (no table limit)
export function settleRound(s: Session, level: LevelId, bet: number, pick: Slot, plan: Plan): Session; // +winAmount / −bet, broke at 0, cap above autoSettleAt
export function quit(s: Session): Session;                                // ended = 'quit'
```

**Persistence** (`storage.ts`)
- Two keys. `yabawi:v2:settings` holds `Settings`. `yabawi:v2:state` holds `{ session: Session | null; stats: Stats }`.
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
- `session.test.ts`: 시작 칩 5개. 배율별 `floor(판돈 × 배율)`, 이기면 +그 값·지면 −판돈. `maxBetFor`는 가진 칩 전부이되 맞혔을 때 50칩을 넘지 않는 가장 큰 판돈(1~49칩 모든 칩 수·난이도에서 확인, 최소 1). 정확히 50칩이면 `cap`. 3판까지 모든 난이도·판돈·승패 순서에서 칩이 0~50 안에 있고 0개일 때만 `broke`, 50개일 때만 `cap`. `quit`은 `ended = 'quit'`. JSON으로 저장했다가 복원해도 같다.

**Playwright** (`launchOptions.executablePath: '/opt/pw-browsers/chromium'`, `playwright install`은 실행하지 않음, `?speed=20` 사용)
1. `session.spec.ts` (dev 서버): 새 손님 → 시작 → "게임 칩 5개" → `1` 키로 끝날 때까지 진행. 정산 화면 숫자 = 마지막 칩 표시다. 따로 49칩에서 시작한 세션은 최상 판돈이 1까지만 되고([최대] 버튼 꺼짐, "50칩 한도" 표시), 맞혀서 50칩이 되면 "50칩 달성! 자동 정산"이 뜨고 50칩을 지급하는지 확인한다. [지급 완료] 뒤 제목 5번 클릭, `0000` → 통계에 세션 1, 최상 판 수 ≥ 1.
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

## 11. 카지노 플랫폼 모드 (`?casino`)

카지노 플랫폼(`../플랫폼`)의 플레이어 화면이 `?casino=1`로 열면 칩이 실물이 아니라 장부에서 온다. 게임 규칙·배율·연출은 그대로다.

- **시작:** "칩 걸고 시작" → 가져갈 칩 수(잔고까지, 최대 자동 정산 칩 − 1) → 장부에서 빠지고 그 칩이 시작 칩이 된다. 관리자 PIN 화면(제목 5번 클릭)은 꺼져 있다.
- **끝:** 정산 카드의 **칩 받기**를 누르면 남은 칩이 잔고로 돌아간다. 네트워크가 끊겨 있으면 "보내는 중"으로 남기고 로비가 다시 보낸다.
- **새로고침·창 닫기:** 상태를 저장하지 않는다. 판이 돌아가는 중에 멈추면 그 판의 베팅은 잃은 것으로 정산된다(공개 전에 새로고침해서 지는 판을 없애는 꼼수 차단). 판 사이에 멈추면 가진 칩 그대로 돌아간다.

## 검토 메모

- 이번 검토 9건은 모두 타당해서 반영했다(기각 없음). 제안과 다르게 고친 곳은 두 군데다.
- 버이인은 7개가 아니라 6개로 고정했다. 칩이 0개가 되면 끝나는 규칙 하나로 예전 손실 한도 6과 같은 분포(−6 … +11)가 나오므로, 손실 한도 규칙과 음수 칩 문제가 함께 사라진다.
- 관리자 진입은 다른 단축키로 바꾸지 않고 제목 5번 클릭 하나만 남겼다.
