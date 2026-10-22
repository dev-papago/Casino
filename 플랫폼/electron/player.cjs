// Electron wrapper for a player PC: opens the casino's internet address and shows the player app full screen.
// The address is the https://….trycloudflare.com one on the admin screen, asked for together with the 입장 코드
// (checked right away, then handed to the app so the login form does not ask again). Both change when the server
// restarts, so the boxes show at once while the last address and code are tried in the background for a while.
// Reload, dev tools and zoom keys are blocked (a reload in the middle of a game must not be a way out of a loss;
// the games settle such a stop anyway), and the window never leaves the server's pages.
const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ADDRESS_HINT = '관리자 화면의 인터넷 주소 (https://….trycloudflare.com)';
const SETUP = 'casino-setup:'; // links on the local pages: casino-setup://search, casino-setup://connect?addr=…&code=…

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = ''; // https://….trycloudflare.com/
let attempt = 0; // bumped by every new search or typed address: an older background try then gives up
const configPath = () => path.join(app.getPath('userData'), 'server.json');

/** The last address and 입장 코드 that worked. */
function saved() {
  try {
    const v = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { url: v.url || '', code: v.code || '' };
  } catch {
    return { url: '', code: '' };
  }
}

function saveServer(url, code) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ url, code }));
  } catch {
    // remembered until the window closes
  }
}

function normalize(raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//.test(v)) v = `https://${v}`; // the tunnel's address is https
  const u = new URL(v);
  return `${u.protocol}//${u.host}/`;
}

/** Is the casino server answering at this address? */
async function reachable(url) {
  try {
    // Through the internet an answer takes longer than on the Wi-Fi.
    const res = await fetch(`${url}api/nothing`, { signal: AbortSignal.timeout(url.startsWith('https:') ? 6000 : 2500) });
    return res.status === 404; // the server's own "not found": it is there
  } catch {
    return false;
  }
}

/**
 * The 입장 코드 at this address: 'ok', 'wrong', 'locked' (too many wrong codes from here, or a flood: wait), or
 * 'down'. The admin PC's own address needs no code.
 */
async function checkCode(url, code) {
  try {
    const hello = await (await fetch(`${url}api/hello`, { signal: AbortSignal.timeout(6000) })).json();
    if (!hello.entryDigits) return 'ok';
    const res = await fetch(`${url}api/entry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) return 'ok';
    const err = (await res.json().catch(() => ({}))).error;
    return err === 'entry' ? 'wrong' : err === 'entry_locked' || err === 'busy' ? 'locked' : 'down';
  } catch {
    return 'down';
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

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function showSetup(note, value = '', code = '') {
  return win.loadURL(
    page(
      '카지노 서버 찾기',
      `<h1>♠ 카지노</h1><p id="note">${note}</p>
       <form action="${SETUP}//connect"><input name="addr" placeholder="${ADDRESS_HINT}" value="${escapeHtml(value)}" onfocus="this.select()" autofocus>
       <input name="code" placeholder="입장 코드 (숫자 6자리, 관리자 화면에 표시)" inputmode="numeric" maxlength="6" value="${escapeHtml(code)}" onfocus="this.select()">
       <button>연결</button></form><a class="btn" href="${SETUP}//search">저장된 주소로 다시 시도</a>`,
    ),
  );
}

/** Changes the line above the address box without reloading the page (what is typed stays). */
function setNote(text) {
  win.webContents.executeJavaScript(`{const n=document.getElementById('note'); if (n) n.textContent=${JSON.stringify(text)};}`).catch(() => {});
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

/** Opens the app at this address with this 입장 코드: 'ok', 'wrong', 'locked' or 'down' (see checkCode). */
async function connect(url, code, mine = ++attempt) {
  if (!url || !(await reachable(url))) return 'down';
  const r = await checkCode(url, code);
  if (r !== 'ok' || mine !== attempt) return r;
  server = url;
  saveServer(url, code);
  win.loadURL(code ? `${server}#entry=${code}` : server); // the app keeps the code and hides its field
  return 'ok';
}

const ASK = '관리자 화면의 "인터넷 주소"와 "입장 코드"를 입력하세요.';
const CODE_TEXT = {
  wrong: '입장 코드가 맞지 않습니다. 관리자 화면의 입장 코드를 확인하세요.',
  locked: '입장 코드를 여러 번 틀렸습니다. 2분 뒤에 다시 하세요.',
};

async function search() {
  const mine = ++attempt;
  const last = saved();
  if (!last.url) return showSetup(ASK);
  // The boxes are there at once: the admin may already have a new address and code (both change when the ledger
  // restarts). Meanwhile the saved ones are tried for about half a minute (a tunnel that just started answers late).
  await showSetup('지난번 주소에 연결하는 중… 관리자 화면의 주소가 바뀌었으면 새 주소와 입장 코드를 입력하세요.', last.url, last.code);
  for (let i = 0; i < 7; i++) {
    if (mine !== attempt) return; // the player typed an address
    const r = await connect(last.url, last.code, mine);
    if (r === 'ok' || mine !== attempt) return;
    if (r !== 'down') return setNote(CODE_TEXT[r]);
    setNote(`지난번 주소에 연결하는 중… (${i + 2}번째 시도) 관리자 화면의 주소가 바뀌었으면 새 주소와 입장 코드를 입력하세요.`);
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (mine === attempt) setNote('지난번 주소는 응답하지 않습니다. 관리자 장부를 다시 켜면 주소와 입장 코드가 바뀝니다. 새로 입력하세요.');
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
  if (u.host === 'setup') return showSetup(ASK, saved().url, saved().code);
  if (u.host === 'retry') {
    const r = await connect(server, saved().code);
    if (r === 'down') showOffline();
    else if (r !== 'ok') showSetup(CODE_TEXT[r], server);
    return;
  }
  if (u.host === 'connect') {
    let addr = '';
    try {
      addr = normalize(u.searchParams.get('addr'));
    } catch {
      addr = '';
    }
    const code = String(u.searchParams.get('code') || '').replace(/\D/g, '');
    setNote(`${addr || '그 주소'}에 연결하는 중…`);
    const r = await connect(addr, code);
    if (r === 'down') showSetup(`${escapeHtml(addr || '그 주소')}에서 서버가 응답하지 않습니다. 주소를 다시 확인하세요.`, addr, code);
    else if (r !== 'ok') showSetup(CODE_TEXT[r], addr);
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
