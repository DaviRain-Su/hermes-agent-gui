const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const FRONTEND_URL = 'http://127.0.0.1:55000/';
const BACKEND_CMD = ['bun', 'src/backend-service.ts'];
const MAX_WAIT_MS = 30000;

let backendProc = null;
let mainWindow = null;

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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Hermes Agent',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
    },
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
}

function getProjectDir() {
  // In packaged app, resources are under app.asar.unpacked so Bun can access real files
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked');
  if (require('fs').existsSync(unpacked)) {
    return unpacked;
  }
  // Fallback for dev mode
  return path.resolve(__dirname, '..');
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
  } catch (err) {
    console.error('[electron]', err.message);
    if (backendProc && !backendProc.killed) backendProc.kill();
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (backendProc && !backendProc.killed) backendProc.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProc && !backendProc.killed) backendProc.kill('SIGTERM');
});
