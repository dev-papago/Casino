// Electron wrapper: opens the single-file build (dist/index.html) in a window, fully offline.
// F11 toggles full screen; the app menu is hidden.
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#1a0610',
    autoHideMenuBar: true,
    title: '야바위',
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
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
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
  });

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
