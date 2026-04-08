import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { type Subprocess, spawn } from "bun";
import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import {
  detectInstallation,
  startInstallation as runInstallation,
  cancelInstallation,
  type InstallErrorCode,
  type StartInstallationResult,
} from "./bun/installer";
import {
  checkNeedsConfig,
  getSetupFields,
  submitSetupConfig,
  type SetupFieldDef,
  type SubmitSetupResult,
} from "./bun/setup";

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
// Extended helpers for new features
// ---------------------------------------------------------------------------
const HERMES_HOME = join(homedir(), ".hermes");
const GUI_SESSIONS_DIR = join(homedir(), ".hermes-agent-gui", "sessions");
const GUI_SESSION_META = join(GUI_SESSIONS_DIR, "session_meta.json");
const CRON_JOBS_FILE = join(HERMES_HOME, "cron", "jobs.json");
const MEMORY_FILE = join(HERMES_HOME, "memory", "MEMORY.md");
const USER_FILE = join(HERMES_HOME, "memory", "USER.md");
const PROFILES_DIR = join(HERMES_HOME, "profiles");
const SPACES_FILE = join(APP_DATA_DIR, "spaces.json");

function getStateDb(): Database {
  return new Database(join(HERMES_HOME, "state.db"));
}

async function readJsonAsync<T = any>(path: string, fallback: T): Promise<T> {
  try {
    const text = await Bun.file(path).text();
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function loadSessionMeta(): Promise<Record<string, any>> {
  return readJsonAsync(GUI_SESSION_META, {});
}

function saveSessionMeta(meta: Record<string, any>) {
  ensureDir(GUI_SESSIONS_DIR);
  writeFileSync(GUI_SESSION_META, JSON.stringify(meta, null, 2));
}

async function runHermesCliProfile(args: string[]): Promise<any> {
  const proc = spawn({
    cmd: ["python3", "-m", "hermes_cli.main", "profile", ...args],
    cwd: hermesDir || process.cwd(),
    env: { ...process.env, HERMES_AGENT_DIR: hermesDir, HERMES_HOME },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout?.getReader();
  let out = "";
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
  }
  try {
    return JSON.parse(out);
  } catch {
    return { raw: out.trim() };
  }
}

function getCronManagerPath(): string {
  const bundled = join(import.meta.dir, "..", "python", "cron_manager.py");
  const dev = join(process.cwd(), "python", "cron_manager.py");
  return existsSync(bundled) ? bundled : dev;
}

async function runCronManager(args: string[]): Promise<any> {
  const script = getCronManagerPath();
  const proc = spawn([pythonPath, script, ...args], {
    env: { ...process.env, HERMES_AGENT_DIR: hermesDir, HERMES_HOME } as any,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderr || `cron_manager failed with code ${exitCode}`);
  }
  return JSON.parse(stdout.trim());
}

function loadSpaces(): any[] {
  try {
    const text = readFileSync(SPACES_FILE, "utf-8");
    return JSON.parse(text);
  } catch {
    return [];
  }
}

function saveSpaces(spaces: any[]) {
  ensureDir(APP_DATA_DIR);
  writeFileSync(SPACES_FILE, JSON.stringify(spaces, null, 2));
}

// ---------------------------------------------------------------------------
type RPCRequestHandler = (params: any) => Promise<any>;

function safeWorkspacePath(requested: string): string {
  const resolved = resolve(requested || HERMES_HOME);
  const home = resolve(HERMES_HOME);
  if (!resolved.startsWith(home)) {
    throw new Error("Path outside workspace");
  }
  return resolved;
}

const rpcHandlers: { requests: Record<string, RPCRequestHandler> } = {
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
        const db = getStateDb();
        const rows = db.query("SELECT id, title, started_at as created_at, ended_at as updated_at, message_count FROM sessions ORDER BY updated_at DESC").all() as any[];
        db.close();
        const meta = await loadSessionMeta();
        return rows.map((r) => {
          const m = meta[r.id] || {};
          return {
            id: r.id,
            key: r.id,
            display_name: m.display_name || r.title || r.id.slice(0, 8),
            updated_at: r.updated_at ? new Date(r.updated_at * 1000).toISOString() : "",
            created_at: r.created_at ? new Date(r.created_at * 1000).toISOString() : "",
            message_count: r.message_count || 0,
            pinned: !!m.pinned,
            archived: !!m.archived,
            tags: m.tags || [],
          };
        });
      } catch (e: any) {
        console.error("listSessions failed:", e);
        return [];
      }
    },

    loadSession: async ({ sessionId }) => {
      try {
        const db = getStateDb();
        const rows = db.query("SELECT role, content, timestamp, reasoning FROM messages WHERE session_id = ? ORDER BY timestamp").all(sessionId) as any[];
        db.close();
        return rows.map((r) => ({
          role: r.role,
          content: r.content || "",
          created_at: r.timestamp ? new Date(r.timestamp * 1000).toISOString() : "",
          reasoning: r.reasoning || undefined,
        }));
      } catch (e: any) {
        console.error("loadSession failed:", e);
        return [];
      }
    },

    renameSession: async ({ sessionId, name }) => {
      const meta = await loadSessionMeta();
      meta[sessionId] = { ...(meta[sessionId] || {}), display_name: name };
      saveSessionMeta(meta);
      try {
        const db = getStateDb();
        db.query("UPDATE sessions SET title = ? WHERE id = ?").run(name, sessionId);
        db.close();
      } catch {}
      return { success: true };
    },

    deleteSession: async ({ sessionId }) => {
      try {
        const db = getStateDb();
        db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId);
        db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
        db.close();
      } catch (e) { console.error(e); }
      const meta = await loadSessionMeta();
      delete meta[sessionId];
      saveSessionMeta(meta);
      const jsonl = join(GUI_SESSIONS_DIR, sessionId + ".jsonl");
      try { if (existsSync(jsonl)) require("node:fs").unlinkSync(jsonl); } catch {}
      return { success: true };
    },

    pinSession: async ({ sessionId, pinned }) => {
      const meta = await loadSessionMeta();
      meta[sessionId] = { ...(meta[sessionId] || {}), pinned };
      saveSessionMeta(meta);
      return { success: true };
    },

    archiveSession: async ({ sessionId, archived }) => {
      const meta = await loadSessionMeta();
      meta[sessionId] = { ...(meta[sessionId] || {}), archived };
      saveSessionMeta(meta);
      return { success: true };
    },

    tagSession: async ({ sessionId, tags }) => {
      const meta = await loadSessionMeta();
      meta[sessionId] = { ...(meta[sessionId] || {}), tags: Array.isArray(tags) ? tags : [tags] };
      saveSessionMeta(meta);
      return { success: true };
    },

    listCron: async () => {
      try {
        return await runCronManager(["list"]);
      } catch (e: any) {
        console.error("listCron failed:", e);
        return { jobs: [] };
      }
    },

    runCron: async ({ jobId }) => {
      try {
        return await runCronManager(["run", jobId]);
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    pauseCron: async ({ jobId }) => {
      try {
        return await runCronManager(["pause", jobId]);
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    resumeCron: async ({ jobId }) => {
      try {
        return await runCronManager(["resume", jobId]);
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    updateCron: async ({ jobId, updates }) => {
      try {
        return await runCronManager(["update", jobId, JSON.stringify(updates || {})]);
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    deleteCron: async ({ jobId }) => {
      try {
        return await runCronManager(["delete", jobId]);
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    getCronOutput: async ({ jobId }) => {
      try {
        return await runCronManager(["output", jobId]);
      } catch (e: any) {
        return { outputs: [] };
      }
    },

    getMemory: async ({ section }) => {
      try {
        const target = section === "user" ? USER_FILE : MEMORY_FILE;
        ensureDir(join(HERMES_HOME, "memory"));
        const text = await Bun.file(target).text();
        return { content: text, path: target };
      } catch {
        return { content: "", path: section === "user" ? USER_FILE : MEMORY_FILE };
      }
    },

    saveMemory: async ({ section, content }) => {
      try {
        const target = section === "user" ? USER_FILE : MEMORY_FILE;
        ensureDir(join(HERMES_HOME, "memory"));
        writeFileSync(target, content, "utf-8");
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    listSpaces: async () => {
      try {
        return { spaces: loadSpaces() };
      } catch (e: any) {
        return { spaces: [] };
      }
    },

    addSpace: async ({ path, name }) => {
      try {
        const p = path ? resolve(path) : "";
        if (!p || !existsSync(p)) return { success: false, error: "Path does not exist" };
        const spaces = loadSpaces();
        if (spaces.some((s: any) => s.path === p)) return { success: false, error: "Already in list" };
        spaces.push({ path: p, name: name || basename(p) });
        saveSpaces(spaces);
        return { success: true, spaces };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    renameSpace: async ({ path, name }) => {
      try {
        const spaces = loadSpaces();
        const s = spaces.find((s: any) => s.path === path);
        if (!s) return { success: false, error: "Space not found" };
        s.name = name;
        saveSpaces(spaces);
        return { success: true, spaces };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    removeSpace: async ({ path }) => {
      try {
        const spaces = loadSpaces().filter((s: any) => s.path !== path);
        saveSpaces(spaces);
        return { success: true, spaces };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    getTokenUsage: async ({ sessionId }) => {
      try {
        const db = getStateDb();
        if (sessionId) {
          const row = db.query(
            "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd FROM sessions WHERE id = ?"
          ).get(sessionId) as any;
          db.close();
          if (!row) return { error: "Session not found" };
          return {
            sessionId,
            inputTokens: row.input_tokens || 0,
            outputTokens: row.output_tokens || 0,
            cacheReadTokens: row.cache_read_tokens || 0,
            cacheWriteTokens: row.cache_write_tokens || 0,
            reasoningTokens: row.reasoning_tokens || 0,
            estimatedCost: row.estimated_cost_usd || 0,
            actualCost: row.actual_cost_usd || 0,
          };
        } else {
          const row = db.query(
            `SELECT SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens, SUM(cache_read_tokens) as cache_read_tokens, SUM(cache_write_tokens) as cache_write_tokens, SUM(reasoning_tokens) as reasoning_tokens, SUM(estimated_cost_usd) as estimated_cost_usd, SUM(actual_cost_usd) as actual_cost_usd FROM sessions`
          ).get() as any;
          db.close();
          return {
            inputTokens: row.input_tokens || 0,
            outputTokens: row.output_tokens || 0,
            cacheReadTokens: row.cache_read_tokens || 0,
            cacheWriteTokens: row.cache_write_tokens || 0,
            reasoningTokens: row.reasoning_tokens || 0,
            estimatedCost: row.estimated_cost_usd || 0,
            actualCost: row.actual_cost_usd || 0,
          };
        }
      } catch (e: any) {
        console.error("getTokenUsage failed:", e);
        return { error: e.message };
      }
    },

    duplicateSession: async ({ sessionId }) => {
      try {
        const db = getStateDb();
        const sess = db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
        if (!sess) { db.close(); return { error: "Session not found" }; }
        const msgs = db.query("SELECT role, content, timestamp, reasoning FROM messages WHERE session_id = ? ORDER BY timestamp").all(sessionId) as any[];
        const newId = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        db.query(`
          INSERT INTO sessions (id, source, user_id, model, system_prompt, started_at, ended_at, message_count, input_tokens, output_tokens, title)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newId, sess.source || "gui", sess.user_id || "", sess.model || "", sess.system_prompt || "", now, now, msgs.length, sess.input_tokens || 0, sess.output_tokens || 0, (sess.title || "Untitled") + " (Copy)");
        for (const m of msgs) {
          db.query("INSERT INTO messages (session_id, role, content, timestamp, reasoning) VALUES (?, ?, ?, ?, ?)").run(newId, m.role, m.content || "", m.timestamp || now, m.reasoning || "");
        }
        db.close();
        const meta = await loadSessionMeta();
        const oldMeta = meta[sessionId] || {};
        meta[newId] = { ...oldMeta, display_name: (oldMeta.display_name || sess.title || "Untitled") + " (Copy)" };
        saveSessionMeta(meta);
        return { success: true, newSessionId: newId };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    exportSession: async ({ sessionId }) => {
      try {
        const db = getStateDb();
        const sess = db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
        if (!sess) { db.close(); return { error: "Session not found" }; }
        const msgs = db.query("SELECT role, content, timestamp, reasoning FROM messages WHERE session_id = ? ORDER BY timestamp").all(sessionId) as any[];
        db.close();
        const meta = await loadSessionMeta();
        const m = meta[sessionId] || {};
        return {
          title: m.display_name || sess.title || "Untitled",
          workspace: sess.workspace || HERMES_HOME,
          model: sess.model || "",
          pinned: !!m.pinned,
          archived: !!m.archived,
          tags: m.tags || [],
          messages: msgs.map((m2) => ({
            role: m2.role,
            content: m2.content || "",
            timestamp: m2.timestamp,
            reasoning: m2.reasoning,
          })),
        };
      } catch (e: any) {
        return { error: e.message };
      }
    },

    importSession: async ({ data }) => {
      try {
        const payload = typeof data === "string" ? JSON.parse(data) : data;
        if (!Array.isArray(payload.messages)) return { error: "Invalid format: messages array required" };
        const newId = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        const title = payload.title || "Imported session";
        const db = getStateDb();
        db.query(`
          INSERT INTO sessions (id, source, user_id, model, system_prompt, started_at, ended_at, message_count, title)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newId, "gui", "", payload.model || "", "", now, now, payload.messages.length, title);
        for (const m of payload.messages) {
          db.query("INSERT INTO messages (session_id, role, content, timestamp, reasoning) VALUES (?, ?, ?, ?, ?)").run(newId, m.role, m.content || "", m.timestamp || now, m.reasoning || "");
        }
        db.close();
        const meta = await loadSessionMeta();
        meta[newId] = { display_name: title, pinned: !!payload.pinned, archived: !!payload.archived, tags: Array.isArray(payload.tags) ? payload.tags : [] };
        saveSessionMeta(meta);
        return { success: true, newSessionId: newId };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    listProfiles: async () => {
      try {
        const proc = spawn({
          cmd: ["python3", "-m", "hermes_cli.main", "profile", "list"],
          cwd: hermesDir || process.cwd(),
          env: { ...process.env, HERMES_AGENT_DIR: hermesDir, HERMES_HOME },
          stdout: "pipe",
          stderr: "pipe",
        });
        const reader = proc.stdout?.getReader();
        let out = "";
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            out += new TextDecoder().decode(value);
          }
        }
        // Parse lines like "  default   [active]"
        const profiles: any[] = [];
        for (const line of out.split("\n")) {
          const m = line.match(/^\s+([\w-]+)(.*)$/);
          if (m) {
            profiles.push({ name: m[1], active: m[2].includes("active") });
          }
        }
        return { profiles };
      } catch {
        return { profiles: [] };
      }
    },

    switchProfile: async ({ name }) => {
      try {
        const proc = spawn({
          cmd: ["python3", "-m", "hermes_cli.main", "profile", "use", name],
          cwd: hermesDir || process.cwd(),
          env: { ...process.env, HERMES_AGENT_DIR: hermesDir, HERMES_HOME },
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    createProfile: async ({ name, cloneFrom }) => {
      try {
        const args = ["create", name];
        if (cloneFrom) args.push("--clone-from", cloneFrom);
        const proc = spawn({
          cmd: ["python3", "-m", "hermes_cli.main", "profile", ...args],
          cwd: hermesDir || process.cwd(),
          env: { ...process.env, HERMES_AGENT_DIR: hermesDir, HERMES_HOME },
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    deleteProfile: async ({ name }) => {
      try {
        const proc = spawn({
          cmd: ["python3", "-m", "hermes_cli.main", "profile", "delete", name, "-y"],
          cwd: hermesDir || process.cwd(),
          env: { ...process.env, HERMES_AGENT_DIR: hermesDir, HERMES_HOME },
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    renameProfile: async ({ oldName, newName }) => {
      try {
        const proc = spawn({
          cmd: ["python3", "-m", "hermes_cli.main", "profile", "rename", oldName, newName],
          cwd: hermesDir || process.cwd(),
          env: { ...process.env, HERMES_AGENT_DIR: hermesDir, HERMES_HOME },
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    listWorkspace: async ({ path: requestedPath, sessionId }) => {
      try {
        let base = HERMES_HOME;
        if (sessionId) {
          const db = getStateDb();
          const row = db.query("SELECT workspace FROM sessions WHERE id = ?").get(sessionId) as any;
          db.close();
          if (row?.workspace) base = row.workspace;
        }
        const dir = resolve(join(base, requestedPath || "."));
        safeWorkspacePath(dir);
        const entries = readdirSync(dir).map((name) => {
          const full = join(dir, name);
          const s = statSync(full);
          return { name, path: full, relPath: join(requestedPath || ".", name), isDirectory: s.isDirectory() };
        });
        return { entries, path: requestedPath || "." };
      } catch (e: any) {
        return { entries: [], error: e.message };
      }
    },

    readWorkspaceFile: async ({ path: requestedPath, sessionId }) => {
      try {
        let base = HERMES_HOME;
        if (sessionId) {
          const db = getStateDb();
          const row = db.query("SELECT workspace FROM sessions WHERE id = ?").get(sessionId) as any;
          db.close();
          if (row?.workspace) base = row.workspace;
        }
        const target = resolve(join(base, requestedPath || "."));
        safeWorkspacePath(target);
        if (!existsSync(target) || statSync(target).isDirectory()) {
          return { error: "File not found" };
        }
        const content = readFileSync(target, "utf-8");
        return { content, path: requestedPath };
      } catch (e: any) {
        return { error: e.message };
      }
    },

    saveWorkspaceFile: async ({ path: requestedPath, content, sessionId }) => {
      try {
        let base = HERMES_HOME;
        if (sessionId) {
          const db = getStateDb();
          const row = db.query("SELECT workspace FROM sessions WHERE id = ?").get(sessionId) as any;
          db.close();
          if (row?.workspace) base = row.workspace;
        }
        const target = resolve(join(base, requestedPath || "."));
        safeWorkspacePath(target);
        ensureDir(join(target, ".."));
        writeFileSync(target, content, "utf-8");
        return { success: true, path: requestedPath };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    renameWorkspaceFile: async ({ path: requestedPath, newName, sessionId }) => {
      try {
        let base = HERMES_HOME;
        if (sessionId) {
          const db = getStateDb();
          const row = db.query("SELECT workspace FROM sessions WHERE id = ?").get(sessionId) as any;
          db.close();
          if (row?.workspace) base = row.workspace;
        }
        const source = resolve(join(base, requestedPath || "."));
        safeWorkspacePath(source);
        if (!existsSync(source)) return { success: false, error: "File not found" };
        const safeName = basename(newName).replace(/[^a-zA-Z0-9._-]/g, "_");
        const dest = join(source, "..", safeName);
        safeWorkspacePath(dest);
        if (existsSync(dest)) return { success: false, error: "Destination already exists" };
        require("node:fs").renameSync(source, dest);
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    deleteWorkspaceFile: async ({ path: requestedPath, sessionId }) => {
      try {
        let base = HERMES_HOME;
        if (sessionId) {
          const db = getStateDb();
          const row = db.query("SELECT workspace FROM sessions WHERE id = ?").get(sessionId) as any;
          db.close();
          if (row?.workspace) base = row.workspace;
        }
        const target = resolve(join(base, requestedPath || "."));
        safeWorkspacePath(target);
        if (!existsSync(target)) return { success: false, error: "File not found" };
        const s = statSync(target);
        if (s.isDirectory()) {
          rmdirSync(target);
        } else {
          unlinkSync(target);
        }
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    createWorkspaceDir: async ({ path: requestedPath, sessionId }) => {
      try {
        let base = HERMES_HOME;
        if (sessionId) {
          const db = getStateDb();
          const row = db.query("SELECT workspace FROM sessions WHERE id = ?").get(sessionId) as any;
          db.close();
          if (row?.workspace) base = row.workspace;
        }
        const target = resolve(join(base, requestedPath || "."));
        safeWorkspacePath(target);
        mkdirSync(target, { recursive: true });
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    getGitInfo: async ({ sessionId }) => {
      try {
        let base = HERMES_HOME;
        if (sessionId) {
          const db = getStateDb();
          const row = db.query("SELECT workspace FROM sessions WHERE id = ?").get(sessionId) as any;
          db.close();
          if (row?.workspace) base = row.workspace;
        }
        const { spawnSync } = require("node:child_process");
        const branchRes = spawnSync("git", ["-C", base, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" });
        const dirtyRes = spawnSync("git", ["-C", base, "status", "--short"], { encoding: "utf-8" });
        const branch = branchRes.status === 0 ? branchRes.stdout.trim() : null;
        const dirtyCount = dirtyRes.status === 0 ? dirtyRes.stdout.trim().split("\n").filter((l: string) => l.trim()).length : 0;
        return { branch, dirtyCount };
      } catch (e: any) {
        return { branch: null, dirtyCount: 0 };
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
  },
  messages: {},
};

// ---------------------------------------------------------------------------
// Static + RPC HTTP server (serves frontend and handles RPC for PyQt shell)
// ---------------------------------------------------------------------------
const WEB_DIR = join(process.cwd(), "src", "mainview");

function mimeType(pathname: string): string {
  if (pathname.endsWith(".html")) return "text/html";
  if (pathname.endsWith(".js")) return "application/javascript";
  if (pathname.endsWith(".css")) return "text/css";
  if (pathname.endsWith(".json")) return "application/json";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

const HTTP_RPC_PORT = 55000;
try {
  Bun.serve({
    port: HTTP_RPC_PORT,
    async fetch(req) {
        const url = new URL(req.url);
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        };

        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        // API proxy to Python backend
        if (url.pathname.startsWith("/api/")) {
          const targetUrl = `http://127.0.0.1:${BACKEND_PORT}${url.pathname.replace("/api", "")}${url.search}`;
          try {
            const proxyRes = await fetch(targetUrl, { method: req.method, headers: req.headers, body: req.body });
            const body = await proxyRes.arrayBuffer();
            return new Response(body, { status: proxyRes.status, headers: { "Content-Type": proxyRes.headers.get("content-type") || "application/json", ...corsHeaders } });
          } catch (e: any) {
            return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 502, headers: corsHeaders });
          }
        }

        // RPC endpoint
        if (url.pathname === "/rpc" && req.method === "POST") {
          try {
            const body = (await req.json()) as any;
            const { type, id, method, params } = body;
            if (type === "request" && method) {
              const handlerFn = (rpcHandlers.requests as any)[method];
              if (typeof handlerFn === "function") {
                const result = await handlerFn(params);
                return new Response(JSON.stringify({ type: "response", id, result }), {
                  headers: { "Content-Type": "application/json", ...corsHeaders },
                });
              }
              return new Response(
                JSON.stringify({ type: "response", id, error: "Method not found" }),
                { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
              );
            }
            return new Response(JSON.stringify({ type: "response", id, error: "Invalid body" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          } catch (e: any) {
            return new Response(
              JSON.stringify({ type: "response", error: e?.message || String(e) }),
              { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }
        }

        // Static files
        let target = join(WEB_DIR, url.pathname === "/" ? "index.html" : url.pathname);
        if (!existsSync(target)) {
          target = join(WEB_DIR, "index.html");
        }
        const file = Bun.file(target);
        if (await file.exists()) {
          return new Response(file, { headers: { "Content-Type": mimeType(target), ...corsHeaders } });
        }
        return new Response("Not found", { status: 404, headers: corsHeaders });
      },
    });
  console.log("[HTTP Server] listening on http://127.0.0.1:", HTTP_RPC_PORT);
} catch (e: any) {
  console.error("[HTTP Server] failed to start on port 55000:", e?.message || String(e));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Backend service auto-start
// ---------------------------------------------------------------------------
console.log(`${APP_NAME} backend service starting...`);
bootstrapApp();

// Graceful shutdown on SIGTERM/SIGINT
process.on("SIGTERM", async () => {
  await stopBackend();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await stopBackend();
  process.exit(0);
});
