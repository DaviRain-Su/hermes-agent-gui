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
import {
  initMcpManager,
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  listMcpTools,
  callMcpTool,
} from "../mcp-manager";

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
let currentViewUrl = "";

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

function getSkillsManagerPath(): string {
  const bundled = join(import.meta.dir, "..", "python", "skills_manager.py");
  const dev = join(process.cwd(), "python", "skills_manager.py");
  return existsSync(bundled) ? bundled : dev;
}

async function runSkillsManager(args: string[]): Promise<any> {
  const script = getSkillsManagerPath();
  const proc = spawn([pythonPath, script, ...args], {
    env: { ...process.env, HERMES_HOME: APP_DATA_DIR, HERMES_AGENT_DIR: hermesDir } as any,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(stderr || `skills_manager failed with code ${exitCode}`);
  }
  return JSON.parse(stdout.trim());
}

// ---------------------------------------------------------------------------
// Phase / View helpers
// ---------------------------------------------------------------------------
function sendInstallStatus(payload: InstallStatusPayload) {
  appPhase = payload.phase;
  // In backend-service mode we do not push messages to a webview.
}

function loadView(url: string) {
  // No-op in backend-service mode.
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
  if (backendProcess) {
    console.log("Backend already running, skipping start.");
    return backendReady;
  }
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
    GATEWAY_ALLOW_ALL_USERS: "true",
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
      mainWindowRef?.webview.rpc?.send.backendLog({ stream: "stdout", text });
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
      mainWindowRef?.webview.rpc?.send.backendLog({ stream: "stderr", text });
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
        mainWindowRef?.webview.rpc?.send.backendStatus({
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
      getInstallStatus: { params: {}; response: InstallStatusPayload };
      getSetupFields: { params: {}; response: { fields: SetupFieldDef[]; values: Record<string, string> } };
      submitSetupConfig: { params: Record<string, string>; response: SubmitSetupResult };
      // Skills
      listSkills: { params: {}; response: { categories?: string[]; skills: any[] } };
      getSkillDetail: { params: { name: string }; response: any };
      getSkillCommands: { params: {}; response: Record<string, { name: string; description: string; skill_md_path: string; skill_dir: string }> };
      installSkill: { params: { identifier: string }; response: { success: boolean; error?: string; skill?: any } };
      updateSkill: { params: { name?: string }; response: { success: boolean; error?: string } };
      uninstallSkill: { params: { name: string }; response: { success: boolean; error?: string } };
      enableSkill: { params: { name: string }; response: { success: boolean; error?: string } };
      disableSkill: { params: { name: string }; response: { success: boolean; error?: string } };
      // MCP
      listMcpServers: { params: {}; response: any[] };
      addMcpServer: { params: any; response: { success: boolean; error?: string } };
      removeMcpServer: { params: { name: string }; response: { success: boolean } };
      listMcpTools: { params: {}; response: { tools: any[] } };
      callMcpTool: { params: { server: string; name: string; arguments: any }; response: any };
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

const rpcHandlers: AppRPCSchema["bun"]["handlers"] = {
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
          mainWindowRef?.webview.rpc?.send.installLog({ stream, text });
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

    getInstallStatus: async () => {
      return {
        phase: appPhase,
        message:
          appPhase === "detecting"
            ? "Detecting Hermes Agent installation..."
            : undefined,
      };
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

    listSkills: async () => {
      try {
        return await runSkillsManager(["list"]);
      } catch (e: any) {
        console.error("listSkills failed:", e);
        return { categories: [], skills: [] };
      }
    },

    getSkillDetail: async ({ name }) => {
      try {
        return await runSkillsManager(["view", name]);
      } catch (e: any) {
        console.error("getSkillDetail failed:", e);
        return { success: false, error: e.message };
      }
    },

    getSkillCommands: async () => {
      try {
        return await runSkillsManager(["commands"]);
      } catch (e: any) {
        console.error("getSkillCommands failed:", e);
        return {};
      }
    },

    installSkill: async ({ identifier }) => {
      try {
        return await runSkillsManager(["install", identifier]);
      } catch (e: any) {
        console.error("installSkill failed:", e);
        return { success: false, error: e.message };
      }
    },

    updateSkill: async ({ name }) => {
      try {
        const args = name ? ["update", name] : ["update"];
        return await runSkillsManager(args);
      } catch (e: any) {
        console.error("updateSkill failed:", e);
        return { success: false, error: e.message };
      }
    },

    uninstallSkill: async ({ name }) => {
      try {
        return await runSkillsManager(["uninstall", name]);
      } catch (e: any) {
        console.error("uninstallSkill failed:", e);
        return { success: false, error: e.message };
      }
    },

    enableSkill: async ({ name }) => {
      try {
        return await runSkillsManager(["enable", name]);
      } catch (e: any) {
        console.error("enableSkill failed:", e);
        return { success: false, error: e.message };
      }
    },

    disableSkill: async ({ name }) => {
      try {
        return await runSkillsManager(["disable", name]);
      } catch (e: any) {
        console.error("disableSkill failed:", e);
        return { success: false, error: e.message };
      }
    },

    // MCP
    listMcpServers: async () => listMcpServers(),
    addMcpServer: async (params) => addMcpServer(params),
    removeMcpServer: async ({ name }) => removeMcpServer(name),
    listMcpTools: async () => listMcpTools(),
    callMcpTool: async (params) => callMcpTool(params),
  },
  messages: {},
};

const rpc = BrowserView.defineRPC<AppRPCSchema>({
  maxRequestTime: 60000,
  handlers: rpcHandlers,
});

// ---------------------------------------------------------------------------
// HTTP RPC fallback server (Linux dev workaround for broken WebSocket bridge)
// ---------------------------------------------------------------------------
let HTTP_RPC_PORT = 0;
for (let port = 55000; port <= 55010; port++) {
  try {
    Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/rpc" || req.method !== "POST") {
          return new Response("Not found", { status: 404 });
        }
        try {
          const body = (await req.json()) as any;
          const { type, id, method, params } = body;
          if (type === "request" && method) {
            const handlerFn = (rpcHandlers.requests as any)[method];
            if (typeof handlerFn === "function") {
              const result = await handlerFn(params);
              return new Response(JSON.stringify({ type: "response", id, result }), {
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response(
              JSON.stringify({ type: "response", id, error: "Method not found" }),
              { status: 404, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ type: "response", id, error: "Invalid body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        } catch (e: any) {
          return new Response(
            JSON.stringify({ type: "response", error: e?.message || String(e) }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      },
    });
    HTTP_RPC_PORT = port;
    console.log("[HTTP-RPC] fallback server listening on port", port);
    break;
  } catch {
    // try next port
  }
}
if (!HTTP_RPC_PORT) {
  console.error("[HTTP-RPC] failed to start fallback server: no free port in range 55000-55010");
}

// ---------------------------------------------------------------------------
// Backend service auto-start
// ---------------------------------------------------------------------------
console.log(`${APP_NAME} backend service starting...`);
bootstrapApp();
initMcpManager();

// Graceful shutdown on SIGTERM/SIGINT
process.on("SIGTERM", async () => {
  await stopBackend();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await stopBackend();
  process.exit(0);
});
