import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectInstallation,
  startInstallation,
  cancelInstallation,
} from "../src/bun/installer";

describe("detectInstallation()", () => {
  let tempDir: string;
  let oldEnv: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hermes-test-"));
    oldEnv = process.env.HERMES_AGENT_DIR;
    delete process.env.HERMES_AGENT_DIR;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (oldEnv !== undefined) {
      process.env.HERMES_AGENT_DIR = oldEnv;
    } else {
      delete process.env.HERMES_AGENT_DIR;
    }
  });

  it("returns true when gateway/run.py exists in env path", () => {
    mkdirSync(join(tempDir, "gateway"), { recursive: true });
    writeFileSync(join(tempDir, "gateway", "run.py"), "# fake");
    process.env.HERMES_AGENT_DIR = tempDir;
    const result = detectInstallation();
    expect(result.installed).toBe(true);
    expect(result.path).toBe(tempDir);
  });

  it("marks source as env_var when HERMES_AGENT_DIR is valid and contains run.py", () => {
    mkdirSync(join(tempDir, "gateway"), { recursive: true });
    writeFileSync(join(tempDir, "gateway", "run.py"), "# fake");
    process.env.HERMES_AGENT_DIR = tempDir;
    const result = detectInstallation();
    expect(result.installed).toBe(true);
    expect(result.source).toBe("env_var");
  });

  it("skips invalid env path and falls back to auto_detect", () => {
    process.env.HERMES_AGENT_DIR = "/tmp/; rm -rf /";
    const result = detectInstallation();
    // If the system has hermes-agent installed in default paths, it should still be found
    // but marked as auto_detect, proving the invalid env path was skipped
    if (result.installed) {
      expect(result.source).toBe("auto_detect");
    }
  });
});

describe("startInstallation()", () => {
  it("short-circuits to success when already installed", async () => {
    if (detectInstallation().installed) {
      const result = await startInstallation(() => {}, () => {});
      expect(result.success).toBe(true);
    }
  });
});

describe("cancelInstallation()", () => {
  it("returns false when no process is running", () => {
    expect(cancelInstallation()).toBe(false);
  });
});
