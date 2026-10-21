// Starts the ledger server on the admin PC: node src/server/main.ts [--port 7777] [--data ./data] [--online]
// Players open one of the printed addresses in a browser on the same Wi-Fi; the admin opens the admin page here.
// --online: also the player-only port for cloudflared, and a Quick Tunnel (vendor/cloudflared.exe,
// npm run get-cloudflared) whose internet address shows up on the admin page.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PLATFORM } from '../shared/config.ts';
import { startServer, staticDirDefault } from './server.ts';

const { values } = parseArgs({
  options: { port: { type: 'string' }, data: { type: 'string' }, host: { type: 'string' }, online: { type: 'boolean' } },
});
const dataDir = resolve(values.data ?? 'data');
const srv = await startServer({
  dataDir,
  port: values.port ? Number(values.port) : PLATFORM.port,
  host: values.host,
  staticDir: staticDirDefault(),
  ...(values.online
    ? { publicPort: PLATFORM.online.publicPort, tunnel: { exe: join(import.meta.dirname, '..', '..', 'vendor', 'cloudflared.exe') } }
    : {}),
});
const s = srv.store.state;
console.log(`카지노 장부 서버 — 플레이어 ${s.players.size}명, 기록 ${s.seq}건 (${srv.store.path})`);
if (srv.store.dropped) console.warn(`정전 등으로 끊긴 마지막 줄 하나를 버렸습니다: ${srv.store.dropped.slice(0, 80)}`);
console.log(`관리자 화면 (이 PC에서): ${srv.url}admin`);
console.log('플레이어 접속 주소 (같은 와이파이):');
for (const u of srv.urls) console.log(`  ${u.url}  (${u.name})`);
if (!srv.urls.length) console.log('  (네트워크 없음)');
if (srv.publicPort !== null) console.log(`온라인판: 공개 포트 ${srv.publicPort} · 인터넷 주소와 입장 코드는 관리자 화면에 나옵니다`);

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
