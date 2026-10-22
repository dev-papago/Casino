// The server for the e2e tests: an empty ledger in test-results/e2e-data, offline after 6 s without a report (the
// player app reports every 5 s) so a dropped Wi-Fi shows up quickly, and 데스 게임 stages accepted at once (the
// tests take its reward through its API: tests/e2e/helpers.ts).
import { rmSync } from 'node:fs';
import { startServer, staticDirDefault } from '../../src/server/server.ts';

const dataDir = 'test-results/e2e-data';
rmSync(dataDir, { recursive: true, force: true });
await startServer({ dataDir, port: Number(process.argv[2]), host: '127.0.0.1', staticDir: staticDirDefault(), timing: { offlineAfterMs: 6000, deathStageMinMs: [0, 0, 0, 0, 0] } });
