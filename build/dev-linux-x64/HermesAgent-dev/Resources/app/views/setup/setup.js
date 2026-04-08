// node_modules/electrobun/dist/api/shared/rpc.ts
var MAX_ID = 10000000000;
var DEFAULT_MAX_REQUEST_TIME = 1000;
function missingTransportMethodError(methods, action) {
  const methodsString = methods.map((m) => `"${m}"`).join(", ");
  return new Error(`This RPC instance cannot ${action} because the transport did not provide one or more of these methods: ${methodsString}`);
}
function createRPC(options = {}) {
  let debugHooks = {};
  let transport = {};
  let requestHandler = undefined;
  function setTransport(newTransport) {
    if (transport.unregisterHandler)
      transport.unregisterHandler();
    transport = newTransport;
    transport.registerHandler?.(handler);
  }
  function setRequestHandler(h) {
    if (typeof h === "function") {
      requestHandler = h;
      return;
    }
    requestHandler = (method, params) => {
      const handlerFn = h[method];
      if (handlerFn)
        return handlerFn(params);
      const fallbackHandler = h._;
      if (!fallbackHandler)
        throw new Error(`The requested method has no handler: ${String(method)}`);
      return fallbackHandler(method, params);
    };
  }
  const { maxRequestTime = DEFAULT_MAX_REQUEST_TIME } = options;
  if (options.transport)
    setTransport(options.transport);
  if (options.requestHandler)
    setRequestHandler(options.requestHandler);
  if (options._debugHooks)
    debugHooks = options._debugHooks;
  let lastRequestId = 0;
  function getRequestId() {
    if (lastRequestId <= MAX_ID)
      return ++lastRequestId;
    return lastRequestId = 0;
  }
  const requestListeners = new Map;
  const requestTimeouts = new Map;
  function requestFn(method, ...args) {
    const params = args[0];
    return new Promise((resolve, reject) => {
      if (!transport.send)
        throw missingTransportMethodError(["send"], "make requests");
      const requestId = getRequestId();
      const request2 = {
        type: "request",
        id: requestId,
        method,
        params
      };
      requestListeners.set(requestId, { resolve, reject });
      if (maxRequestTime !== Infinity)
        requestTimeouts.set(requestId, setTimeout(() => {
          requestTimeouts.delete(requestId);
          requestListeners.delete(requestId);
          reject(new Error("RPC request timed out."));
        }, maxRequestTime));
      debugHooks.onSend?.(request2);
      transport.send(request2);
    });
  }
  const request = new Proxy(requestFn, {
    get: (target, prop, receiver) => {
      if (prop in target)
        return Reflect.get(target, prop, receiver);
      return (params) => requestFn(prop, params);
    }
  });
  const requestProxy = request;
  function sendFn(message, ...args) {
    const payload = args[0];
    if (!transport.send)
      throw missingTransportMethodError(["send"], "send messages");
    const rpcMessage = {
      type: "message",
      id: message,
      payload
    };
    debugHooks.onSend?.(rpcMessage);
    transport.send(rpcMessage);
  }
  const send = new Proxy(sendFn, {
    get: (target, prop, receiver) => {
      if (prop in target)
        return Reflect.get(target, prop, receiver);
      return (payload) => sendFn(prop, payload);
    }
  });
  const sendProxy = send;
  const messageListeners = new Map;
  const wildcardMessageListeners = new Set;
  function addMessageListener(message, listener) {
    if (!transport.registerHandler)
      throw missingTransportMethodError(["registerHandler"], "register message listeners");
    if (message === "*") {
      wildcardMessageListeners.add(listener);
      return;
    }
    if (!messageListeners.has(message))
      messageListeners.set(message, new Set);
    messageListeners.get(message).add(listener);
  }
  function removeMessageListener(message, listener) {
    if (message === "*") {
      wildcardMessageListeners.delete(listener);
      return;
    }
    messageListeners.get(message)?.delete(listener);
    if (messageListeners.get(message)?.size === 0)
      messageListeners.delete(message);
  }
  async function handler(message) {
    debugHooks.onReceive?.(message);
    if (!("type" in message))
      throw new Error("Message does not contain a type.");
    if (message.type === "request") {
      if (!transport.send || !requestHandler)
        throw missingTransportMethodError(["send", "requestHandler"], "handle requests");
      const { id, method, params } = message;
      let response;
      try {
        response = {
          type: "response",
          id,
          success: true,
          payload: await requestHandler(method, params)
        };
      } catch (error) {
        if (!(error instanceof Error))
          throw error;
        response = {
          type: "response",
          id,
          success: false,
          error: error.message
        };
      }
      debugHooks.onSend?.(response);
      transport.send(response);
      return;
    }
    if (message.type === "response") {
      const timeout = requestTimeouts.get(message.id);
      if (timeout != null)
        clearTimeout(timeout);
      requestTimeouts.delete(message.id);
      const { resolve, reject } = requestListeners.get(message.id) ?? {};
      requestListeners.delete(message.id);
      if (!message.success)
        reject?.(new Error(message.error));
      else
        resolve?.(message.payload);
      return;
    }
    if (message.type === "message") {
      for (const listener of wildcardMessageListeners)
        listener(message.id, message.payload);
      const listeners = messageListeners.get(message.id);
      if (!listeners)
        return;
      for (const listener of listeners)
        listener(message.payload);
      return;
    }
    throw new Error(`Unexpected RPC message type: ${message.type}`);
  }
  const proxy = { send: sendProxy, request: requestProxy };
  return {
    setTransport,
    setRequestHandler,
    request,
    requestProxy,
    send,
    sendProxy,
    addMessageListener,
    removeMessageListener,
    proxy
  };
}
function defineElectrobunRPC(_side, config) {
  const rpcOptions = {
    maxRequestTime: config.maxRequestTime,
    requestHandler: {
      ...config.handlers.requests,
      ...config.extraRequestHandlers
    },
    transport: {
      registerHandler: () => {}
    }
  };
  const rpc = createRPC(rpcOptions);
  const messageHandlers = config.handlers.messages;
  if (messageHandlers) {
    rpc.addMessageListener("*", (messageName, payload) => {
      const globalHandler = messageHandlers["*"];
      if (globalHandler) {
        globalHandler(messageName, payload);
      }
      const messageHandler = messageHandlers[messageName];
      if (messageHandler) {
        messageHandler(payload);
      }
    });
  }
  return rpc;
}

