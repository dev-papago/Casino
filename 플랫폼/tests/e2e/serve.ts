// The server for the e2e tests: an empty ledger in test-results/e2e-data, and offline after 6 s without a report
// (the player app reports every 5 s) so a dropped Wi-Fi shows up quickly.
import { rmSync } from 'node:fs';
import { startServer, staticDirDefault } from '../../src/server/server.ts';

const dataDir = 'test-results/e2e-data';
rmSync(dataDir, { recursive: true, force: true });
await startServer({ dataDir, port: Number(process.argv[2]), host: '127.0.0.1', staticDir: staticDirDefault(), timing: { offlineAfterMs: 6000 }, discoveryPort: null });
