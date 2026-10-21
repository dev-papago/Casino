// Every tunable number of the platform. The ledger server, the admin screen and the player app read this one
// object. Chips are whole numbers everywhere: in the ledger, inside the games and at the counter (실물 칩).

export type GameId = 'yabawi' | 'yeongkkeul';

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
  maxPayout: number; // a session pays out at most this (or its stake, if larger); a bigger result is a bug
}

export const PLATFORM = {
  port: 7777,
  discoveryPort: 7778, // UDP: player PCs ask "where is the casino?" on the Wi-Fi and the server answers
  signupBonus: 5, // chips a new account starts with
  pinDigits: 4,
  nameMax: 12,
  maxChips: 1_000_000, // sanity limit for any chip amount
  pingMs: 5_000, // the player app reports in this often
  offlineAfterMs: 15_000, // no report for this long → offline
  activitySaveMs: 300_000, // online time is written to the ledger at least this often
  loginFails: 5, // wrong PINs in a row before that name is locked for a while
  loginLockMs: 30_000,
  // 온라인판: the same server also answers through a cloudflared Quick Tunnel, on its own port.
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
      maxPayout: 50,
    },
    {
      id: 'yeongkkeul',
      name: '영끌문S',
      description: '모의 트레이딩. $1,000 = 1칩으로 바꿔 들어가고, 끝날 때 다시 칩으로 바꾼다.',
      perChip: 1000,
      unit: '$',
      maxPayout: 50,
    },
  ] as readonly GameDef[],
};

export const gameDef = (id: string): GameDef | undefined => PLATFORM.games.find((g) => g.id === id);
