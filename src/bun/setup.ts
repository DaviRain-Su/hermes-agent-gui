import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface SetupFieldDef {
  id: string;
  label: string;
  type: "text" | "password" | "select" | "checkbox";
  required: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
  defaultValue?: string;
  helpText?: string;
}

export interface SubmitSetupResult {
  success: boolean;
  writtenTo: string[];
  errors?: { fieldId: string; message: string }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GUI_HOME = join(homedir(), ".hermes-agent-gui");
const CONFIG_PATH = join(GUI_HOME, "config.yaml");
const ENV_PATH = join(GUI_HOME, ".env");

const DEFAULT_FIELDS: SetupFieldDef[] = [
  {
    id: "provider",
    label: "Model Provider",
    type: "select",
    required: true,
    defaultValue: "kimi-coding",
    helpText: "Select the service that hosts your AI model.",
    options: [
      { label: "Kimi (Moonshot) (recommended)", value: "kimi-coding" },
      { label: "OpenRouter", value: "openrouter" },
      { label: "Anthropic", value: "anthropic" },
      { label: "OpenAI", value: "openai" },
      { label: "Google Gemini", value: "gemini" },
      { label: "GitHub Copilot", value: "copilot" },
      { label: "OpenCode", value: "opencode" },
      { label: "DeepSeek", value: "deepseek" },
      { label: "xAI (Grok)", value: "xai" },
      { label: "Z.AI (GLM)", value: "zai" },
      { label: "MiniMax", value: "minimax" },
    ],
  },
  {
    id: "model",
    label: "Default Model",
    type: "text",
    required: true,
    defaultValue: "kimi-k2.5",
    placeholder: "e.g. kimi-k2.5",
    helpText: "The model ID used for conversations.",
  },
  {
    id: "api_key",
    label: "API Key",
    type: "password",
    required: true,
    placeholder: "sk-...",
    helpText: "Your provider API key. Stored locally in ~/.hermes-agent-gui/.env",
  },
  {
    id: "base_url",
    label: "Base URL (optional)",
    type: "text",
    required: false,
    placeholder: "https://api.moonshot.cn/v1",
    helpText: "Only needed for custom or local endpoints.",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadYaml(path: string): any {
  try {
    const yaml = require("js-yaml");
    if (existsSync(path)) {
      const content = require("node:fs").readFileSync(path, "utf-8");
      return yaml.load(content) || {};
    }
  } catch {
    // ignore
  }
  return {};
}

function dumpYaml(obj: any): string {
  const yaml = require("js-yaml");
  return yaml.dump(obj, { lineWidth: -1, sortKeys: false });
}

function loadEnv(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(path)) return result;
  const content = require("node:fs").readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  return result;
}

function saveEnv(path: string, values: Record<string, string>) {
  const lines = ["# Hermes Agent GUI environment\n"];
  for (const [k, v] of Object.entries(values)) {
    if (v) lines.push(`${k}=${v}`);
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function getSetupFields(): { fields: SetupFieldDef[]; values: Record<string, string> } {
  const cfg = loadYaml(CONFIG_PATH);
  const env = loadEnv(ENV_PATH);

  const provider = cfg.model?.provider || env.HERMES_PROVIDER || "kimi-coding";
  const values: Record<string, string> = {
    provider,
    model: cfg.model?.default || env.HERMES_MODEL || "kimi-k2.5",
    api_key: cfg.providers?.[provider]?.api_key || env.HERMES_API_KEY || "",
    base_url: cfg.providers?.[provider]?.base_url || env.HERMES_BASE_URL || "",
  };

  return { fields: DEFAULT_FIELDS, values };
}

export function checkNeedsConfig(): boolean {
  const { values } = getSetupFields();
  return !values.api_key || !values.model;
}

export function submitSetupConfig(input: Record<string, string>): SubmitSetupResult {
  const errors: { fieldId: string; message: string }[] = [];

  // Validation
  if (!input.provider) errors.push({ fieldId: "provider", message: "Provider is required." });
  if (!input.model?.trim()) errors.push({ fieldId: "model", message: "Model is required." });
  if (!input.api_key?.trim()) errors.push({ fieldId: "api_key", message: "API key is required." });

  if (errors.length > 0) {
    return { success: false, writtenTo: [], errors };
  }

  const writtenTo: string[] = [];

  // Ensure directory exists before writing
  try {
    mkdirSync(GUI_HOME, { recursive: true });
  } catch (e: any) {
    return { success: false, writtenTo, errors: [{ fieldId: "_general", message: e.message }] };
  }

  // Write config.yaml
  try {
    const cfg = loadYaml(CONFIG_PATH);
    cfg.model = {
      provider: input.provider,
      default: input.model,
    };

    if (!cfg.providers) cfg.providers = {};
    cfg.providers[input.provider] = {
      api_key: input.api_key,
    };
    if (input.base_url?.trim()) {
      cfg.providers[input.provider].base_url = input.base_url.trim();
    }

    // Strip other platforms if they were auto-imported from default home
    if (cfg.platforms && typeof cfg.platforms === "object") {
      cfg.platforms = Object.fromEntries(
        Object.entries(cfg.platforms).filter(([k]) => k === "api_server")
      );
    }

    writeFileSync(CONFIG_PATH, dumpYaml(cfg), "utf-8");
    writtenTo.push(CONFIG_PATH);
  } catch (e: any) {
    return { success: false, writtenTo, errors: [{ fieldId: "_general", message: e.message }] };
  }

  // Write .env fallback
  try {
    saveEnv(ENV_PATH, {
      HERMES_PROVIDER: input.provider,
      HERMES_MODEL: input.model,
      HERMES_API_KEY: input.api_key,
      GATEWAY_ALLOW_ALL_USERS: "true",
      ...(input.base_url?.trim() ? { HERMES_BASE_URL: input.base_url.trim() } : {}),
    });
    writtenTo.push(ENV_PATH);
  } catch (e: any) {
    return { success: false, writtenTo, errors: [{ fieldId: "_general", message: e.message }] };
  }

  return { success: true, writtenTo };
}
