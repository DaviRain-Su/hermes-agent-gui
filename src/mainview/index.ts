import { Electroview, type RPCSchema } from "electrobun/view";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
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

interface Attachment {
  name: string;
  path: string;
}

// ---------------------------------------------------------------------------
// RPC Schema
// ---------------------------------------------------------------------------
type AppRPCSchema = {
  bun: RPCSchema<{
    requests: {
      getBackendStatus: { params: {}; response: BackendStatus };
      restartBackend: { params: {}; response: BackendStatus };
      getCurrentModel: { params: {}; response: { model: string; provider: string } };
      setModel: { params: { model: string; provider?: string }; response: { success: boolean; needsRestart: boolean } };
      listSessions: { params: {}; response: SessionSummary[] };
      loadSession: { params: { sessionId: string }; response: ChatMessage[] };
      saveFileUpload: { params: { name: string; dataBase64: string }; response: { success: boolean; path: string } };
      openExternal: { params: { url: string }; response: void };
      detectInstallation: { params: {}; response: { installed: boolean; path?: string } };
      startInstallation: { params: { confirm: boolean }; response: { started: boolean; error?: any } };
      cancelInstallation: { params: {}; response: { cancelled: boolean } };
      getInstallStatus: { params: {}; response: { state: string; progress?: number; error?: any } };
      getSetupFields: { params: {}; response: any[] };
      submitSetupConfig: { params: { values: Record<string, string> }; response: { success: boolean; errors?: any[] } };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      backendStatus: BackendStatus;
      backendLog: { stream: "stdout" | "stderr"; text: string };
      installStatus: { state: string; progress?: number; error?: any };
      installLog: { stream: "stdout" | "stderr"; text: string };
    };
  }>;
};

const rpc = Electroview.defineRPC<AppRPCSchema>({
  maxRequestTime: 60000,
  handlers: {
    requests: {},
    messages: {
      backendStatus: (status: BackendStatus) => {
        updateBackendStatusUI(status);
        if (status.running && !backendUrl) {
          backendUrl = status.url;
          initAfterBackendReady();
        }
      },
      backendLog: (msg: { stream: "stdout" | "stderr"; text: string }) => {
        console.log(`[Backend ${msg.stream}]`, msg.text);
      },
      installStatus: (status: { state: string; progress?: number; error?: any }) => {
        handleInstallStatus(status);
      },
      installLog: (msg: { stream: "stdout" | "stderr"; text: string }) => {
        appendInstallLog(msg);
      },
    },
  },
});

new Electroview({ rpc });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let backendUrl = "";
let isStreaming = false;
let conversation: ChatMessage[] = [];
let currentSessionId = "";
let attachments: Attachment[] = [];

// ---------------------------------------------------------------------------
// DOM Helpers
// ---------------------------------------------------------------------------
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => document.querySelectorAll(sel) as NodeListOf<HTMLElement>;

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Backend Status & Model
// ---------------------------------------------------------------------------
function updateBackendStatusUI(status: BackendStatus) {
  const badge = $("#backend-status");
  if (!badge) return;

  if (badge.classList.contains("switching")) return; // ignore while switching

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
    const modelInput = $("#model-input") as HTMLInputElement | null;
    const providerSelect = $("#provider-select") as HTMLSelectElement | null;
    if (modelInput) modelInput.value = cfg.model || "";
    if (providerSelect) providerSelect.value = cfg.provider || "";
  } catch (e) {
    console.error("Failed to load current model:", e);
  }
}

