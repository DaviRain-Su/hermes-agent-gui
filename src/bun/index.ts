import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { type Subprocess, spawn } from "bun";
import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  type RPCSchema,
  Utils,
} from "electrobun/bun";
import {
  detectInstallation,
  startInstallation as runInstallation,
  cancelInstallation,
  type InstallErrorCode,
  type StartInstallationResult,
} from "./installer";
import {
  checkNeedsConfig,
  getSetupFields,
  submitSetupConfig,
  type SetupFieldDef,
  type SubmitSetupResult,
} from "./setup";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const APP_NAME = "Hermes Agent";
const APP_DATA_DIR = join(homedir(), ".hermes-agent-gui");
const UPLOADS_DIR = join(APP_DATA_DIR, "uploads");
const BACKEND_PORT_START = 8642;
let BACKEND_PORT = BACKEND_PORT_START;

// Possible locations for the Hermes Agent source/installation
const HERMES_SEARCH_PATHS = [
  process.env.HERMES_AGENT_DIR,
  join(homedir(), "dev", "active", "hermes-agent"),
  join(homedir(), "dev", "hermes-agent"),
  join(homedir(), "Projects", "hermes-agent"),
  join(homedir(), "hermes-agent"),
].filter(Boolean) as string[];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let backendProcess: Subprocess | null = null;
let backendReady = false;
let mainWindowRef: BrowserWindow | null = null;
let hermesDir = "";
let pythonPath = "";

type AppPhase = "detecting" | "not_installed" | "installing" | "needs_config" | "ready" | "error";
let appPhase: AppPhase = "detecting";

interface BackendStatus {
  running: boolean;
  port: number;
  url: string;
}

interface SessionSummary {
  id: string;
  key: string;
  display_name: string;
  updated_at: string;
  created_at: string;
  message_count: number;
}

interface ChatMessage {
  role: string;
  content?: string;
  [key: string]: any;
}

interface InstallStatusPayload {
  phase: AppPhase;
  progress?: number;
  message?: string;
  canCancel?: boolean;
  canRetry?: boolean;
  errorCode?: InstallErrorCode;
}

interface DetectInstallationResult {
  installed: boolean;
  path?: string;
  version?: string;
  source?: "auto_detect" | "env_var" | "manual";
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

async function findFreePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: { data() {} },
      });
      server.stop();
      return port;
    } catch {
      // Port in use, try next
    }
  }
  throw new Error(`No free port found in range ${startPort}-${startPort + 99}`);
}

function findHermesAgentDir(): string | null {
  const result = detectInstallation();
  return result.installed ? result.path || null : null;
}

function findPythonPath(): string {
  // Prefer the Python inside the detected hermes-agent venv
  if (hermesDir) {
    const venvPython = join(hermesDir, "venv", "bin", "python");
    if (existsSync(venvPython)) {
      return venvPython;
    }
  }

  const candidates = [
    process.env.PYTHON_PATH,
    "python3",
    "python",
  ].filter(Boolean) as string[];

  for (const cmd of candidates) {
    const proc = Bun.spawnSync([cmd, "-c", "import sys; print(sys.executable)"]);
    if (proc.exitCode === 0) {
      return proc.stdout.toString().trim();
    }
  }

  throw new Error(
    "Python not found. Please install Python 3.11+ and ensure 'python3' is in your PATH."
  );
}

function getConfigManagerPath(): string {
  const bundled = join(import.meta.dir, "..", "python", "config_manager.py");
  const dev = join(process.cwd(), "python", "config_manager.py");
  return existsSync(bundled) ? bundled : dev;
}

