// Runs a cloudflared Quick Tunnel to the server's public port. No Cloudflare account: every
// start gets a new https://….trycloudflare.com address, read from cloudflared's output. If cloudflared stops, it is
// started again after a pause (and the address changes); stop() ends it for good.
import { spawn, type ChildProcess } from 'node:child_process';

export interface TunnelState {
  status: 'starting' | 'up' | 'restarting' | 'stopped';
  url: string | null;
  message: string;
}

export interface Tunnel {
  state(): TunnelState;
  stop(): void;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const UP_RE = /Registered tunnel connection/i;

export function startTunnel(o: { exe: string; port: number; restartMs: number; onChange: (s: TunnelState) => void }): Tunnel {
  let state: TunnelState = { status: 'starting', url: null, message: '인터넷 주소를 받는 중…' };
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let tries = 0;

  const set = (s: TunnelState): void => {
    state = s;
    o.onChange(s);
  };

  function run(): void {
    timer = null;
    tries++;
    set({ status: tries === 1 ? 'starting' : 'restarting', url: null, message: '인터넷 주소를 받는 중…' });
    let url: string | null = null;
    let tail = '';
    const c = spawn(o.exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${o.port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = c;
    const read = (d: Buffer): void => {
      const text = d.toString();
      tail = (tail + text).slice(-2000);
      url ??= URL_RE.exec(tail)?.[0] ?? null;
      if (url && state.status !== 'up' && UP_RE.test(text)) {
        set({ status: 'up', url, message: '인터넷으로 접속할 수 있습니다' });
      }
    };
    c.stdout?.on('data', read);
    c.stderr?.on('data', read);
    c.on('error', (e) => {
      child = null;
      set({ status: 'stopped', url: null, message: `cloudflared를 실행하지 못했습니다: ${e.message}` });
    });
    c.on('exit', (code) => {
      if (child === c) child = null;
      if (stopped || state.status === 'stopped') return;
      const why = /failed|error/i.exec(tail) ? tail.split('\n').filter((l) => /ERR|failed/i.test(l)).pop()?.trim() : '';
      set({
        status: 'restarting',
        url: null,
        message: `터널이 끊겼습니다 (코드 ${code ?? '?'}). ${Math.round(o.restartMs / 1000)}초 뒤 다시 켭니다${why ? ` · ${why.slice(0, 120)}` : ''}`,
      });
      timer = setTimeout(run, o.restartMs);
    });
  }

  run();
  return {
    state: () => state,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      child?.kill();
      child = null;
      state = { status: 'stopped', url: null, message: '터널을 껐습니다' };
    },
  };
}
