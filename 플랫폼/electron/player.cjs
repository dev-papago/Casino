// Electron wrapper for a player PC: finds the casino server on the Wi-Fi and shows the player app full screen.
// Finding: the address that worked last time, else a broadcast "CASINO?" that the server answers (UDP
// PLATFORM.discoveryPort), else a page where staff type the address shown on the admin screen.
// Reload, dev tools and zoom keys are blocked (a reload in the middle of a game must not be a way out of a loss;
// the games settle such a stop anyway), and the window never leaves the server's pages.
const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { discover } = require('./discover.cjs');

const HTTP_PORT = 7777;
const SETUP = 'casino-setup:'; // links on the local pages: casino-setup://search, casino-setup://connect?addr=…

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = ''; // http://address:port/
const configPath = () => path.join(app.getPath('userData'), 'server.json');

function savedServer() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')).url || '';
  } catch {
    return '';
  }
}

function saveServer(url) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ url }));
  } catch {
    // remembered until the window closes
  }
}

function normalize(raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//.test(v)) v = `http://${v}`;
  const u = new URL(v);
  if (!u.port) u.port = String(HTTP_PORT);
  return `${u.protocol}//${u.host}/`;
}

/** Is the casino server answering at this address? */
async function reachable(url) {
  try {
    const res = await fetch(`${url}api/nothing`, { signal: AbortSignal.timeout(2500) });
    return res.status === 404; // the server's own "not found": it is there
  } catch {
    return false;
  }
}

function page(title, body) {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title><style>
    body{margin:0;height:100vh;display:grid;place-items:center;background:#090612;color:#f6f0ff;
      font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif}
    .card{width:30rem;padding:2rem;border-radius:1rem;background:rgba(28,18,48,.9);border:1px solid rgba(255,200,120,.2);text-align:center}
    h1{color:#ffcf4a;margin:0 0 1rem}p{color:#a89bc4}input{width:100%;box-sizing:border-box;padding:.7rem;font-size:1.1rem;
      border-radius:.6rem;border:1px solid #555;background:#111;color:#fff;margin:.5rem 0}
    button,a.btn{display:inline-block;margin:.4rem;padding:.6rem 1.2rem;border-radius:.6rem;border:0;font-weight:800;
      background:#ffcf4a;color:#241400;text-decoration:none;cursor:pointer;font-size:1rem}
  </style></head><body><div class="card">${body}</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showSetup(note) {
  win.loadURL(
    page(
      '카지노 서버 찾기',
      `<h1>♠ 카지노</h1><p>${note}</p>
       <form action="${SETUP}//connect"><input name="addr" placeholder="관리자 화면의 접속 주소 (예: 192.168.0.12:7777)" autofocus>
       <button>연결</button></form><a class="btn" href="${SETUP}//search">다시 찾기</a>`,
    ),
  );
}

function showOffline() {
  win.loadURL(
    page(
      '서버 연결 끊김',
      `<h1>♠ 카지노</h1><p>서버(${server})에 연결할 수 없습니다.<br>3초마다 다시 연결합니다.</p>
       <a class="btn" href="${SETUP}//search">서버 다시 찾기</a><a class="btn" href="${SETUP}//setup">주소 직접 입력</a>
       <script>setTimeout(() => (location.href = '${SETUP}//retry'), 3000)</script>`,
    ),
  );
}

async function connect(url) {
  if (url && (await reachable(url))) {
    server = url;
    saveServer(url);
    win.loadURL(server);
    return true;
  }
  return false;
}

async function search() {
  showSetupNote('같은 와이파이에서 카지노 서버를 찾는 중…');
  if (await connect(savedServer())) return;
  if (await connect(await discover())) return;
  showSetup('서버를 찾지 못했습니다. 관리자 PC가 켜져 있고 같은 와이파이인지 확인하세요.');
}

function showSetupNote(note) {
  win.loadURL(page('카지노', `<h1>♠ 카지노</h1><p>${note}</p>`));
}

function isBlockedKey(input) {
  const key = input.key.toLowerCase();
  const mod = input.control || input.meta;
  if (key === 'f5' || key === 'f12') return true;
  if (mod && key === 'r') return true;
  if (mod && input.shift && (key === 'i' || key === 'j' || key === 'c')) return true;
  if (mod && (key === '=' || key === '+' || key === '-' || key === '0')) return true;
  if (input.alt && (key === 'arrowleft' || key === 'arrowright')) return true; // back / forward
  return false;
}

async function onSetupLink(url) {
  const u = new URL(url);
  if (u.host === 'search') return search();
  if (u.host === 'setup') return showSetup('관리자 화면 오른쪽 위의 "플레이어 접속 주소"를 입력하세요.');
  if (u.host === 'retry') {
    if (!(await connect(server))) showOffline();
    return;
  }
  if (u.host === 'connect') {
    let addr = '';
    try {
      addr = normalize(u.searchParams.get('addr'));
    } catch {
      addr = '';
    }
    if (!(await connect(addr))) showSetup(`${addr || '그 주소'}에서 서버가 응답하지 않습니다. 주소를 다시 확인하세요.`);
  }
}

function start() {
  win = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#090612',
    autoHideMenuBar: true,
    title: '카지노',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, devTools: false, backgroundThrottling: false },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !(server && url.startsWith(server))) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(SETUP)) {
      e.preventDefault();
      void onSetupLink(url);
    } else if (!(server && url.startsWith(server)) && !url.startsWith('data:')) {
      e.preventDefault(); // stays on the casino
    }
  });
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && server && url.startsWith(server)) showOffline(); // -3: navigation replaced
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    } else if (isBlockedKey(input)) {
      e.preventDefault();
    }
  });
  void search();
}

app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