async function runConfigManager(args: string[]): Promise<any> {
  const script = getConfigManagerPath();
  const proc = spawn([pythonPath, script, ...args], {
    env: { ...process.env, HERMES_HOME: APP_DATA_DIR } as any,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(stderr || `config_manager failed with code ${exitCode}`);
  }
  return JSON.parse(stdout.trim());
}

// ---------------------------------------------------------------------------
// Phase / View helpers
// ---------------------------------------------------------------------------
function sendInstallStatus(payload: InstallStatusPayload) {
  appPhase = payload.phase;
  mainWindowRef?.webview.rpc?.send?.installStatus?.(payload);
}

function loadView(url: string) {
  try {
    // @ts-ignore
    mainWindowRef?.webview?.loadURL?.(url);
  } catch {
    // Fallback: if loadURL is not available, navigate via JS injection
    mainWindowRef?.webview?.executeJavaScript?.(`window.location.href = "${url}"`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Bootstrap Orchestrator
// ---------------------------------------------------------------------------
async function bootstrapApp() {
  console.log("Bootstrapping app...");
  sendInstallStatus({ phase: "detecting", message: "Detecting Hermes Agent installation..." });

  const detection = detectInstallation();

  if (detection.installed && detection.path) {
    hermesDir = detection.path;
    console.log("Found Hermes Agent at:", hermesDir);

    const needsConfig = checkNeedsConfig();
    if (needsConfig) {
      sendInstallStatus({
        phase: "needs_config",
        message: "Please complete the setup wizard.",
      });
      return;
    }

    sendInstallStatus({ phase: "ready", message: "Starting backend..." });
    const ok = await startBackend();
    if (ok) {
      // Give WebView a moment to process installStatus before navigating
      setTimeout(() => loadView("views://mainview/index.html"), 200);
    } else {
      sendInstallStatus({
        phase: "error",
        message: "Backend failed to start. Check logs and try again.",
        canRetry: true,
      });
    }
    return;
  }

  sendInstallStatus({
    phase: "not_installed",
    message: "Hermes Agent is not installed.",
    canRetry: true,
  });
}

// ---------------------------------------------------------------------------
// Backend Lifecycle
// ---------------------------------------------------------------------------
async function startBackend(): Promise<boolean> {
  ensureDir(APP_DATA_DIR);

  const foundHermes = findHermesAgentDir();
  if (!foundHermes) {
    console.error("Hermes Agent source not found. Searched:", HERMES_SEARCH_PATHS);
    return false;
  }
  hermesDir = foundHermes;
  console.log("Found Hermes Agent at:", hermesDir);

  const bundledPythonDir = join(import.meta.dir, "..", "python");
  const devPythonDir = join(process.cwd(), "python");
  const bootstrapPath = existsSync(join(bundledPythonDir, "bootstrap.py"))
    ? join(bundledPythonDir, "bootstrap.py")
    : join(devPythonDir, "bootstrap.py");

  if (!existsSync(bootstrapPath)) {
    console.error("bootstrap.py not found at:", bootstrapPath);
    return false;
  }

  try {
    BACKEND_PORT = await findFreePort(BACKEND_PORT_START);
    console.log(`Using API server port ${BACKEND_PORT}`);
  } catch (e) {
    console.error("Could not find a free port:", e);
    return false;
  }

  pythonPath = findPythonPath();
  console.log("Using Python:", pythonPath);

  const env: Record<string, string> = {
    ...process.env,
    HERMES_HOME: APP_DATA_DIR,
    HERMES_AGENT_DIR: hermesDir,
    API_SERVER_ENABLED: "true",
    API_SERVER_PORT: String(BACKEND_PORT),
    API_SERVER_HOST: "127.0.0.1",
    API_SERVER_CORS_ORIGINS: "*",
    API_SERVER_KEY: "",
    PYTHONUNBUFFERED: "1",
  };

  backendProcess = spawn([pythonPath, bootstrapPath], {
    env: env as any,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Stream backend logs to console and UI
  (async () => {
    const reader = backendProcess?.stdout?.getReader();
    if (!reader) return;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      console.log("[Hermes]", text);
      mainWindowRef?.webview.rpc?.send?.backendLog?.({ stream: "stdout", text });
    }
  })();

  (async () => {
    const reader = backendProcess?.stderr?.getReader();
    if (!reader) return;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      console.error("[Hermes Err]", text);
      mainWindowRef?.webview.rpc?.send?.backendLog?.({ stream: "stderr", text });
    }
  })();

  // Wait for backend health check
  const maxRetries = 30;
  for (let i = 0; i < maxRetries; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`);
      if (res.ok) {
        console.log("Hermes backend is ready");
        backendReady = true;
        mainWindowRef?.webview.rpc?.send?.backendStatus?.({
          running: true,
          port: BACKEND_PORT,
          url: `http://127.0.0.1:${BACKEND_PORT}`,
        });
        return true;
      }
    } catch {
      // not ready yet
    }
  }

  console.error("Hermes backend failed to start within timeout");
  return false;
}

