import { Electroview, type RPCSchema } from "electrobun/view";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface InstallStatusPayload {
  phase: "detecting" | "not_installed" | "installing" | "needs_config" | "ready" | "error";
  progress?: number;
  message?: string;
  canCancel?: boolean;
  canRetry?: boolean;
  errorCode?: string;
}

interface SetupFieldDef {
  id: string;
  label: string;
  type: "text" | "password" | "select" | "checkbox";
  required: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
  defaultValue?: string;
  helpText?: string;
}

// ---------------------------------------------------------------------------
// RPC Schema
// ---------------------------------------------------------------------------
type AppRPCSchema = {
  bun: RPCSchema<{
    requests: {
      detectInstallation: { params: {}; response: { installed: boolean; path?: string } };
      startInstallation: { params: { confirm: boolean }; response: { success: boolean; errorMessage?: string } };
      cancelInstallation: { params: {}; response: { success: boolean } };
      getSetupFields: { params: {}; response: { fields: SetupFieldDef[]; values: Record<string, string> } };
      submitSetupConfig: { params: Record<string, string>; response: { success: boolean; errors?: { fieldId: string; message: string }[] } };
      openExternal: { params: { url: string }; response: void };
      navigateTo: { params: { url: string }; response: void };
    };
    messages: {
      installStatus: InstallStatusPayload;
      installLog: { stream: "stdout" | "stderr"; text: string };
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
};

const rpc = Electroview.defineRPC<AppRPCSchema>({
  maxRequestTime: 60000,
  handlers: {
    requests: {},
    messages: {
      installStatus: (status: InstallStatusPayload) => handleInstallStatus(status),
      installLog: (msg: { stream: "stdout" | "stderr"; text: string }) => appendInstallLog(msg),
    },
  },
});

new Electroview({ rpc });

// ---------------------------------------------------------------------------
// DOM Helpers
// ---------------------------------------------------------------------------
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const escapeHtml = (text: string) => {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentPhase: InstallStatusPayload["phase"] = "detecting";

// ---------------------------------------------------------------------------
// Panel switching
// ---------------------------------------------------------------------------
function showPanel(phase: InstallStatusPayload["phase"]) {
  currentPhase = phase;
  const panels = ["detecting", "not_installed", "installing", "needs_config", "ready", "error"];
  for (const p of panels) {
    const el = $(`#panel-${p}`);
    if (el) el.classList.toggle("hidden", p !== phase);
  }

  if (phase === "ready") {
    // Ask Bun process to navigate to main chat view
    rpc.request.navigateTo({ url: "views://mainview/index.html" });
  }
}

// ---------------------------------------------------------------------------
// Install status handler
// ---------------------------------------------------------------------------
function handleInstallStatus(status: InstallStatusPayload) {
  showPanel(status.phase);

  if (status.phase === "installing") {
    const msgEl = $("#install-message");
    const barEl = $("#install-progress") as HTMLDivElement | null;
    if (msgEl) msgEl.textContent = status.message || "Installing...";
    if (barEl) barEl.style.width = `${status.progress ?? 0}%`;
  }

  if (status.phase === "error") {
    renderErrorPanel(status);
  }

  if (status.phase === "needs_config") {
    loadSetupForm();
  }
}

// ---------------------------------------------------------------------------
// Error panel rendering (T9: differentiated by errorCode)
// ---------------------------------------------------------------------------
const MANUAL_COMMAND = `git clone https://github.com/DaviRain-Su/hermes-agent.git ~/.hermes/hermes-agent\ncd ~/.hermes/hermes-agent\nbash scripts/install.sh`;

function renderErrorPanel(status: InstallStatusPayload) {
  const code = status.errorCode || "UNKNOWN";
  const titleEl = $("#error-title");
  const msgEl = $("#error-message");
  const hintEl = $("#error-hint");
  const iconEl = $("#error-icon");
  const retryBtn = $("#btn-retry");
  const manualBtn = $("#btn-manual-error");
  const copyBtn = $("#btn-copy-command");

  // Reset visibility
  retryBtn?.classList.remove("hidden");
  manualBtn?.classList.remove("hidden");
  copyBtn?.classList.add("hidden");
  $("#manual-steps-error")?.classList.add("hidden");

  if (iconEl) iconEl.textContent = "❌";

  switch (code) {
    case "DOWNLOAD_FAILED":
      if (titleEl) titleEl.textContent = "Network Error";
      if (msgEl) msgEl.textContent = status.message || "无法下载安装脚本，请检查网络连接。";
      if (hintEl) {
        hintEl.textContent = "可以尝试重试，或复制下方命令手动安装。";
        hintEl.classList.remove("hidden");
      }
      break;

    case "SCRIPT_EXEC_FAILED":
      if (titleEl) titleEl.textContent = "Install Script Failed";
      if (msgEl) msgEl.textContent = status.message || "安装脚本执行失败，点击查看日志。";
      if (hintEl) {
        hintEl.textContent = "请查看下方日志排查问题，或复制命令到终端手动执行。";
        hintEl.classList.remove("hidden");
      }
      if (copyBtn) {
        copyBtn.classList.remove("hidden");
        copyBtn.textContent = "Copy Command";
      }
      break;

    case "PERMISSION_DENIED":
      if (titleEl) titleEl.textContent = "Permission Denied";
      if (msgEl) msgEl.textContent = status.message || "写入目录失败，请检查磁盘权限。";
      if (hintEl) {
        hintEl.textContent = "请确保对 ~/.hermes 有写入权限，或选择其他目录后手动安装。";
        hintEl.classList.remove("hidden");
      }
      if (retryBtn) retryBtn.classList.add("hidden");
      if (copyBtn) {
        copyBtn.classList.remove("hidden");
        copyBtn.textContent = "Copy Command";
      }
      break;

    case "TIMEOUT":
      if (titleEl) titleEl.textContent = "Installation Timeout";
      if (msgEl) msgEl.textContent = status.message || "安装超时，可能是网络较慢。";
      if (hintEl) {
        hintEl.textContent = "网络状况不佳时建议稍后重试，或使用命令行离线安装。";
        hintEl.classList.remove("hidden");
      }
      break;

    case "CANCELLED":
      if (titleEl) titleEl.textContent = "Installation Cancelled";
      if (msgEl) msgEl.textContent = "安装已取消。";
      if (hintEl) {
        hintEl.textContent = "您可以随时重新启动自动安装流程。";
        hintEl.classList.remove("hidden");
      }
      if (manualBtn) manualBtn.classList.add("hidden");
      break;

    case "UNKNOWN":
    default:
      if (titleEl) titleEl.textContent = "Something Went Wrong";
      if (msgEl) msgEl.textContent = status.message || "Installation failed.";
      if (hintEl) {
        hintEl.textContent = "请重试自动安装，或参考手动安装步骤。";
        hintEl.classList.remove("hidden");
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------
function appendInstallLog(msg: { stream: "stdout" | "stderr"; text: string }) {
  const logsEl = $("#install-logs");
  const errorLogsEl = $("#error-logs");
  const target = currentPhase === "error" ? errorLogsEl : logsEl;
  if (!target) return;

  const line = document.createElement("div");
  line.className = msg.stream === "stderr" ? "log-stderr" : "log-stdout";
  line.innerHTML = escapeHtml(msg.text);
  target.appendChild(line);
  target.scrollTop = target.scrollHeight;
}

// ---------------------------------------------------------------------------
// Setup form
// ---------------------------------------------------------------------------
async function loadSetupForm() {
  const container = $("#form-fields");
  if (!container) return;

  try {
    const { fields, values } = await rpc.request.getSetupFields({});
    container.innerHTML = "";

    for (const field of fields) {
      const group = document.createElement("div");
      group.className = "form-group";
      group.dataset.fieldId = field.id;

      const label = document.createElement("label");
      label.textContent = field.label;
      group.appendChild(label);

      let input: HTMLInputElement | HTMLSelectElement;
      if (field.type === "select") {
        input = document.createElement("select");
        for (const opt of field.options || []) {
          const option = document.createElement("option");
          option.value = opt.value;
          option.textContent = opt.label;
          input.appendChild(option);
        }
      } else {
        input = document.createElement("input");
        input.type = field.type;
      }

      input.name = field.id;
      input.value = values[field.id] || field.defaultValue || "";
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.required) input.required = true;

      group.appendChild(input);

      if (field.helpText) {
        const help = document.createElement("div");
        help.className = "help-text";
        help.textContent = field.helpText;
        group.appendChild(help);
      }

      container.appendChild(group);
    }
  } catch (e) {
    container.innerHTML = `<p style="color:#ef4444">Failed to load setup fields.</p>`;
    console.error(e);
  }
}

async function submitForm(e: Event) {
  e.preventDefault();
  const form = $("#setup-form") as HTMLFormElement | null;
  if (!form) return;

  // Clear previous errors
  $$<HTMLDivElement>(".form-group").forEach((g) => g.classList.remove("error"));
  $$<HTMLDivElement>(".field-error").forEach((el) => el.remove());
  const formError = $("#form-error");
  if (formError) formError.classList.add("hidden");

  const values: Record<string, string> = {};
  const data = new FormData(form);
  for (const [k, v] of data.entries()) {
    values[k] = String(v);
  }

  try {
    const res = await rpc.request.submitSetupConfig(values);
    if (!res.success && res.errors) {
      for (const err of res.errors) {
        if (err.fieldId === "_general") {
          if (formError) {
            formError.textContent = err.message;
            formError.classList.remove("hidden");
          }
        } else {
          const group = $(`.form-group[data-field-id="${err.fieldId}"]`);
          if (group) {
            group.classList.add("error");
            const errDiv = document.createElement("div");
            errDiv.className = "field-error";
            errDiv.textContent = err.message;
            group.appendChild(errDiv);
          }
        }
      }
    }
    // On success, the backend will push "ready" status and we will navigate.
  } catch (err: any) {
    if (formError) {
      formError.textContent = err.message || "Failed to save configuration.";
      formError.classList.remove("hidden");
    }
  }
}

// ---------------------------------------------------------------------------
// Event bindings
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  // Install actions
  $("#btn-install")?.addEventListener("click", async () => {
    $("#install-logs") && ($("#install-logs").innerHTML = "");
    try {
      await rpc.request.startInstallation({ confirm: true });
    } catch (e) {
      console.error(e);
    }
  });

  $("#btn-manual")?.addEventListener("click", () => {
    const el = $("#manual-steps");
    if (el) el.classList.toggle("hidden");
  });

  $("#btn-cancel")?.addEventListener("click", async () => {
    try {
      await rpc.request.cancelInstallation({});
    } catch (e) {
      console.error(e);
    }
  });

  // Error actions
  $("#btn-retry")?.addEventListener("click", async () => {
    $("#error-logs") && ($("#error-logs").innerHTML = "");
    try {
      await rpc.request.startInstallation({ confirm: true });
    } catch (e) {
      console.error(e);
    }
  });

  $("#btn-manual-error")?.addEventListener("click", () => {
    const el = $("#manual-steps-error");
    if (el) el.classList.toggle("hidden");
  });

  $("#btn-copy-command")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(MANUAL_COMMAND);
      const btn = $("#btn-copy-command");
      if (btn) {
        const old = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = old), 1500);
      }
    } catch {
      // ignore
    }
  });

  // Form submit
  $("#setup-form")?.addEventListener("submit", submitForm);

  // External link
  $("#link-external")?.addEventListener("click", (e) => {
    e.preventDefault();
    rpc.request.openExternal({ url: "https://github.com/DaviRain-Su/hermes-agent" });
  });
});

function $$<T extends Element>(sel: string): NodeListOf<T> {
  return document.querySelectorAll(sel) as NodeListOf<T>;
}
