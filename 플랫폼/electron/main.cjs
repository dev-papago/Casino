// Electron wrapper for the admin PC: runs the ledger server in this process and shows the admin screen.
// The ledger lives in a folder next to the portable exe (카지노장부-data), so it moves with the exe; players on
// the same Wi-Fi open the address shown at the top of the admin screen in their browser.
// Closing the window asks first: it stops the server, and every player PC loses its connection.
const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PORT = 7777;
let server = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit(); // one ledger server per PC

function isBlockedKey(input) {
  const key = input.key.toLowerCase();
  const mod = input.control || input.meta;
  if (key === 'f12') return true;
  if (mod && input.shift && (key === 'i' || key === 'j' || key === 'c')) return true; // dev tools
  return false;
}

async function start() {
  const home = process.env.PORTABLE_EXECUTABLE_DIR || app.getPath('userData');
  const dataDir = path.join(home, '카지노장부-data');
  try {
    const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'dist-server', 'server.mjs')).href);
    server = await startServer({ dataDir, port: PORT, staticDir: path.join(__dirname, '..', 'dist') });
  } catch (e) {
    dialog.showErrorBox('카지노 장부', `서버를 켜지 못했습니다.\n\n${e && e.message ? e.message : e}`);
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1100,
    minHeight: 640,
    backgroundColor: '#0b0816',
    autoHideMenuBar: true,
    title: '카지노 장부 (관리자)',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, devTools: false, backgroundThrottling: false },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
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
  // The CSV export is a download: save it where the admin chooses.
  win.webContents.session.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'DB 기록 저장', defaultPath: path.join(app.getPath('documents'), item.getFilename()) });
  });
  win.on('close', (e) => {
    if (quitting) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['끄기', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: '카지노 장부',
      message: '장부 서버를 끌까요?',
      detail: '끄면 플레이어 PC의 접속이 모두 끊깁니다. 장부는 저장되어 있고, 다시 켜면 그대로 이어집니다.',
    });
    if (choice === 1) {
      e.preventDefault();
      return;
    }
    quitting = true;
  });
  win.loadURL(`${server.url}admin`);
}

app.whenReady().then(start);
app.on('window-all-closed', async () => {
  if (server) await server.close().catch(() => {});
  server = null;
  app.quit();
});