async function applyModel() {
  const modelInput = $("#model-input") as HTMLInputElement | null;
  const providerSelect = $("#provider-select") as HTMLSelectElement | null;
  const applyBtn = $("#apply-model-btn") as HTMLButtonElement | null;
  const badge = $("#backend-status");

  const model = modelInput?.value.trim();
  if (!model) return;

  applyBtn && (applyBtn.disabled = true);
  badge?.classList.remove("online", "offline");
  badge?.classList.add("switching");
  badge && (badge.textContent = "Switching...");

  try {
    const res = await rpc.request.setModel({
      model,
      provider: providerSelect?.value || undefined,
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
  if (!backendUrl) return;
  try {
    const res = await fetch(`${backendUrl}/v1/models`);
    const data = await res.json();
    // We don't use a dropdown for models anymore (free text input is more flexible),
    // but we could keep a datalist for suggestions.
  } catch (e) {
    console.error("Failed to load models:", e);
  }
}

// ---------------------------------------------------------------------------
// Session History
// ---------------------------------------------------------------------------
async function loadSessionHistory() {
  try {
    const sessions = await rpc.request.listSessions({});
    const container = $("#sessions-list")!;
    if (sessions.length === 0) {
      container.innerHTML = '<div class="sessions-empty">No sessions yet</div>';
      return;
    }
    container.innerHTML = "";
    sessions.forEach((s) => {
      const el = document.createElement("div");
      el.className = "session-item";
      el.dataset.id = s.id;
      if (s.id === currentSessionId) el.classList.add("active");

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

async function loadSessionMessages(sessionId: string) {
  if (isStreaming) return;
  try {
    const messages = await rpc.request.loadSession({ sessionId });
    currentSessionId = sessionId;
    conversation = messages.filter((m) => m.role === "user" || m.role === "assistant");

    // Update UI active state
    $$<HTMLDivElement>(".session-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.id === sessionId);
    });

    const messagesEl = $("#messages")!;
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
      const contentDiv = appendMessage(msg.role as any, msg.content || "");
      postProcessMessage(contentDiv);
    });
  } catch (e) {
    console.error("Failed to load session messages:", e);
  }
}

// ---------------------------------------------------------------------------
// Chat UI
// ---------------------------------------------------------------------------
function appendMessage(role: "user" | "assistant", content: string): HTMLElement {
  const messagesEl = $("#messages")!;

  const emptyState = messagesEl.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

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

function formatContent(text: string): string {
  let html = escapeHtml(text);

  // Code blocks
  html = html.replace(
    /```(\w+)?\n([\s\S]*?)```/g,
    (_, lang, code) => `<pre><code>${escapeHtml(code.trim())}</code></pre>`
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Links
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Paragraphs (split on double newlines)
  const paragraphs = html.split(/\n\n+/).map((p) => {
    if (p.startsWith("<pre>")) return p;
    return `<p>${p.replace(/\n/g, "<br>")}</p>`;
  });

  return paragraphs.join("");
}

// Post-process assistant messages to extract tool calls into foldable cards
function postProcessMessage(contentDiv: HTMLElement) {
  const raw = contentDiv.innerText;
  // Tool call pattern: lines like `emoji ToolName` or `emoji ToolName (preview)`
  const toolCallRegex = /\n`([^`]+)`\n/g;
  const matches = [...raw.matchAll(toolCallRegex)];
  if (matches.length === 0) return;

  // Rebuild HTML with tool call cards
  let processed = escapeHtml(raw);
  matches.forEach((m) => {
    const fullText = m[1]; // e.g. "🌐 web_search"
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

  // Re-apply markdown formatting on non-tool parts
  // Simplification: just replace the tool placeholders back after formatting
  // This is tricky, so instead we do a simpler DOM-based approach:
  // Replace lines matching the pattern with cards directly in the DOM.
  const children = Array.from(contentDiv.children);
  children.forEach((child) => {
    if (child.tagName === "P") {
      const pHtml = child.innerHTML;
      const newHtml = pHtml.replace(
        /`([^`]+)`/g,
        (_: string, inner: string) => {
          // Heuristic: if it starts with an emoji, treat as tool call
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
        }
      );
      if (newHtml !== pHtml) child.innerHTML = newHtml;
    }
  });
}

// ---------------------------------------------------------------------------
// SSE Streaming Parser
// ---------------------------------------------------------------------------
async function streamChatCompletion(body: object, contentDiv: HTMLElement) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (currentSessionId) {
    headers["X-Hermes-Session-Id"] = currentSessionId;
  }
  const response = await fetch(`${backendUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(err);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullText += delta.content;
            contentDiv.innerHTML = formatContent(fullText);
            const messagesEl = $("#messages")!;
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        } catch {
          // ignore malformed JSON
        }
      }
    }
  }

  // Post-process tool calls after stream completes
  postProcessMessage(contentDiv);

  // Try to capture session id from headers for future loads
  const sessionHeader = response.headers.get("X-Hermes-Session-Id");
  if (sessionHeader) {
    currentSessionId = sessionHeader;
    loadSessionHistory(); // refresh list so this session appears
  }

  return fullText;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
function renderAttachments() {
  const container = $("#attachments")!;
  if (attachments.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = attachments
    .map(
      (a, idx) => `
        <span class="attachment-chip">
          📎 ${escapeHtml(a.name)}
          <span class="remove" data-idx="${idx}">×</span>
        </span>
      `
    )
    .join("");

  container.querySelectorAll(".remove").forEach((el) => {
    el.addEventListener("click", (e) => {
      const idx = parseInt((e.target as HTMLElement).dataset.idx || "-1", 10);
      if (idx >= 0) {
        attachments.splice(idx, 1);
        renderAttachments();
      }
    });
  });
}

async function handleFileDrop(file: File) {
  try {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // result is data:*/*;base64,xxxxx — strip the prefix
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

// ---------------------------------------------------------------------------
// Send Message
// ---------------------------------------------------------------------------
async function sendMessage() {
  const input = $("#message-input") as HTMLTextAreaElement | null;
  const sendBtn = $("#send-btn") as HTMLButtonElement | null;
  if (!input || !sendBtn || isStreaming || !backendUrl) return;

  let text = input.value.trim();
  if (!text && attachments.length === 0) return;

  // Append attachment references
  if (attachments.length > 0) {
    const attachText = attachments.map((a) => `[Attached file: ${a.path}]`).join("\n");
    text = text ? `${text}\n\n${attachText}` : attachText;
  }

  // Add user message to UI and history
  appendMessage("user", text);
  conversation.push({ role: "user", content: text });
  input.value = "";
  input.style.height = "auto";
  attachments = [];
  renderAttachments();

  // Disable input while streaming
  isStreaming = true;
  sendBtn.disabled = true;
  sendBtn.textContent = "...";

  // Create assistant message container with thinking spinner
  const messagesEl = $("#messages")!;
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
      stream: true,
    };

    const assistantText = await streamChatCompletion(body, contentDiv);
    conversation.push({ role: "assistant", content: assistantText });
  } catch (err: any) {
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
  const messagesEl = $("#messages")!;
  messagesEl.innerHTML = `
    <div class="empty-state">
      <h2>Welcome to Hermes Agent</h2>
      <p>Your local AI assistant with tool-calling superpowers.</p>
      <p class="hint">Drag & drop files here to attach them.</p>
    </div>
  `;
  // Clear active session in sidebar
  $$<HTMLDivElement>(".session-item").forEach((el) => el.classList.remove("active"));
}

function focusInput() {
  const input = $("#message-input") as HTMLTextAreaElement | null;
  input?.focus();
}

// ---------------------------------------------------------------------------
// Onboarding (Install + Setup Wizard)
// ---------------------------------------------------------------------------
let onboardingResolved = false;
let installLogBuffer = "";

function showOverlay() {
  $("#onboarding-overlay")?.classList.remove("hidden");
}

function hideOverlay() {
  $("#onboarding-overlay")?.classList.add("hidden");
}

function setOnboardingTitle(title: string) {
  const el = $("#onboarding-title");
  if (el) el.textContent = title;
}

function setOnboardingDesc(desc: string) {
  const el = $("#onboarding-desc");
  if (el) el.textContent = desc;
}

function showPanel(id: string) {
  ["install-panel", "setup-panel", "error-panel"].forEach((panelId) => {
    const el = $(`#${panelId}`);
    if (el) el.classList.toggle("hidden", panelId !== id);
  });
}