async function stopBackend(): Promise<void> {
  if (backendProcess) {
    const proc = backendProcess;
    backendProcess = null;
    backendReady = false;
    console.log("Stopping Hermes backend (SIGTERM)...");
    proc.kill();

    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 5000)),
    ]);

    if (!exited) {
      console.log("Backend did not exit in time, sending SIGKILL...");
      proc.kill(9);
      await proc.exited;
    }
    console.log("Backend stopped");
  }
}

// ---------------------------------------------------------------------------
// RPC Schema
// ---------------------------------------------------------------------------
type AppRPCSchema = {
  bun: RPCSchema<{
    requests: {
      // Existing
      getBackendStatus: { params: {}; response: BackendStatus };
      restartBackend: { params: {}; response: BackendStatus };
      getCurrentModel: { params: {}; response: { model: string; provider: string } };
      setModel: { params: { model: string; provider?: string }; response: { success: boolean; needsRestart: boolean } };
      listSessions: { params: {}; response: SessionSummary[] };
      loadSession: { params: { sessionId: string }; response: ChatMessage[] };
      saveFileUpload: { params: { name: string; dataBase64: string }; response: { success: boolean; path: string } };
      openExternal: { params: { url: string }; response: void };
      navigateTo: { params: { url: string }; response: void };
      // New installer / setup
      detectInstallation: { params: {}; response: DetectInstallationResult };
      startInstallation: { params: { confirm: boolean }; response: StartInstallationResult };
      cancelInstallation: { params: {}; response: { success: boolean } };
      getSetupFields: { params: {}; response: { fields: SetupFieldDef[]; values: Record<string, string> } };
      submitSetupConfig: { params: Record<string, string>; response: SubmitSetupResult };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      backendStatus: BackendStatus;
      backendLog: { stream: "stdout" | "stderr"; text: string };
      installStatus: InstallStatusPayload;
      installLog: { stream: "stdout" | "stderr"; text: string };
    };
  }>;
};

