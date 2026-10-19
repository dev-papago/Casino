# casion — 야바위 부스 게임

인터넷 없이 노트북 한 대에서 돌리는 야바위 게임입니다. 설계와 경제 수치는 [docs/DESIGN.md](docs/DESIGN.md)에 있습니다.

## 부스에서 실행하기 (exe)

1. (Windows PC, 인터넷 되는 곳에서 한 번만) `npm install` → `npm run exe`
   - Node.js 22.12 이상이 필요합니다 (Electron 44 요구사항). `node -v`로 확인하세요.
2. `release/Yabawi-<버전>-portable.exe` 파일 하나가 만들어집니다. 설치 없이 더블클릭하면 바로 실행되고, 인터넷이 필요 없습니다.
   - 창이 최대화로 열립니다. `F11`로 전체 화면을 켜고 끕니다.
   - 통계는 PC의 사용자 데이터 폴더에 저장되므로 exe를 다른 폴더로 옮겨도 유지됩니다.
   - 서명되지 않은 exe라 처음 실행할 때 Windows SmartScreen 경고가 뜰 수 있습니다. "추가 정보" → "실행"을 누르세요.
- 빌드 없이 창으로 바로 확인: `npm run app`
- exe 대신 브라우저로 쓰려면 `npm run build` 후 `dist/index.html`을 Chrome이나 Edge로 엽니다.

## 진행 방법

- **새 손님** → 손님에게 칩 5개를 받고 **시작**
- 판마다 난이도와 판돈을 고릅니다 (클릭, 또는 `←` `→` 난이도 · `↑` `↓` 판돈)
  - 중간 ×1.2 · 높음 ×1.5 · 최상 ×2
  - 맞히면 판돈 × 배율(소수점 버림)만큼 얻고, 틀리면 같은 만큼 잃습니다. 예: 최상 판돈 2 → +4 / −4
  - 한 판 최대 판돈 5칩 (관리자 화면에서 변경), 잃을 칩이 모자라면 그 판돈은 고를 수 없습니다.
- `Space` 섞기 → `1`·`2`·`3` 또는 클릭으로 컵 고르기 → `Enter` 다음 판
- **정산하기**를 누를 때까지 계속합니다 (칩이 0개가 되면 자동 정산).
- 정산 화면의 "돌려드릴 칩 N개"만큼 칩을 주고 **지급 완료**
- 쉬움은 칩 없는 무료 연습입니다. 연습하기에서는 모든 난이도를 무료로 해 볼 수 있습니다.
- `M` 소리 켜기/끄기

## 관리자 화면

화면 위 제목 **야바위**를 5번 연달아 클릭 → PIN (기본 `0000`).
통계(난이도별 적중률, 부스 순칩), 최대 판돈(1~20칩), 소리, PIN, 백업(JSON), 초기화를 할 수 있습니다.
그 밖의 값은 `src/config/defaults.json`을 고치고 `npm run sim`으로 확인한 뒤 `npm run build`로 다시 만듭니다.

## 개발

| 명령 | 내용 |
|---|---|
| `npm run dev` | 개발 서버 |
| `npm run build` | `dist/index.html` 한 파일로 빌드 |
| `npm run app` | 빌드 후 Electron 창으로 실행 |
| `npm run exe` | Windows portable exe 만들기 (`release/`) |
| `npm test` | 단위 테스트 (Vitest) |
| `npm run e2e` | 브라우저 테스트 (Playwright) |
| `npm run sim` | 경제 시뮬레이션 |
| `npm run typecheck` | 타입 검사 |
