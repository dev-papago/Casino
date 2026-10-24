// Every tunable number of the platform. The ledger server, the admin screen and the player app read this one
// object. Chips are whole numbers everywhere: in the ledger, inside the games and at the counter (실물 칩).

export type GameId = 'yabawi' | 'yeongkkeul' | 'plinko' | 'slot' | 'yacht' | 'roulette';

/**
 * A game in the player app. A game session takes chips out of the player's balance when it starts (the stake)
 * and gives chips back when it ends (the payout), so the game never needs the network in between.
 */
export interface GameDef {
  id: GameId;
  name: string;
  description: string;
  perChip: number; // what one chip is worth inside the game: 야바위 1 chip, 영끌문S $1,000
  unit: string;
  // A one-round game pays out at most stake × maxMult (its top prize); a bigger report is a bug or a forgery.
  // Games that run many rounds per session (야바위, 영끌문S) have no limit: chips won in games are unlimited.
  maxMult?: number;
  // A game between players that the server runs itself (러시안 룰렛): it opens and closes the sessions, so a player
  // can neither open one nor report a result for one.
  duel?: true;
}

export const PLATFORM = {
  port: 7777,
  signupBonus: 2, // chips a new account starts with (at 0 chips the 데스 게임 gives more)
  // 데스 게임 (THE FINAL SEAT, games/deathgame): a player with no chips at all (free, held and in games together)
  // can play it; clearing all five stages pays `reward` chips. The server follows the run stage by stage and refuses a stage reported
  // sooner after the previous one than stageMinMs allows (faster than anyone can play it: a forged report).
  deathGame: {
    reward: 5,
    stageMinMs: [8_000, 20_000, 10_000, 6_000, 4_000] as readonly number[],
  },
  // 러시안 룰렛 (1대1, games/roulette): the server keeps the rooms and runs the games (src/server/roulette.ts).
  roulette: {
    maxLives: 5, // a room's creator picks 1 to this many lives
    chambers: 6, // the revolver's cylinder: every round loads all six
    live: [2, 4] as readonly [number, number], // live rounds per load, the rest blanks
    turnMs: 10_000, // to choose: shoot yourself or the other player (then the gun goes off at yourself)
    loadMs: 4_000, // a new cylinder shown: how many live and blank
    coinMs: 3_400, // the coin toss for who starts the round
    shotMs: 2_900, // one shot played out
    absentMs: 30_000, // a player whose game has not asked for news this long has left: the other one wins
    keepMs: 120_000, // a finished room stays this long, so both players see how it ended
  },
  // 메시지: a player writes to the admin (the admin screen's 메시지 panel).
  message: {
    maxLength: 200,
    perMin: 5, // messages a minute from one player
  },
  pinDigits: 4,
  nameMax: 12,
  maxChips: 1_000_000, // sanity limit for any chip amount
  settleMax: 50, // physical chips one player can receive in all (game chips are unlimited; the rest stays in the ledger)
  // The chip economy: a guest earns 5 chips in the 데스 게임, bets half to all of the balance every round, and the
  // games' 승리 추세 (sdk/casino.ts) pulls the balance toward a center, so the chips left after 17 minutes spread
  // like a skewed bell (10–12 on average, about 1 in 30 reaching 50). The skill games pay better than the luck
  // games. The 확률 시뮬레이터 (/sim on the admin PC) shows each game's spread.
  pingMs: 5_000, // the player app reports in this often
  offlineAfterMs: 15_000, // no report for this long → offline
  activitySaveMs: 300_000, // online time is written to the ledger at least this often
  loginFails: 5, // wrong PINs in a row before that name is locked for a while
  loginLockMs: 30_000,
  // Players come in through a cloudflared Quick Tunnel to the server's public port.
  online: {
    publicPort: 7780, // the tunnel's way in, on 127.0.0.1 only: player routes, no admin routes
    pingMs: 2_000, // a Quick Tunnel does not pass server-sent events, so the player app asks this often instead
    entryDigits: 6, // 입장 코드: signup and login through the tunnel need it (told at the venue); new at every start
    // A venue's players often share one public IP, so the per-IP limits are loose; the global cap does the real work:
    // at 100 wrong codes a minute, guessing 6 digits takes days.
    entryFails: 20, // wrong 입장 코드 in a row from one IP (an IPv6 /64) before it is shut out for a while
    entryLockMs: 120_000,
    wrongPerMin: 100, // wrong 입장 코드 a minute from everywhere together; past it no code is checked until it calms down
    reviewNet: 20, // an online game that wins this many chips or more waits for the admin before it pays out
    ratePerIp: 120, // signup and login tries per IP (an IPv6 /64) per minute through the tunnel
    signupsPerMin: 30, // signups through the tunnel per minute, all IPs together
    tunnelRestartMs: 5_000, // cloudflared stopped: start it again after this long
  },
  games: [
    {
      id: 'yabawi',
      name: '야바위',
      description: '컵 세 개 속 공을 찾아라. 맞히면 배당만큼 칩을 받는다.',
      perChip: 1,
      unit: '칩',
    },
    {
      id: 'yeongkkeul',
      name: '영끌문S',
      description: '모의 트레이딩. $1,000 = 1칩으로 바꿔 들어가고, 끝날 때 다시 칩으로 바꾼다.',
      perChip: 1000,
      unit: '$',
    },
    {
      id: 'plinko',
      name: '플링코',
      description: '공을 떨어뜨려 바닥 칸의 배율만큼 받는다. 쉬움은 자주 조금, 어려움은 가끔 크게.',
      perChip: 1,
      unit: '칩',
      maxMult: 50,
    },
    {
      id: 'slot',
      name: '슬롯머신',
      description: '릴 세 개를 돌려 같은 그림을 맞춘다. 777이면 50배.',
      perChip: 1,
      unit: '칩',
      maxMult: 50,
    },
    {
      id: 'yacht',
      name: '요트 다이스',
      description: '주사위 다섯 개를 세 번 굴려 족보를 만든다. 한 번 잡은 주사위는 풀 수 없다.',
      perChip: 1,
      unit: '칩',
      maxMult: 20,
    },
    {
      id: 'roulette',
      name: '러시안 룰렛',
      description: '1대1 대결. 같은 판돈을 걸고 리볼버 한 자루로 버틴다. 살아남은 사람이 판돈을 모두 가져간다.',
      perChip: 1,
      unit: '칩',
      maxMult: 2,
      duel: true,
    },
  ] as readonly GameDef[],
};

export const gameDef = (id: string): GameDef | undefined => PLATFORM.games.find((g) => g.id === id);