const rpc = BrowserView.defineRPC<AppRPCSchema>({
  maxRequestTime: 60000,
  handlers: {
    requests: {
      getBackendStatus: async () => ({
        running: backendReady,
        port: BACKEND_PORT,
        url: `http://127.0.0.1:${BACKEND_PORT}`,
      }),

      restartBackend: async () => {
        await stopBackend();
        const ok = await startBackend();
        return {
          running: ok,
          port: BACKEND_PORT,
          url: `http://127.0.0.1:${BACKEND_PORT}`,
        };
      },

      getCurrentModel: async () => {
        try {
          return await runConfigManager(["get-model"]);
        } catch (e: any) {
          console.error("getCurrentModel failed:", e);
          return { model: "", provider: "" };
        }
      },

      setModel: async ({ model, provider }) => {
        try {
          const args = provider ? ["set-model", model, provider] : ["set-model", model];
          await runConfigManager(args);
          await stopBackend();
          const ok = await startBackend();
          return { success: ok, needsRestart: true };
        } catch (e: any) {
          console.error("setModel failed:", e);
          return { success: false, needsRestart: false };
        }
      },

      listSessions: async () => {
        try {
          return await runConfigManager(["list-sessions"]);
        } catch (e: any) {
          console.error("listSessions failed:", e);
          return [];
        }
      },

      loadSession: async ({ sessionId }) => {
        try {
          return await runConfigManager(["load-session", sessionId]);
        } catch (e: any) {
          console.error("loadSession failed:", e);
          return [];
        }
      },

      saveFileUpload: async ({ name, dataBase64 }) => {
        try {
          ensureDir(UPLOADS_DIR);
          const buffer = Buffer.from(dataBase64, "base64");
          const safeName = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
          const dest = join(UPLOADS_DIR, `${Date.now()}_${safeName}`);
          writeFileSync(dest, buffer);
          return { success: true, path: dest };
        } catch (e: any) {
          console.error("saveFileUpload failed:", e);
          return { success: false, path: "" };
        }
      },

      openExternal: async ({ url }) => {
        const platform = process.platform;
        const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
        spawn([cmd, url]);
      },

      navigateTo: async ({ url }) => {
        loadView(url);
      },

      detectInstallation: async () => detectInstallation(),

      startInstallation: async ({ confirm }) => {
        if (!confirm) {
          return {
            success: false,
            errorCode: "UNKNOWN" as InstallErrorCode,
            errorMessage: "User did not confirm installation.",
          };
        }
        console.log("[SECURITY] Executing install.sh from", "https://raw.githubusercontent.com/DaviRain-Su/hermes-agent/main/scripts/install.sh");
        sendInstallStatus({ phase: "installing", message: "Preparing installation...", progress: 0, canCancel: true });

        const result = await runInstallation(
          (stream, text) => {
            mainWindowRef?.webview.rpc?.send?.installLog?.({ stream, text });
          },
          (status) => {
            sendInstallStatus({
              phase: "installing",
              message: status.message,
              progress: status.progress,
              canCancel: true,
            });
          }
        );

        if (result.success) {
          const needsConfig = checkNeedsConfig();
          if (needsConfig) {
            sendInstallStatus({ phase: "needs_config", message: "Please complete the setup wizard." });
          } else {
            sendInstallStatus({ phase: "ready", message: "Starting backend..." });
            const ok = await startBackend();
            if (ok) {
              setTimeout(() => loadView("views://mainview/index.html"), 200);
            } else {
              sendInstallStatus({ phase: "error", message: "Backend failed to start.", canRetry: true });
            }
          }
        } else {
          sendInstallStatus({
            phase: "error",
            message: result.errorMessage || "Installation failed.",
            canRetry: true,
            errorCode: result.errorCode,
          });
        }
        return result;
      },

      cancelInstallation: async () => {
        const ok = cancelInstallation();
        return { success: ok };
      },

      getSetupFields: async () => getSetupFields(),

      submitSetupConfig: async (values) => {
        const result = submitSetupConfig(values);
        if (result.success) {
          sendInstallStatus({ phase: "ready", message: "Starting backend..." });
          const ok = await startBackend();
          if (ok) {
            setTimeout(() => loadView("views://mainview/index.html"), 200);
          } else {
            sendInstallStatus({ phase: "error", message: "Backend failed to start.", canRetry: true });
          }
        }
        return result;
      },
    },
    messages: {},
  },
});

// ---------------------------------------------------------------------------
// App Menu
// ---------------------------------------------------------------------------
ApplicationMenu.setApplicationMenu([
  {
    label: APP_NAME,
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "showAll" },
      { type: "separator" },
      { role: "quit" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { role: "close" },
    ],
  },
]);

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const mainWindow = new BrowserWindow({
  title: APP_NAME,
  url: "views://setup/setup.html",
  frame: {
    width: 1280,
    height: 900,
    x: 120,
    y: 80,
  },
  rpc,
});

mainWindowRef = mainWindow;

mainWindow.webview.on("dom-ready", () => {
  // Push current state to the newly loaded view
  sendInstallStatus({
    phase: appPhase,
    message: appPhase === "detecting" ? "Detecting Hermes Agent installation..." : undefined,
  });
  mainWindowRef?.webview.rpc?.send?.backendStatus?.({
    running: backendReady,
    port: BACKEND_PORT,
    url: backendReady ? `http://127.0.0.1:${BACKEND_PORT}` : "",
  });
});

mainWindow.on("close", async () => {
  cancelInstallation();
  await stopBackend();
  Utils.quit();
});

Electrobun.events.on("before-quit", () => {
  if (backendProcess) backendProcess.kill(9);
});

// ---------------------------------------------------------------------------
// Global shortcut (best-effort)
// ---------------------------------------------------------------------------
try {
  // @ts-ignore
  if (Electrobun.globalShortcut) {
    // @ts-ignore
    Electrobun.globalShortcut.register("CommandOrControl+Shift+Space", () => {
      if (mainWindowRef) {
        mainWindowRef.show();
        mainWindowRef.focus();
      }
    });
  }
} catch {
  // ignore
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
console.log(`${APP_NAME} GUI starting...`);
bootstrapApp();
