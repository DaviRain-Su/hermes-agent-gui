// src/mainview/setup.ts
var RPC_ENDPOINT = "http://127.0.0.1:55000/rpc";
var rpcReqId = 0;
async function rpcRequest(method, params) {
  const id = ++rpcReqId;
  const res = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "request", id, method, params: params ?? {} })
  });
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error)
    throw new Error(body.error);
  return body.result;
}
var rpc = {
  request: new Proxy({}, {
    get: (_target, prop) => {
      return (params) => rpcRequest(String(prop), params);
    }
  }),
  send: {
    installStatus: (status) => handleInstallStatus(status),
    installLog: (msg) => appendInstallLog(msg)
  }
};
var $ = (sel) => document.querySelector(sel);
window.$ = $;
var escapeHtml = (text) => {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
};
var currentPhase = "detecting";
function showPanel(phase) {
  currentPhase = phase;
  const panels = ["detecting", "not_installed", "installing", "needs_config", "ready", "error"];
  for (const p of panels) {
    const el = $(`#panel-${p}`);
    if (el)
      el.classList.toggle("hidden", p !== phase);
  }
  if (phase === "ready") {
    location.href = "/index.html";
  }
}
function handleInstallStatus(status) {
  showPanel(status.phase);
  if (status.phase === "installing") {
    const msgEl = $("#install-message");
    const barEl = $("#install-progress");
    if (msgEl)
      msgEl.textContent = status.message || "Installing...";
    if (barEl)
      barEl.style.width = `${status.progress ?? 0}%`;
  }
  if (status.phase === "error") {
    renderErrorPanel(status);
  }
  if (status.phase === "needs_config") {
    loadSetupForm();
  }
}
var MANUAL_COMMAND = `git clone https://github.com/DaviRain-Su/hermes-agent.git ~/.hermes/hermes-agent
cd ~/.hermes/hermes-agent
bash scripts/install.sh`;
function renderErrorPanel(status) {
  const code = status.errorCode || "UNKNOWN";
  const titleEl = $("#error-title");
  const msgEl = $("#error-message");
  const hintEl = $("#error-hint");
  const iconEl = $("#error-icon");
  const retryBtn = $("#btn-retry");
  const manualBtn = $("#btn-manual-error");
  const copyBtn = $("#btn-copy-command");
  retryBtn?.classList.remove("hidden");
  manualBtn?.classList.remove("hidden");
  copyBtn?.classList.add("hidden");
  $("#manual-steps-error")?.classList.add("hidden");
  if (iconEl)
    iconEl.textContent = "❌";
  switch (code) {
    case "DOWNLOAD_FAILED":
      if (titleEl)
        titleEl.textContent = "Network Error";
      if (msgEl)
        msgEl.textContent = status.message || "无法下载安装脚本，请检查网络连接。";
      if (hintEl) {
        hintEl.textContent = "可以尝试重试，或复制下方命令手动安装。";
        hintEl.classList.remove("hidden");
      }
      break;
    case "SCRIPT_EXEC_FAILED":
      if (titleEl)
        titleEl.textContent = "Install Script Failed";
      if (msgEl)
        msgEl.textContent = status.message || "安装脚本执行失败，点击查看日志。";
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
      if (titleEl)
        titleEl.textContent = "Permission Denied";
      if (msgEl)
        msgEl.textContent = status.message || "写入目录失败，请检查磁盘权限。";
      if (hintEl) {
        hintEl.textContent = "请确保对 ~/.hermes 有写入权限，或选择其他目录后手动安装。";
        hintEl.classList.remove("hidden");
      }
      if (retryBtn)
        retryBtn.classList.add("hidden");
      if (copyBtn) {
        copyBtn.classList.remove("hidden");
        copyBtn.textContent = "Copy Command";
      }
      break;
    case "TIMEOUT":
      if (titleEl)
        titleEl.textContent = "Installation Timeout";
      if (msgEl)
        msgEl.textContent = status.message || "安装超时，可能是网络较慢。";
      if (hintEl) {
        hintEl.textContent = "网络状况不佳时建议稍后重试，或使用命令行离线安装。";
        hintEl.classList.remove("hidden");
      }
      break;
    case "CANCELLED":
      if (titleEl)
        titleEl.textContent = "Installation Cancelled";
      if (msgEl)
        msgEl.textContent = "安装已取消。";
      if (hintEl) {
        hintEl.textContent = "您可以随时重新启动自动安装流程。";
        hintEl.classList.remove("hidden");
      }
      if (manualBtn)
        manualBtn.classList.add("hidden");
      break;
    case "UNKNOWN":
    default:
      if (titleEl)
        titleEl.textContent = "Something Went Wrong";
      if (msgEl)
        msgEl.textContent = status.message || "Installation failed.";
      if (hintEl) {
        hintEl.textContent = "请重试自动安装，或参考手动安装步骤。";
        hintEl.classList.remove("hidden");
      }
      break;
  }
}
function appendInstallLog(msg) {
  const logsEl = $("#install-logs");
  const errorLogsEl = $("#error-logs");
  const target = currentPhase === "error" ? errorLogsEl : logsEl;
  if (!target)
    return;
  const line = document.createElement("div");
  line.className = msg.stream === "stderr" ? "log-stderr" : "log-stdout";
  line.innerHTML = escapeHtml(msg.text);
  target.appendChild(line);
  target.scrollTop = target.scrollHeight;
}
async function loadSetupForm() {
  const container = $("#form-fields");
  if (!container)
    return;
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
      let input;
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
      if (field.placeholder)
        input.placeholder = field.placeholder;
      if (field.required)
        input.required = true;
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
async function submitForm(e) {
  e.preventDefault();
  const form = $("#setup-form");
  if (!form)
    return;
  $$(".form-group").forEach((g) => g.classList.remove("error"));
  $$(".field-error").forEach((el) => el.remove());
  const formError = $("#form-error");
  if (formError)
    formError.classList.add("hidden");
  const values = {};
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
  } catch (err) {
    if (formError) {
      formError.textContent = err.message || "Failed to save configuration.";
      formError.classList.remove("hidden");
    }
  }
}
document.addEventListener("DOMContentLoaded", () => {
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
    if (el)
      el.classList.toggle("hidden");
  });
  $("#btn-cancel")?.addEventListener("click", async () => {
    try {
      await rpc.request.cancelInstallation({});
    } catch (e) {
      console.error(e);
    }
  });
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
    if (el)
      el.classList.toggle("hidden");
  });
  $("#btn-copy-command")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(MANUAL_COMMAND);
      const btn = $("#btn-copy-command");
      if (btn) {
        const old = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => btn.textContent = old, 1500);
      }
    } catch {}
  });
  $("#setup-form")?.addEventListener("submit", submitForm);
  $("#link-external")?.addEventListener("click", (e) => {
    e.preventDefault();
    rpc.request.openExternal({ url: "https://github.com/DaviRain-Su/hermes-agent" });
  });
});
function $$(sel) {
  return document.querySelectorAll(sel);
}
