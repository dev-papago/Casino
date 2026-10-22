// Starts the ledger server on the admin PC: node src/server/main.ts [--port 7777] [--data ./data] [--no-tunnel]
// The admin page is on this PC only; players use the internet address of the cloudflared Quick Tunnel
// (vendor/cloudflared.exe, npm run get-cloudflared), shown on the admin page with the 입장 코드.
// --no-tunnel: the public port without cloudflared (development).
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PLATFORM } from '../shared/config.ts';
import { startServer, staticDirDefault } from './server.ts';

const { values } = parseArgs({
  options: { port: { type: 'string' }, data: { type: 'string' }, 'no-tunnel': { type: 'boolean' } },
});
const dataDir = resolve(values.data ?? 'data');
const srv = await startServer({
  dataDir,
  port: values.port ? Number(values.port) : PLATFORM.port,
  staticDir: staticDirDefault(),
  publicPort: PLATFORM.online.publicPort,
  tunnel: values['no-tunnel'] ? null : { exe: join(import.meta.dirname, '..', '..', 'vendor', 'cloudflared.exe') },
});
const s = srv.store.state;
console.log(`카지노 장부 서버 — 플레이어 ${s.players.size}명, 기록 ${s.seq}건 (${srv.store.path})`);
if (srv.store.dropped) console.warn(`정전 등으로 끊긴 마지막 줄 하나를 버렸습니다: ${srv.store.dropped.slice(0, 80)}`);
console.log(`관리자 화면 (이 PC에서): ${srv.url}admin`);
console.log(`공개 포트 ${srv.publicPort} · 인터넷 주소와 입장 코드는 관리자 화면에 나옵니다`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await srv.close();
  console.log('장부를 저장하고 종료했습니다.');
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