function appendInstallLog(msg: { stream: string; text: string }) {
  const logEl = $("#install-log") as HTMLElement | null;
  if (!logEl) return;
  const prefix = msg.stream === "stderr" ? "[ERR] " : "";
  installLogBuffer += prefix + msg.text;
  logEl.textContent = installLogBuffer;
  logEl.scrollTop = logEl.scrollHeight;
}

function updateInstallProgress(progress?: number) {
  const fill = $("#install-progress-fill") as HTMLElement | null;
  const text = $("#install-progress-text") as HTMLElement | null;
  const pct = Math.round((progress || 0) * 100);
  if (fill) fill.style.width = `${pct}%`;
  if (text) text.textContent = `${pct}%`;
}

function renderSetupForm(fields: any[]) {
  const form = $("#setup-form") as HTMLFormElement | null;
  if (!form) return;
  form.innerHTML = "";
  fields.forEach((field) => {
    const group = document.createElement("div");
    group.className = "form-group";

    const label = document.createElement("label");
    label.textContent = field.label;
    group.appendChild(label);

    let input: HTMLInputElement | HTMLSelectElement;
    if (field.type === "select") {
      input = document.createElement("select");
      (field.options || []).forEach((opt: any) => {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        input.appendChild(option);
      });
    } else {
      input = document.createElement("input");
      input.type = field.type === "password" ? "password" : "text";
      if (field.placeholder) input.placeholder = field.placeholder;
    }

    input.name = field.id;
    input.required = field.required;
    if (field.defaultValue) input.value = field.defaultValue;
    group.appendChild(input);
    form.appendChild(group);
  });
}

