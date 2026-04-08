import { existsSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Subprocess, spawn } from "bun";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/DaviRain-Su/hermes-agent/main/scripts/install.sh";

function getSearchPaths(): string[] {
  return [
    process.env.HERMES_AGENT_DIR,
    join(homedir(), ".hermes", "hermes-agent"),
    join(homedir(), "dev", "active", "hermes-agent"),
    join(homedir(), "dev", "hermes-agent"),
    join(homedir(), "Projects", "hermes-agent"),
    join(homedir(), "hermes-agent"),
  ].filter(Boolean) as string[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface DetectInstallationResult {
  installed: boolean;
  path?: string;
  version?: string;
  source?: "auto_detect" | "env_var" | "manual";
}

export type InstallErrorCode =
  | "ALREADY_INSTALLED"
  | "DOWNLOAD_FAILED"
  | "SCRIPT_EXEC_FAILED"
  | "PERMISSION_DENIED"
  | "CANCELLED"
  | "TIMEOUT"
  | "UNKNOWN";

export interface StartInstallationResult {
  success: boolean;
  errorCode?: InstallErrorCode;
  errorMessage?: string;
}

export type InstallLogHandler = (stream: "stdout" | "stderr", text: string) => void;
export type InstallStatusHandler = (status: { phase: string; message?: string; progress?: number }) => void;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let installProcess: Subprocess | null = null;
let installLogBuffer: string[] = [];
let isCancelled = false;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
export function detectInstallation(): DetectInstallationResult {
  for (const path of getSearchPaths()) {
    const resolved = resolve(path);
    if (existsSync(join(resolved, "gateway", "run.py"))) {
      const source = path === process.env.HERMES_AGENT_DIR ? "env_var" : "auto_detect";
      return { installed: true, path: resolved, source };
    }
  }
  return { installed: false };
}

// ---------------------------------------------------------------------------
// Download install.sh
// ---------------------------------------------------------------------------
async function downloadInstallScript(): Promise<string> {
  const resp = await fetch(INSTALL_SCRIPT_URL);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const text = await resp.text();
  if (!text.trim().startsWith("#!/")) {
    throw new Error("Downloaded script does not start with a shebang.");
  }

  const tmpPath = join("/tmp", `hermes-install-${Date.now()}.sh`);
  writeFileSync(tmpPath, text, "utf-8");
  chmodSync(tmpPath, 0o755);
  return tmpPath;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------
function classifyInstallError(exitCode: number | null, stderr: string): { code: InstallErrorCode; message: string } {
  const lowerErr = stderr.toLowerCase();

  if (isCancelled) {
    return { code: "CANCELLED", message: "Installation was cancelled by user." };
  }

  if (lowerErr.includes("permission denied") || lowerErr.includes("eacces")) {
    return { code: "PERMISSION_DENIED", message: "Permission denied while writing files. Check your home directory permissions." };
  }

  if (lowerErr.includes("curl") && (lowerErr.includes("could not resolve") || lowerErr.includes("failed to connect"))) {
    return { code: "DOWNLOAD_FAILED", message: "Network error while downloading dependencies. Please check your connection and try again." };
  }

  if (lowerErr.includes("git") && (lowerErr.includes("unable to access") || lowerErr.includes("connection refused"))) {
    return { code: "DOWNLOAD_FAILED", message: "Could not clone hermes-agent repository. Please check your network or try manual installation." };
  }

  if (lowerErr.includes("timeout") || lowerErr.includes("timed out")) {
    return { code: "TIMEOUT", message: "Installation timed out. This may be due to a slow network connection." };
  }

  if (exitCode !== null && exitCode !== 0) {
    return { code: "SCRIPT_EXEC_FAILED", message: `Install script exited with code ${exitCode}. See logs for details.` };
  }

  return { code: "UNKNOWN", message: "An unexpected error occurred during installation." };
}

// ---------------------------------------------------------------------------
// Execute install.sh
// ---------------------------------------------------------------------------
export async function startInstallation(
  onLog: InstallLogHandler,
  onStatus: InstallStatusHandler
): Promise<StartInstallationResult> {
  isCancelled = false;
  installLogBuffer = [];

  // Safety check: if already installed, skip
  const detection = detectInstallation();
  if (detection.installed) {
    return { success: true };
  }

  onStatus({ phase: "installing", message: "Downloading install script...", progress: 5 });

  let scriptPath: string;
  try {
    scriptPath = await downloadInstallScript();
  } catch (e: any) {
    return {
      success: false,
      errorCode: "DOWNLOAD_FAILED",
      errorMessage: `Failed to download install script: ${e.message || String(e)}`,
    };
  }

  onStatus({ phase: "installing", message: "Running install script...", progress: 10 });

  // Spawn install.sh
  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: homedir(),
  };

  // Propagate proxy settings if present
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  installProcess = spawn(["bash", scriptPath], {
    env: env as any,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const stdoutPromise = (async () => {
    const reader = installProcess?.stdout?.getReader();
    if (!reader) return;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      stdoutChunks.push(text);
      installLogBuffer.push(`[stdout] ${text}`);
      if (installLogBuffer.length > 500) installLogBuffer.shift();
      onLog("stdout", text);

      // Heuristic progress based on keywords
      const lower = text.toLowerCase();
      if (lower.includes("cloning")) onStatus({ phase: "installing", message: "Cloning repository...", progress: 30 });
      else if (lower.includes("installing")) onStatus({ phase: "installing", message: "Installing dependencies...", progress: 60 });
      else if (lower.includes("done") || lower.includes("complete")) onStatus({ phase: "installing", message: "Finalizing...", progress: 90 });
    }
  })();

  const stderrPromise = (async () => {
    const reader = installProcess?.stderr?.getReader();
    if (!reader) return;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      stderrChunks.push(text);
      installLogBuffer.push(`[stderr] ${text}`);
      if (installLogBuffer.length > 500) installLogBuffer.shift();
      onLog("stderr", text);
    }
  })();

  await Promise.all([stdoutPromise, stderrPromise]);

  const exitCode = await installProcess.exited;
  installProcess = null;

  // Cleanup temp script
  try {
    unlinkSync(scriptPath);
  } catch {
    // ignore cleanup failure
  }

  if (exitCode === 0 && !isCancelled) {
    onStatus({ phase: "installing", message: "Installation complete.", progress: 100 });
    return { success: true };
  }

  const fullStderr = stderrChunks.join("");
  const classified = classifyInstallError(exitCode, fullStderr);
  return {
    success: false,
    errorCode: classified.code,
    errorMessage: classified.message,
  };
}

export function cancelInstallation(): boolean {
  if (installProcess) {
    isCancelled = true;
    installProcess.kill(9);
    installProcess = null;
    return true;
  }
  return false;
}

export function getInstallLogs(): string[] {
  return [...installLogBuffer];
}
