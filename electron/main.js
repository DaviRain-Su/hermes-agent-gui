const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, ipcMain, Notification } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const FRONTEND_URL = 'http://127.0.0.1:55000/';
const BACKEND_CMD = ['bun', 'src/backend-service.ts'];
const MAX_WAIT_MS = 30000;

let backendProc = null;
let mainWindow = null;
let tray = null;

const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(windowStatePath)) {
      return JSON.parse(fs.readFileSync(windowStatePath, 'utf-8'));
    }
  } catch {}
  return { width: 1280, height: 900 };
}

function saveWindowState() {
  if (!mainWindow) return;
  const bounds = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  const state = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: mainWindow.isMaximized(),
  };
  try {
    fs.writeFileSync(windowStatePath, JSON.stringify(state));
  } catch {}
}

function waitForBackend(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const rpcUrl = url.replace(/\/$/, '') + '/rpc';

    const tryConnect = () => {
      http.get(url, (res) => {
        if (res.statusCode === 200) {
          // HTTP server is up; now wait until backend RPC reports running=true
          checkBackendReady();
        } else {
          retry();
        }
      }).on('error', retry);

      function checkBackendReady() {
        const req = http.request(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const body = JSON.parse(data);
              if (body.result && body.result.running) {
                resolve();
                return;
              }
            } catch {}
            retry();
          });
        });
        req.on('error', retry);
        req.write(JSON.stringify({ type: 'request', id: 1, method: 'getBackendStatus', params: {} }));
        req.end();
      }

      function retry() {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Backend did not become ready in time'));
          return;
        }
        setTimeout(tryConnect, 400);
      }
    };
    tryConnect();
  });
}

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width || 1280,
    height: state.height || 900,
    x: state.x,
    y: state.y,
    title: 'Hermes Agent',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (state.maximized) {
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const prefix = ['verbose', 'info', 'warning', 'error'][level] || 'log';
    console.log(`[frontend ${prefix}]`, message, `(${sourceId}:${line})`);
  });

  mainWindow.loadURL(FRONTEND_URL);

  // Diagnostic: poll hard-debug banner text from frontend
  const diagInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(diagInterval);
      return;
    }
    mainWindow.webContents.executeJavaScript(`
      (function(){
        const hd = document.getElementById('hard-debug');
        return hd ? hd.textContent : 'NO-HARD-DEBUG';
      })()
    `, true).then(text => {
      console.log('[DIAG] hard-debug:', text);
    }).catch(() => {});
  }, 2000);

  mainWindow.on('closed', () => {
    clearInterval(diagInterval);
    mainWindow = null;
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      saveWindowState();
      mainWindow.hide();
    }
  });

  ['resize', 'move', 'maximize', 'unmaximize'].forEach((evt) => {
    mainWindow.on(evt, saveWindowState);
  });
}

function getProjectDir() {
  // In packaged app, resources are under app.asar.unpacked so Bun can access real files
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) {
    return unpacked;
  }
  // Fallback for dev mode
  return path.resolve(__dirname, '..');
}

function createTray() {
  const iconPath = path.join(__dirname, 'tray-icon.png');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') {
      icon = icon.resize({ width: 16, height: 16 });
      icon.setTemplateImage(false);
    }
  } else {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isVisible() && mainWindow.isFocused()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
            mainWindow.focus();
          }
        } else {
          createWindow();
        }
      }
    },
    {
      label: 'New Chat',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.executeJavaScript(`window.newChat && window.newChat()`).catch(() => {});
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);
  tray.setToolTip('Hermes Agent');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow();
    }
  });
}

function registerGlobalShortcuts() {
  const toggleShortcut = process.platform === 'darwin' ? 'Cmd+Shift+H' : 'Ctrl+Shift+H';
  const newChatShortcut = process.platform === 'darwin' ? 'Cmd+Shift+N' : 'Ctrl+Shift+N';

  globalShortcut.register(toggleShortcut, () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow();
    }
  });

  globalShortcut.register(newChatShortcut, () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.executeJavaScript(`window.newChat && window.newChat()`).catch(() => {});
    } else {
      createWindow();
    }
  });
}

app.whenReady().then(async () => {
  const projectDir = getProjectDir();

  backendProc = spawn(BACKEND_CMD[0], BACKEND_CMD.slice(1), {
    cwd: projectDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      HERMES_AGENT_DIR: process.env.HERMES_AGENT_DIR || path.join(process.env.HOME, 'dev', 'active', 'hermes-agent'),
    },
  });

  backendProc.on('exit', (code) => {
    console.log(`[electron] backend exited with code ${code}`);
  });

  try {
    await waitForBackend(FRONTEND_URL, MAX_WAIT_MS);
    createWindow();
    createTray();
    registerGlobalShortcuts();

    ipcMain.on('show-notification', (_event, title, body) => {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: title || 'Hermes Agent',
          body: body || 'New message',
          icon: path.join(__dirname, 'tray-icon.png'),
        });
        n.on('click', () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            createWindow();
          }
        });
        n.show();
      }
    });

    ipcMain.handle('get-window-focus-state', () => {
      return mainWindow ? mainWindow.isFocused() && mainWindow.isVisible() : false;
    });
  } catch (err) {
    console.error('[electron]', err.message);
    if (backendProc && !backendProc.killed) backendProc.kill();
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  // Keep app running in background for tray
});

app.on('before-quit', () => {
  app.isQuiting = true;
  globalShortcut.unregisterAll();
  saveWindowState();
  if (backendProc && !backendProc.killed) backendProc.kill('SIGTERM');
});
