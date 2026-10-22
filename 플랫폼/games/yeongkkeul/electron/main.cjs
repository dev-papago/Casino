// Electron wrapper: opens the single-file build (dist/index.html) in a window, fully offline.
// F11 toggles full screen; the app menu is hidden. Reload and dev tools are blocked so a player
// cannot reset a losing game, and timers keep running when the window loses focus.
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

function isBlockedKey(input) {
  const key = input.key.toLowerCase();
  const mod = input.control || input.meta;
  if (key === 'f5' || key === 'f12') return true;
  if (mod && key === 'r') return true; // Ctrl+R, Ctrl+Shift+R
  if (mod && input.shift && (key === 'i' || key === 'j' || key === 'c')) return true; // dev tools
  if (mod && (key === '=' || key === '+' || key === '-' || key === '0')) return true; // zoom
  return false;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#070b16',
    autoHideMenuBar: true,
    title: '영끌문S',
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      devTools: false,
      backgroundThrottling: false,
    },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  // The game never navigates; anything that tries to open a link goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    } else if (isBlockedKey(input)) {
      e.preventDefault();
    }
  });

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
