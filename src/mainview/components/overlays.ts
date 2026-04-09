import { $, $$, escapeHtml, showToast } from "../utils/dom.js";
import { formatContent, formatContentForPrint } from "../utils/format.js";
import { rpc } from "../utils/rpc.js";
import { AppState, BackendStatus } from "../state.js";
import { sendMessage } from "./chat.js";


export function renderErrorBanner() {
  const banner = $("#error-banner");
  if (!banner) return;
  const enabled = localStorage.getItem("hermes-bg-errors") !== "0";
  if (!enabled || AppState.backgroundErrors.size === 0) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }
  const items = Array.from(AppState.backgroundErrors.entries())
    .map(([sid, msg]) => `<div><strong>${escapeHtml(sid.slice(0, 8))}</strong>: ${escapeHtml(msg)}</div>`)
    .join("");
  banner.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:4px;">${items}</div>
    <button class="cancel-btn" style="background:transparent;border-color:#fff;color:#fff;">Dismiss</button>
  `;
  banner.classList.remove("hidden");
  banner.querySelector("button")?.addEventListener("click", () => {
    AppState.backgroundErrors.clear();
    renderErrorBanner();
  });
}

export function toggleSearch(show?: boolean) {
  const bar = $("#chat-search-bar");
  if (!bar) return;
  const shouldShow = show !== undefined ? show : bar.classList.contains("hidden");
  if (shouldShow) {
    bar.classList.remove("hidden");
    const input = $("#chat-search-input") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  } else {
    bar.classList.add("hidden");
    clearSearch();
  }
}

export function clearSearch() {
  AppState.searchMatches = [];
  AppState.activeSearchIndex = -1;
  const countEl = $("#chat-search-count");
  if (countEl) countEl.textContent = "0/0";
  $$<HTMLElement>("mark.search-highlight, mark.search-highlight-active").forEach((mark) => {
    const parent = mark.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
      (parent as HTMLElement).normalize?.();
    }
  });
}

export function highlightTextNodes(node: Node, query: string) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || "";
    const lower = text.toLowerCase();
    const qlower = query.toLowerCase();
    const idx = lower.indexOf(qlower);
    if (idx === -1) return false;
    const parent = node.parentNode;
    if (!parent) return false;
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let cur = lower.indexOf(qlower, lastIndex);
    while (cur !== -1) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex, cur)));
      const mark = document.createElement("mark");
      mark.className = "search-highlight";
      mark.textContent = text.slice(cur, cur + query.length);
      frag.appendChild(mark);
      lastIndex = cur + query.length;
      cur = lower.indexOf(qlower, lastIndex);
    }
    frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    parent.replaceChild(frag, node);
    return true;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "mark" || tag === "script" || tag === "style" || tag === "pre" || tag === "code") return false;
    const children = Array.from(el.childNodes);
    children.forEach((child) => highlightTextNodes(child, query));
  }
  return false;
}

export function performSearch(query: string) {
  clearSearch();
  const q = query.trim();
  if (!q) return;
  $$<HTMLElement>("#messages .message-content").forEach((content) => {
    highlightTextNodes(content, q);
  });
  AppState.searchMatches = $$<HTMLElement>("mark.search-highlight");
  if (AppState.searchMatches.length > 0) {
    AppState.activeSearchIndex = -1;
    navigateSearch(1);
  } else {
    const countEl = $("#chat-search-count");
    if (countEl) countEl.textContent = "0/0";
  }
}

export function navigateSearch(dir: 1 | -1) {
  if (AppState.searchMatches.length === 0) return;
  if (AppState.activeSearchIndex >= 0 && AppState.activeSearchIndex < AppState.searchMatches.length) {
    AppState.searchMatches[AppState.activeSearchIndex].classList.remove("search-highlight-active");
    AppState.searchMatches[AppState.activeSearchIndex].classList.add("search-highlight");
  }
  AppState.activeSearchIndex = (AppState.activeSearchIndex + dir + AppState.searchMatches.length) % AppState.searchMatches.length;
  const mark = AppState.searchMatches[AppState.activeSearchIndex];
  mark.classList.remove("search-highlight");
  mark.classList.add("search-highlight-active");
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  const countEl = $("#chat-search-count");
  if (countEl) countEl.textContent = `${AppState.activeSearchIndex + 1}/${AppState.searchMatches.length}`;
}

export function showCommandPalette() {
  const palette = $("#command-palette");
  if (!palette) return;
  palette.classList.remove("hidden");
  const input = $("#command-palette-input") as HTMLInputElement | null;
  if (input) {
    input.value = "";
    input.focus();
  }
  AppState.paletteActiveIndex = -1;
  renderCommandPalette("");
}

export function hideCommandPalette() {
  $("#command-palette")?.classList.add("hidden");
  AppState.paletteActiveIndex = -1;
}

export function renderCommandPalette(query: string) {
  const list = $("#command-palette-list");
  if (!list) return;
  const q = query.trim().toLowerCase();
  const items = PALETTE_COMMANDS.filter((c) =>
    c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
  );
  if (items.length === 0) {
    list.innerHTML = `<div class="command-palette-item" style="color:var(--text-secondary)">No commands found</div>`;
    return;
  }
  list.innerHTML = items.map((c, idx) => `
    <div class="command-palette-item ${idx === 0 ? "active" : ""}" data-idx="${idx}" data-id="${c.id}">
      <span>${escapeHtml(c.label)}</span>
      ${c.shortcut ? `<span class="command-palette-shortcut">${escapeHtml(c.shortcut)}</span>` : ""}
    </div>
  `).join("");
  list.querySelectorAll(".command-palette-item").forEach((el) => {
    el.addEventListener("mouseenter", () => {
      list.querySelectorAll(".command-palette-item").forEach((i) => i.classList.remove("active"));
      el.classList.add("active");
      AppState.paletteActiveIndex = parseInt((el as HTMLElement).dataset.idx || "-1", 10);
    });
    el.addEventListener("click", () => {
      const id = (el as HTMLElement).dataset.id;
      const cmd = PALETTE_COMMANDS.find((c) => c.id === id);
      if (cmd) { hideCommandPalette(); cmd.action(); }
    });
  });
  AppState.paletteActiveIndex = 0;
}

export function showShortcutsOverlay() {
  $("#shortcuts-overlay")?.classList.remove("hidden");
}

export function hideShortcutsOverlay() {
  $("#shortcuts-overlay")?.classList.add("hidden");
}

export function openLightbox(src: string) {
  const box = $("#lightbox");
  const img = $("#lightbox-img") as HTMLImageElement | null;
  if (!box || !img) return;
  img.src = src;
  box.classList.remove("hidden");
}

export function closeLightbox() {
  const box = $("#lightbox");
  const img = $("#lightbox-img") as HTMLImageElement | null;
  if (!box) return;
  box.classList.add("hidden");
  if (img) img.src = "";
}

export function renderReplyBar() {
  const bar = $("#reply-bar");
  const preview = $("#reply-preview");
  if (!bar || !preview) return;
  if (AppState.activeReplyTo) {
    bar.classList.remove("hidden");
    const snippet = AppState.activeReplyTo.content.replace(/\s+/g, " ").trim().slice(0, 100);
    preview.textContent = snippet || (AppState.activeReplyTo.role === "user" ? "User message" : "Assistant message");
  } else {
    bar.classList.add("hidden");
    preview.textContent = "";
  }
}

export function replyToMessage(wrapper: HTMLElement) {
  const messagesEl = $("#messages")!;
  const all = Array.from(messagesEl.querySelectorAll(".message"));
  const idx = all.indexOf(wrapper);
  if (idx < 0 || idx >= AppState.conversation.length) return;
  const msg = AppState.conversation[idx];
  AppState.activeReplyTo = { role: msg.role, content: msg.content };
  renderReplyBar();
  const input = $("#message-input") as HTMLTextAreaElement | null;
  input?.focus();
}

export function cancelReply() {
  AppState.activeReplyTo = null;
  renderReplyBar();
}

// ---------------------------------------------------------------------------
// Onboarding (Install + Setup Wizard)
// ---------------------------------------------------------------------------

export function showOverlay() {
  $("#onboarding-overlay")?.classList.remove("hidden");
}

export function hideOverlay() {
  $("#onboarding-overlay")?.classList.add("hidden");
}

export function setOnboardingTitle(title: string) {
  const el = $("#onboarding-title");
  if (el) el.textContent = title;
}

export function setOnboardingDesc(desc: string) {
  const el = $("#onboarding-desc");
  if (el) el.textContent = desc;
}

export function showPanel(id: string) {
  ["install-panel", "setup-panel", "error-panel"].forEach((panelId) => {
    const el = $(`#${panelId}`);
    if (el) el.classList.toggle("hidden", panelId !== id);
  });
}