// node_modules/electrobun/dist/api/browser/index.ts
var WEBVIEW_ID = window.__electrobunWebviewId;
var RPC_SOCKET_PORT = window.__electrobunRpcSocketPort;

class Electroview {
  bunSocket;
  rpc;
  rpcHandler;
  constructor(config) {
    this.rpc = config.rpc;
    this.init();
  }
  init() {
    this.initSocketToBun();
    window.__electrobun.receiveMessageFromBun = this.receiveMessageFromBun.bind(this);
    if (this.rpc) {
      this.rpc.setTransport(this.createTransport());
    }
  }
  initSocketToBun() {
    if (!RPC_SOCKET_PORT || !WEBVIEW_ID) {
      return;
    }
    const socket = new WebSocket(`ws://localhost:${RPC_SOCKET_PORT}/socket?webviewId=${WEBVIEW_ID}`);
    this.bunSocket = socket;
    socket.addEventListener("open", () => {});
    socket.addEventListener("message", async (event) => {
      const message = event.data;
      if (typeof message === "string") {
        try {
          const encryptedPacket = JSON.parse(message);
          const decrypted = await window.__electrobun_decrypt(encryptedPacket.encryptedData, encryptedPacket.iv, encryptedPacket.tag);
          this.rpcHandler?.(JSON.parse(decrypted));
        } catch (err) {
          console.error("Error parsing bun message:", err);
        }
      } else if (message instanceof Blob) {} else {
        console.error("UNKNOWN DATA TYPE RECEIVED:", event.data);
      }
    });
    socket.addEventListener("error", (event) => {
      console.error("Socket error:", event);
    });
    socket.addEventListener("close", (_event) => {});
  }
  createTransport() {
    const that = this;
    return {
      send(message) {
        try {
          const messageString = JSON.stringify(message);
          that.bunBridge(messageString);
        } catch (error) {
          console.error("bun: failed to serialize message to webview", error);
        }
      },
      registerHandler(handler) {
        that.rpcHandler = handler;
      }
    };
  }
  async bunBridge(msg) {
    if (this.bunSocket?.readyState === WebSocket.OPEN) {
      try {
        const { encryptedData, iv, tag } = await window.__electrobun_encrypt(msg);
        const encryptedPacket = {
          encryptedData,
          iv,
          tag
        };
        const encryptedPacketString = JSON.stringify(encryptedPacket);
        this.bunSocket.send(encryptedPacketString);
        return;
      } catch (error) {
        console.error("Error sending message to bun via socket:", error);
      }
    }
    window.__electrobunBunBridge?.postMessage(msg);
  }
  receiveMessageFromBun(msg) {
    if (this.rpcHandler) {
      this.rpcHandler(msg);
    }
  }
  static defineRPC(config) {
    return defineElectrobunRPC("webview", {
      ...config,
      extraRequestHandlers: {
        evaluateJavascriptWithResponse: ({ script }) => {
          return new Promise((resolve) => {
            try {
              const resultFunction = new Function(script);
              const result = resultFunction();
              if (result instanceof Promise) {
                result.then((resolvedResult) => {
                  resolve(resolvedResult);
                }).catch((error) => {
                  console.error("bun: async script execution failed", error);
                  resolve(String(error));
                });
              } else {
                resolve(result);
              }
            } catch (error) {
              console.error("bun: failed to eval script", error);
              resolve(String(error));
            }
          });
        }
      }
    });
  }
}

// src/mainview/setup.ts
var rpc = Electroview.defineRPC({
  maxRequestTime: 60000,
  handlers: {
    requests: {},
    messages: {
      installStatus: (status) => handleInstallStatus(status),
      installLog: (msg) => appendInstallLog(msg)
    }
  }
});
new Electroview({ rpc });
var $ = (sel) => document.querySelector(sel);
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
    rpc.request.navigateTo({ url: "views://mainview/index.html" });
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