async function handleInstallStatus(status: { state: string; progress?: number; error?: any }) {
  if (status.state === "ready" || status.state === "detecting") {
    // detecting handled during init
  }

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
    const errEl = $("#error-message") as HTMLElement | null;
    if (errEl) {
      errEl.innerHTML = `<strong>${escapeHtml(err.code)}</strong><br>${escapeHtml(err.message)}`;
    }
    return;
  }

  if (status.state === "ready") {
    hideOverlay();
    if (!onboardingResolved) {
      onboardingResolved = true;
      // Trigger backend status refresh so chat UI can initialize
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
  const btn = $("#btn-start-install") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    await rpc.request.startInstallation({ confirm: true });
  } catch (e) {
    console.error("startInstallation failed:", e);
    if (btn) btn.disabled = false;
  }
}

async function cancelInstall() {
  await rpc.request.cancelInstallation({});
}

async function submitSetup(e: Event) {
  e.preventDefault();
  const form = $("#setup-form") as HTMLFormElement | null;
  if (!form) return;
  const values: Record<string, string> = {};
  const data = new FormData(form);
  data.forEach((v, k) => {
    values[k] = String(v);
  });

  const errorEl = $("#setup-error") as HTMLElement | null;
  if (errorEl) errorEl.classList.add("hidden");

  try {
    const res = await rpc.request.submitSetupConfig({ values });
    if (!res.success) {
      if (errorEl) {
        errorEl.classList.remove("hidden");
        const msgs = (res.errors || []).map((err: any) => `${err.fieldId}: ${err.message}`).join("\n");
        errorEl.textContent = msgs || "配置保存失败";
      }
    }
  } catch (e: any) {
    if (errorEl) {
      errorEl.classList.remove("hidden");
      errorEl.textContent = e.message || "网络错误";
    }
  }
}

function retryFromError() {
  // Retry the full startup flow
  rpc.request.detectInstallation({}).then(() => {
    location.reload();
  });
}

function openManualInstall() {
  rpc.request.openExternal({
    url: "https://github.com/DaviRain-Su/hermes-agent#quick-install",
  });
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  $("#send-btn")?.addEventListener("click", sendMessage);

  $("#new-chat-btn")?.addEventListener("click", newChat);

  $("#apply-model-btn")?.addEventListener("click", applyModel);

  $("#restart-backend-btn")?.addEventListener("click", async () => {
    const btn = $("#restart-backend-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Restarting...";
    try {
      await rpc.request.restartBackend({});
    } finally {
      btn.disabled = false;
      btn.textContent = "Restart";
    }
  });

  const input = $("#message-input") as HTMLTextAreaElement | null;
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

  // Keyboard shortcuts
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

  // Drag & drop
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

  // Onboarding buttons
  $("#btn-start-install")?.addEventListener("click", startInstall);
  $("#btn-cancel-install")?.addEventListener("click", cancelInstall);
  $("#setup-form")?.addEventListener("submit", submitSetup);
  $("#btn-retry")?.addEventListener("click", retryFromError);
  $("#btn-manual-install")?.addEventListener("click", openManualInstall);

  // Check install status on load
  rpc.request.getInstallStatus({}).then((status) => {
    handleInstallStatus(status);
  });
});
