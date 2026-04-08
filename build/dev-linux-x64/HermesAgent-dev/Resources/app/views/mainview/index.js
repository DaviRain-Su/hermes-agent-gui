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

// src/mainview/index.ts
var rpc = Electroview.defineRPC({
  maxRequestTime: 60000,
  handlers: {
    requests: {},
    messages: {
      backendStatus: (status) => {
        updateBackendStatusUI(status);
        if (status.running && !backendUrl) {
          backendUrl = status.url;
          initAfterBackendReady();
        }
      },
      backendLog: (msg) => {
        console.log(`[Backend ${msg.stream}]`, msg.text);
      },
      installStatus: (status) => {
        handleInstallStatus(status);
      },
      installLog: (msg) => {
        appendInstallLog(msg);
      }
    }
  }
});
new Electroview({ rpc });
var backendUrl = "";
var isStreaming = false;
var conversation = [];
var currentSessionId = "";
var attachments = [];
var $ = (sel) => document.querySelector(sel);
var $$ = (sel) => document.querySelectorAll(sel);
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
function updateBackendStatusUI(status) {
  const badge = $("#backend-status");
  if (!badge)
    return;
  if (badge.classList.contains("switching"))
    return;
  if (status.running) {
    badge.textContent = "Online";
    badge.classList.remove("offline");
    badge.classList.add("online");
    $("#send-btn")?.removeAttribute("disabled");
  } else {
    badge.textContent = "Offline";
    badge.classList.remove("online");
    badge.classList.add("offline");
    $("#send-btn")?.setAttribute("disabled", "true");
  }
}
async function initAfterBackendReady() {
  loadModels();
  loadCurrentModel();
  loadSessionHistory();
}
async function loadCurrentModel() {
  try {
    const cfg = await rpc.request.getCurrentModel({});
    const modelInput = $("#model-input");
    const providerSelect = $("#provider-select");
    if (modelInput)
      modelInput.value = cfg.model || "";
    if (providerSelect)
      providerSelect.value = cfg.provider || "";
  } catch (e) {
    console.error("Failed to load current model:", e);
  }
}
async function applyModel() {
  const modelInput = $("#model-input");
  const providerSelect = $("#provider-select");
  const applyBtn = $("#apply-model-btn");
  const badge = $("#backend-status");
  const model = modelInput?.value.trim();
  if (!model)
    return;
  applyBtn && (applyBtn.disabled = true);
  badge?.classList.remove("online", "offline");
  badge?.classList.add("switching");
  badge && (badge.textContent = "Switching...");
  try {
    const res = await rpc.request.setModel({
      model,
      provider: providerSelect?.value || undefined
    });
    if (res.success) {
      badge?.classList.remove("switching");
      badge?.classList.add("online");
      badge && (badge.textContent = "Online");
    } else {
      badge?.classList.remove("switching");
      badge?.classList.add("offline");
      badge && (badge.textContent = "Failed");
      alert("Model switch failed. Check console for details.");
    }
  } catch (e) {
    badge?.classList.remove("switching");
    badge?.classList.add("offline");
    badge && (badge.textContent = "Error");
    console.error(e);
  } finally {
    applyBtn && (applyBtn.disabled = false);
  }
}
async function loadModels() {
  if (!backendUrl)
    return;
  try {
    const res = await fetch(`${backendUrl}/v1/models`);
    const data = await res.json();
  } catch (e) {
    console.error("Failed to load models:", e);
  }
}
async function loadSessionHistory() {
  try {
    const sessions = await rpc.request.listSessions({});
    const container = $("#sessions-list");
    if (sessions.length === 0) {
      container.innerHTML = '<div class="sessions-empty">No sessions yet</div>';
      return;
    }
    container.innerHTML = "";
    sessions.forEach((s) => {
      const el = document.createElement("div");
      el.className = "session-item";
      el.dataset.id = s.id;
      if (s.id === currentSessionId)
        el.classList.add("active");
      const dateStr = s.updated_at ? new Date(s.updated_at).toLocaleDateString() : "";
      el.innerHTML = `
        <div class="session-name">${escapeHtml(s.display_name)}</div>
        <div class="session-meta">${dateStr} · ${s.message_count} msgs</div>
      `;
      el.addEventListener("click", () => loadSessionMessages(s.id));
      container.appendChild(el);
    });
  } catch (e) {
    console.error("Failed to load sessions:", e);
  }
}
async function loadSessionMessages(sessionId) {
  if (isStreaming)
    return;
  try {
    const messages = await rpc.request.loadSession({ sessionId });
    currentSessionId = sessionId;
    conversation = messages.filter((m) => m.role === "user" || m.role === "assistant");
    $$(".session-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.id === sessionId);
    });
    const messagesEl = $("#messages");
    messagesEl.innerHTML = "";
    if (conversation.length === 0) {
      messagesEl.innerHTML = `
        <div class="empty-state">
          <h2>Empty Session</h2>
          <p>No messages found in this session.</p>
        </div>
      `;
      return;
    }
    conversation.forEach((msg) => {
      const contentDiv = appendMessage(msg.role, msg.content || "");
      postProcessMessage(contentDiv);
    });
  } catch (e) {
    console.error("Failed to load session messages:", e);
  }
}
function appendMessage(role, content) {
  const messagesEl = $("#messages");
  const emptyState = messagesEl.querySelector(".empty-state");
  if (emptyState)
    emptyState.remove();
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "U" : "H";
  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";
  contentDiv.innerHTML = formatContent(content);
  wrapper.appendChild(avatar);
  wrapper.appendChild(contentDiv);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return contentDiv;
}
function formatContent(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${escapeHtml(code.trim())}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const paragraphs = html.split(/\n\n+/).map((p) => {
    if (p.startsWith("<pre>"))
      return p;
    return `<p>${p.replace(/\n/g, "<br>")}</p>`;
  });
  return paragraphs.join("");
}
function postProcessMessage(contentDiv) {
  const raw = contentDiv.innerText;
  const toolCallRegex = /\n`([^`]+)`\n/g;
  const matches = [...raw.matchAll(toolCallRegex)];
  if (matches.length === 0)
    return;
  let processed = escapeHtml(raw);
  matches.forEach((m) => {
    const fullText = m[1];
    const safeText = escapeHtml(fullText);
    const cardHtml = `
      <div class="tool-call-card">
        <div class="tool-call-header" onclick="this.closest('.tool-call-card').classList.toggle('open')">
          <span class="tool-call-title">${safeText}</span>
          <span class="tool-call-arrow">▶</span>
        </div>
        <div class="tool-call-body">Tool executed by Hermes Agent backend.</div>
      </div>
    `;
    processed = processed.replace(escapeHtml(m[0]), cardHtml);
  });
  const children = Array.from(contentDiv.children);
  children.forEach((child) => {
    if (child.tagName === "P") {
      const pHtml = child.innerHTML;
      const newHtml = pHtml.replace(/`([^`]+)`/g, (_, inner) => {
        if (/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/.test(inner.trim())) {
          return `
              <div class="tool-call-card">
                <div class="tool-call-header" onclick="this.closest('.tool-call-card').classList.toggle('open')">
                  <span class="tool-call-title">${escapeHtml(inner)}</span>
                  <span class="tool-call-arrow">▶</span>
                </div>
                <div class="tool-call-body">Executed via Hermes Agent tool runtime.</div>
              </div>
            `;
        }
        return `<code>${escapeHtml(inner)}</code>`;
      });
      if (newHtml !== pHtml)
        child.innerHTML = newHtml;
    }
  });
}
async function streamChatCompletion(body, contentDiv) {
  const headers = { "Content-Type": "application/json" };
  if (currentSessionId) {
    headers["X-Hermes-Session-Id"] = currentSessionId;
  }
  const response = await fetch(`${backendUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(err);
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error("No response body");
  const decoder = new TextDecoder;
  let buffer = "";
  let fullText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(`
`);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]")
          continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullText += delta.content;
            contentDiv.innerHTML = formatContent(fullText);
            const messagesEl = $("#messages");
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        } catch {}
      }
    }
  }
  postProcessMessage(contentDiv);
  const sessionHeader = response.headers.get("X-Hermes-Session-Id");
  if (sessionHeader) {
    currentSessionId = sessionHeader;
    loadSessionHistory();
  }
  return fullText;
}
function renderAttachments() {
  const container = $("#attachments");
  if (attachments.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = attachments.map((a, idx) => `
        <span class="attachment-chip">
          \uD83D\uDCCE ${escapeHtml(a.name)}
          <span class="remove" data-idx="${idx}">×</span>
        </span>
      `).join("");
  container.querySelectorAll(".remove").forEach((el) => {
    el.addEventListener("click", (e) => {
      const idx = parseInt(e.target.dataset.idx || "-1", 10);
      if (idx >= 0) {
        attachments.splice(idx, 1);
        renderAttachments();
      }
    });
  });
}
async function handleFileDrop(file) {
  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader;
      reader.onload = () => {
        const result = reader.result;
        const commaIdx = result.indexOf(",");
        resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const res = await rpc.request.saveFileUpload({ name: file.name, dataBase64: base64 });
    if (res.success) {
      attachments.push({ name: file.name, path: res.path });
      renderAttachments();
    } else {
      alert("Failed to upload file.");
    }
  } catch (e) {
    console.error("File upload failed:", e);
    alert("File upload error.");
  }
}
async function sendMessage() {
  const input = $("#message-input");
  const sendBtn = $("#send-btn");
  if (!input || !sendBtn || isStreaming || !backendUrl)
    return;
  let text = input.value.trim();
  if (!text && attachments.length === 0)
    return;
  if (attachments.length > 0) {
    const attachText = attachments.map((a) => `[Attached file: ${a.path}]`).join(`
`);
    text = text ? `${text}

${attachText}` : attachText;
  }
  appendMessage("user", text);
  conversation.push({ role: "user", content: text });
  input.value = "";
  input.style.height = "auto";
  attachments = [];
  renderAttachments();
  isStreaming = true;
  sendBtn.disabled = true;
  sendBtn.textContent = "...";
  const messagesEl = $("#messages");
  const wrapper = document.createElement("div");
  wrapper.className = "message assistant";
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = "H";
  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";
  const thinking = document.createElement("div");
  thinking.className = "thinking";
  thinking.textContent = "Thinking...";
  contentDiv.appendChild(thinking);
  wrapper.appendChild(avatar);
  wrapper.appendChild(contentDiv);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  try {
    const body = {
      model: "hermes-agent",
      messages: conversation,
      stream: true
    };
    const assistantText = await streamChatCompletion(body, contentDiv);
    conversation.push({ role: "assistant", content: assistantText });
  } catch (err) {
    contentDiv.innerHTML = `<p style="color:#ef4444">Error: ${escapeHtml(err.message || String(err))}</p>`;
  } finally {
    isStreaming = false;
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
  }
}
function newChat() {
  currentSessionId = "";
  conversation = [];
  const messagesEl = $("#messages");
  messagesEl.innerHTML = `
    <div class="empty-state">
      <h2>Welcome to Hermes Agent</h2>
      <p>Your local AI assistant with tool-calling superpowers.</p>
      <p class="hint">Drag & drop files here to attach them.</p>
    </div>
  `;
  $$(".session-item").forEach((el) => el.classList.remove("active"));
}
function focusInput() {
  const input = $("#message-input");
  input?.focus();
}
var onboardingResolved = false;
var installLogBuffer = "";
function showOverlay() {
  $("#onboarding-overlay")?.classList.remove("hidden");
}
function hideOverlay() {
  $("#onboarding-overlay")?.classList.add("hidden");
}
function setOnboardingTitle(title) {
  const el = $("#onboarding-title");
  if (el)
    el.textContent = title;
}
function setOnboardingDesc(desc) {
  const el = $("#onboarding-desc");
  if (el)
    el.textContent = desc;
}
function showPanel(id) {
  ["install-panel", "setup-panel", "error-panel"].forEach((panelId) => {
    const el = $(`#${panelId}`);
    if (el)
      el.classList.toggle("hidden", panelId !== id);
  });
}
function appendInstallLog(msg) {
  const logEl = $("#install-log");
  if (!logEl)
    return;
  const prefix = msg.stream === "stderr" ? "[ERR] " : "";
  installLogBuffer += prefix + msg.text;
  logEl.textContent = installLogBuffer;
  logEl.scrollTop = logEl.scrollHeight;
}
function updateInstallProgress(progress) {
  const fill = $("#install-progress-fill");
  const text = $("#install-progress-text");
  const pct = Math.round((progress || 0) * 100);
  if (fill)
    fill.style.width = `${pct}%`;
  if (text)
    text.textContent = `${pct}%`;
}
function renderSetupForm(fields) {
  const form = $("#setup-form");
  if (!form)
    return;
  form.innerHTML = "";
  fields.forEach((field) => {
    const group = document.createElement("div");
    group.className = "form-group";
    const label = document.createElement("label");
    label.textContent = field.label;
    group.appendChild(label);
    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      (field.options || []).forEach((opt) => {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        input.appendChild(option);
      });
    } else {
      input = document.createElement("input");
      input.type = field.type === "password" ? "password" : "text";
      if (field.placeholder)
        input.placeholder = field.placeholder;
    }
    input.name = field.id;
    input.required = field.required;
    if (field.defaultValue)
      input.value = field.defaultValue;
    group.appendChild(input);
    form.appendChild(group);
  });
}
async function handleInstallStatus(status) {
  if (status.state === "ready" || status.state === "detecting") {}
  if (status.state === "notInstalled") {
    showOverlay();
    setOnboardingTitle("需要安装 Hermes Agent");
    setOnboardingDesc("我们检测到您的系统中尚未安装 Hermes Agent。点击下方按钮开始自动安装。");
    showPanel("install-panel");
    $("#install-progress-container")?.classList.add("hidden");
    $("#install-log")?.classList.add("hidden");
    $("#btn-start-install")?.classList.remove("hidden");
    $("#btn-cancel-install")?.classList.add("hidden");
    updateInstallProgress(0);
    return;
  }
  if (status.state === "installing") {
    showOverlay();
    setOnboardingTitle("正在安装 Hermes Agent");
    setOnboardingDesc("安装过程可能需要几分钟，取决于网络速度。请保持应用开启。");
    showPanel("install-panel");
    $("#install-progress-container")?.classList.remove("hidden");
    $("#install-log")?.classList.remove("hidden");
    $("#btn-start-install")?.classList.add("hidden");
    $("#btn-cancel-install")?.classList.remove("hidden");
    updateInstallProgress(status.progress);
    return;
  }
  if (status.state === "needsConfig") {
    showOverlay();
    setOnboardingTitle("配置 Hermes Agent");
    setOnboardingDesc("请填写您的模型提供商和 API Key，以便开始聊天。");
    showPanel("setup-panel");
    $("#setup-error")?.classList.add("hidden");
    try {
      const fields = await rpc.request.getSetupFields({});
      renderSetupForm(fields);
    } catch (e) {
      console.error("Failed to load setup fields:", e);
    }
    return;
  }
  if (status.state === "error") {
    showOverlay();
    setOnboardingTitle("出错了");
    const err = status.error || { code: "UNKNOWN_ERROR", message: "未知错误" };
    setOnboardingDesc("安装或启动过程中遇到了问题。");
    showPanel("error-panel");
    const errEl = $("#error-message");
    if (errEl) {
      errEl.innerHTML = `<strong>${escapeHtml(err.code)}</strong><br>${escapeHtml(err.message)}`;
    }
    return;
  }
  if (status.state === "ready") {
    hideOverlay();
    if (!onboardingResolved) {
      onboardingResolved = true;
      rpc.request.getBackendStatus({}).then((s) => {
        updateBackendStatusUI(s);
        if (s.running) {
          backendUrl = s.url;
          initAfterBackendReady();
        }
      });
    }
  }
}
async function startInstall() {
  const btn = $("#btn-start-install");
  if (btn)
    btn.disabled = true;
  try {
    await rpc.request.startInstallation({ confirm: true });
  } catch (e) {
    console.error("startInstallation failed:", e);
    if (btn)
      btn.disabled = false;
  }
}
async function cancelInstall() {
  await rpc.request.cancelInstallation({});
}
async function submitSetup(e) {
  e.preventDefault();
  const form = $("#setup-form");
  if (!form)
    return;
  const values = {};
  const data = new FormData(form);
  data.forEach((v, k) => {
    values[k] = String(v);
  });
  const errorEl = $("#setup-error");
  if (errorEl)
    errorEl.classList.add("hidden");
  try {
    const res = await rpc.request.submitSetupConfig({ values });
    if (!res.success) {
      if (errorEl) {
        errorEl.classList.remove("hidden");
        const msgs = (res.errors || []).map((err) => `${err.fieldId}: ${err.message}`).join(`
`);
        errorEl.textContent = msgs || "配置保存失败";
      }
    }
  } catch (e2) {
    if (errorEl) {
      errorEl.classList.remove("hidden");
      errorEl.textContent = e2.message || "网络错误";
    }
  }
}
function retryFromError() {
  rpc.request.detectInstallation({}).then(() => {
    location.reload();
  });
}
function openManualInstall() {
  rpc.request.openExternal({
    url: "https://github.com/DaviRain-Su/hermes-agent#quick-install"
  });
}
document.addEventListener("DOMContentLoaded", () => {
  $("#send-btn")?.addEventListener("click", sendMessage);
  $("#new-chat-btn")?.addEventListener("click", newChat);
  $("#apply-model-btn")?.addEventListener("click", applyModel);
  $("#restart-backend-btn")?.addEventListener("click", async () => {
    const btn = $("#restart-backend-btn");
    btn.disabled = true;
    btn.textContent = "Restarting...";
    try {
      await rpc.request.restartBackend({});
    } finally {
      btn.disabled = false;
      btn.textContent = "Restart";
    }
  });
  const input = $("#message-input");
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    });
  }
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      newChat();
      focusInput();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      focusInput();
    }
  });
  const chatContainer = $("#chat-container");
  const dropOverlay = $("#drop-overlay");
  if (chatContainer && dropOverlay) {
    chatContainer.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropOverlay.classList.add("active");
    });
    chatContainer.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dropOverlay.classList.remove("active");
    });
    chatContainer.addEventListener("drop", async (e) => {
      e.preventDefault();
      dropOverlay.classList.remove("active");
      const files = e.dataTransfer?.files;
      if (files) {
        for (const file of Array.from(files)) {
          await handleFileDrop(file);
        }
      }
    });
  }
  $("#btn-start-install")?.addEventListener("click", startInstall);
  $("#btn-cancel-install")?.addEventListener("click", cancelInstall);
  $("#setup-form")?.addEventListener("submit", submitSetup);
  $("#btn-retry")?.addEventListener("click", retryFromError);
  $("#btn-manual-install")?.addEventListener("click", openManualInstall);
  rpc.request.getInstallStatus({}).then((status) => {
    handleInstallStatus(status);
  });
});
