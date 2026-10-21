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