export function appendInstallLog(msg: { stream: string; text: string }) {
  const logEl = $("#install-log") as HTMLElement | null;
  if (!logEl) return;
  const prefix = msg.stream === "stderr" ? "[ERR] " : "";
  AppState.installLogBuffer += prefix + msg.text;
  logEl.textContent = AppState.installLogBuffer;
  logEl.scrollTop = logEl.scrollHeight;
}

export function updateInstallProgress(progress?: number) {
  const fill = $("#install-progress-fill") as HTMLElement | null;
  const text = $("#install-progress-text") as HTMLElement | null;
  const pct = Math.round((progress || 0) * 100);
  if (fill) fill.style.width = `${pct}%`;
  if (text) text.textContent = `${pct}%`;
}

export function renderSetupForm(fields: any[]) {
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

export async function handleInstallStatus(status: { phase: string; progress?: number; message?: string; canCancel?: boolean; canRetry?: boolean }) {
  if (status.phase === "ready" || status.phase === "detecting") {
    // detecting handled during init
  }

  if (status.phase === "not_installed") {
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

  if (status.phase === "installing") {
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

  if (status.phase === "needs_config") {
    showOverlay();
    setOnboardingTitle("配置 Hermes Agent");
    setOnboardingDesc("请填写您的模型提供商和 API Key，以便开始聊天。");
    showPanel("setup-panel");
    $("#setup-error")?.classList.add("hidden");
    try {
      const { fields } = await rpc.request.getSetupFields({});
      renderSetupForm(fields);
    } catch (e) {
      console.error("Failed to load setup fields:", e);
    }
    return;
  }

  if (status.phase === "error") {
    showOverlay();
    setOnboardingTitle("出错了");
    const errMsg = status.message || "未知错误";
    setOnboardingDesc("安装或启动过程中遇到了问题。");
    showPanel("error-panel");
    const errEl = $("#error-message") as HTMLElement | null;
    if (errEl) {
      errEl.innerHTML = `<strong>ERROR</strong><br>${escapeHtml(errMsg)}`;
    }
    return;
  }

  if (status.phase === "ready") {
    hideOverlay();
    if (!AppState.onboardingResolved) {
      AppState.onboardingResolved = true;
      // Trigger backend status refresh so chat UI can initialize
      rpc.request.getBackendStatus({}).then((s) => {
        updateBackendStatusUI(s);
        if (s.running) {
          AppState.backendUrl = s.url;
          initAfterBackendReady();
        }
      });
    }
  }
}

export async function startInstall() {
  const btn = $("#btn-start-install") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    await rpc.request.startInstallation({ confirm: true });
  } catch (e) {
    console.error("startInstallation failed:", e);
    if (btn) btn.disabled = false;
  }
}

export async function cancelInstall() {
  await rpc.request.cancelInstallation({});
}

export async function submitSetup(e: Event) {
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
    const res = await rpc.request.submitSetupConfig(values);
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

export function retryFromError() {
  // Retry the full startup flow
  rpc.request.detectInstallation({}).then(() => {
    location.reload();
  });
}

export function openManualInstall() {
  rpc.request.openExternal({
    url: "https://github.com/DaviRain-Su/hermes-agent#quick-install",
  });
}

// ---------------------------------------------------------------------------
// Event Listeners
export function hideLoginOverlay() {
  $("#login-overlay")?.classList.add("hidden");
  const err = $("#login-error");
  if (err) err.textContent = "";
  const input = $("#login-password") as HTMLInputElement | null;
  if (input) input.value = "";
}

export async function performLogin() {
  const input = $("#login-password") as HTMLInputElement | null;
  const err = $("#login-error");
  const btn = $("#login-btn") as HTMLButtonElement | null;
  if (!input) return;
  const password = input.value;
  if (!password) {
    if (err) err.textContent = "Enter password";
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const res = await rpc.request.login({ password });
    if (res.ok && res.token) {
      localStorage.setItem("hermes-auth-token", res.token);
      hideLoginOverlay();
    } else {
      if (err) err.textContent = res.error || "Sign in failed";
    }
  } catch (e: any) {
    if (err) err.textContent = e.message || "Network error";
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function checkAuth() {
  try {
    const status = await rpc.request.getAuthStatus({});
    if (status.auth_enabled) {
      const token = localStorage.getItem("hermes-auth-token");
      if (!token) {
        showLoginOverlay();
      }
    } else {
      hideLoginOverlay();
    }
  } catch {
    // Backend may not be ready yet; ignore
  }
}

export function showApprovalCard(sessionId: string, pending: any) {
  const messagesEl = $("#messages");
  if (!messagesEl) return;
  const existing = AppState.activeApprovalCards.get(sessionId);
  if (existing) existing.remove();

  const card = document.createElement("div");
  card.className = "approval-card";
  const keys = JSON.stringify(pending.pattern_keys || [pending.pattern_key || ""]);
  card.innerHTML = `
    <div class="approval-title">⚠️ Dangerous command detected</div>
    <pre class="approval-command">${escapeHtml(pending.command || pending.prompt || "")}</pre>
    <div class="approval-actions">
      <button data-choice="once">Allow once</button>
      <button data-choice="session">Allow session</button>
      <button data-choice="always">Always allow</button>
      <button data-choice="deny" class="danger">Deny</button>
    </div>
  `;
  card.querySelectorAll<HTMLButtonElement>("button[data-choice]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const choice = btn.dataset.choice || "deny";
      try {
        await rpc.request.respondApproval({ sessionId, choice, patternKeys: JSON.parse(keys) });
      } catch {}
      card.remove();
      AppState.activeApprovalCards.delete(sessionId);
    });
  });
  messagesEl.appendChild(card);
  if (!AppState.userScrolledUp) messagesEl.scrollTop = messagesEl.scrollHeight;
  updateScrollIndicator();
  AppState.activeApprovalCards.set(sessionId, card);
}

export function startApprovalPolling() {
  setInterval(async () => {
    if (!AppState.currentSessionId) return;
    try {
      const data = await rpc.request.getPendingApproval({ sessionId: AppState.currentSessionId });
      if (data.pending && !AppState.activeApprovalCards.has(AppState.currentSessionId)) {
        showApprovalCard(AppState.currentSessionId, data.pending);
      }
    } catch {}
  }, 2000);
}

