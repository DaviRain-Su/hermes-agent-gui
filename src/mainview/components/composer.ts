import { $, $$, escapeHtml, showToast } from "../utils/dom.js";
import { formatContent } from "../utils/format.js";
import { rpc, showLoginOverlay } from "../utils/rpc.js";
import { AppState, ChatMessage } from "../state.js";


export function newChat() {
  AppState.currentSessionId = "";
  updateDocumentTitle("Hermes Agent");
  AppState.conversation = [];
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
  const usageEl = $("#token-usage-display");
  if (usageEl) usageEl.textContent = "";
  loadDraft();
}

export function focusInput() {
  const input = $("#message-input") as HTMLTextAreaElement | null;
  input?.focus();
}

export function draftKey(sessionId?: string) {
  return `hermes-draft-${sessionId || "new"}`;
}

export function saveDraft() {
  const input = $("#message-input") as HTMLTextAreaElement | null;
  if (!input) return;
  const text = input.value;
  if (text.trim()) {
    localStorage.setItem(draftKey(AppState.currentSessionId), text);
  } else {
    localStorage.removeItem(draftKey(AppState.currentSessionId));
  }
}

export function loadDraft() {
  const input = $("#message-input") as HTMLTextAreaElement | null;
  if (!input) return;
  const text = localStorage.getItem(draftKey(AppState.currentSessionId)) || "";
  input.value = text;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  updateComposerCount();
}

export function clearDraft() {
  localStorage.removeItem(draftKey(AppState.currentSessionId));
}

export function updateComposerCount() {
  const input = $("#message-input") as HTMLTextAreaElement | null;
  const el = $("#composer-count");
  if (!input || !el) return;
  const text = input.value;
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  el.textContent = `${words} words · ${chars} chars`;
}

export function updateScrollIndicator() {
  const btn = $("#scroll-to-bottom");
  if (!btn) return;
  if (AppState.userScrolledUp) {
    btn.classList.remove("hidden");
  } else {
    btn.classList.add("hidden");
  }
}

(window as any).newChat = newChat;
(window as any).focusInput = focusInput;

export function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.1, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch {}
}

const SLASH_COMMANDS = [
  { name: "new", desc: "Start new chat" },
  { name: "clear", desc: "Clear AppState.conversation" },
  { name: "theme", desc: "Change theme (dark/light/slate...)" },
  { name: "compact", desc: "Compact history" },
  { name: "model", desc: "Switch model" },
  { name: "workspace", desc: "Switch workspace" },
  { name: "usage", desc: "Show token usage" },
  { name: "help", desc: "Show help" },
];

export async function handleSlashCommand(cmd: string, arg: string): Promise<boolean> {
  switch (cmd) {
    case "new":
      newChat();
      return true;
    case "clear": {
      const messagesEl = $("#messages");
      if (messagesEl) {
        messagesEl.innerHTML = `
          <div class="empty-state">
            <h2>Cleared</h2>
            <p>The AppState.conversation was cleared.</p>
          </div>`;
      }
      AppState.conversation = [];
      return true;
    }
    case "theme":
      if (arg && document.documentElement.dataset.theme !== arg) {
        setTheme(arg);
      } else if (!arg) {
        showToast("Usage: /theme <dark|light|slate|solarized|monokai|nord>");
      }
      return true;
    case "compact": {
      if (!AppState.currentSessionId) { showToast("No active session"); return true; }
      const res = await rpc.request.compactContext({ sessionId: AppState.currentSessionId });
      showToast(res.success ? "Context compacted" : "Compact failed: " + (res.error || ""));
      if (res.success) loadSessionMessages(AppState.currentSessionId);
      return true;
    }
    case "model": {
      if (!arg) { showToast("Usage: /model <model-name>"); return true; }
      const result = await rpc.request.setModel({ model: arg });
      showToast(result.success ? `Model set to ${arg}` : "Set model failed");
      if (result.success) loadCurrentModel();
      return true;
    }
    case "workspace": {
      if (!arg) { showToast("Usage: /workspace <path>"); return true; }
      if (!AppState.currentSessionId) { showToast("No active session"); return true; }
      const wsRes = await rpc.request.setSessionWorkspace({ sessionId: AppState.currentSessionId, workspace: arg });
      showToast(wsRes.success ? `Workspace set to ${arg}` : "Set workspace failed: " + (wsRes.error || ""));
      if (wsRes.success) {
        AppState.workspacePath = "";
        loadWorkspace();
      }
      return true;
    }
    case "usage": {
      localStorage.setItem("hermes-token-usage", "1");
      updateTokenUsageDisplay();
      showToast("Token usage display enabled");
      return true;
    }
    case "help": {
      const helpText = SLASH_COMMANDS.map((c) => `/${c.name} — ${c.desc}`).join("\n");
      showToast(helpText, 5000);
      return true;
    }
    default:
      return false;
  }
}

export function updateSlashMenu() {
  hideSlashMenu();
  const input = $("#message-input") as HTMLTextAreaElement | null;
  if (!input) return;
  const textBefore = input.value.slice(0, input.selectionStart || 0);
  const match = textBefore.match(/(^|\s)\/(\w*)$/);
  if (!match) return;

  const query = match[2].toLowerCase();
  // Merge built-in commands with skill commands (best-effort)
  const all = [...SLASH_COMMANDS];
  const items = all.filter((c) => c.name.startsWith(query));
  if (items.length === 0) return;

  const rect = input.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "slash-menu";
  menu.style.cssText = `position:fixed;left:${rect.left}px;bottom:${window.innerHeight - rect.top + 4}px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:6px 0;z-index:1000;min-width:180px;box-shadow:0 8px 30px rgba(0,0,0,0.25);`;

  items.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "slash-item" + (idx === 0 ? " active" : "");
    row.style.cssText = "padding:8px 14px;cursor:pointer;display:flex;justify-content:space-between;gap:12px;";
    row.innerHTML = `<span>/${item.name}</span><span style=\"color:var(--text-secondary);font-size:12px;\">${escapeHtml(item.desc)}</span>`;
    row.addEventListener("mouseenter", () => {
      menu.querySelectorAll(".slash-item").forEach((i) => i.classList.remove("active"));
      row.classList.add("active");
    });
    row.addEventListener("click", () => {
      const before = textBefore.slice(0, textBefore.lastIndexOf("/"));
      input.value = before + `/${item.name} `;
      hideSlashMenu();
      input.focus();
    });
    menu.appendChild(row);
  });

  document.body.appendChild(menu);
}

export function hideSlashMenu() {
  $(".slash-menu")?.remove();
}


export function hideMentionMenu() {
  $(".mention-menu")?.remove();
}

export async function updateMentionMenu() {
  hideMentionMenu();
  const input = $("#message-input") as HTMLTextAreaElement | null;
  if (!input) return;
  const textBefore = input.value.slice(0, input.selectionStart || 0);
  const match = textBefore.match(/(^|\s)@([^\s]*)$/);
  if (!match) return;

  if (AppState.cachedWorkspaceEntries.length === 0) {
    try {
      const data = await rpc.request.listWorkspace({ path: AppState.workspacePath, sessionId: AppState.currentSessionId || undefined });
      AppState.cachedWorkspaceEntries = (data.entries || []).filter((e: any) => !e.isDirectory);
    } catch {}
  }
  const query = match[2].toLowerCase();
  const items = AppState.cachedWorkspaceEntries.filter((e: any) => e.name.toLowerCase().includes(query));
  if (items.length === 0) return;

  const rect = input.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "mention-menu slash-menu";
  menu.style.cssText = `position:fixed;left:${rect.left}px;bottom:${window.innerHeight - rect.top + 4}px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:6px 0;z-index:1000;min-width:180px;box-shadow:0 8px 30px rgba(0,0,0,0.25);`;

  items.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "mention-item slash-item" + (idx === 0 ? " active" : "");
    row.style.cssText = "padding:8px 14px;cursor:pointer;display:flex;justify-content:space-between;gap:12px;";
    row.innerHTML = `<span>@${escapeHtml(item.name)}</span><span style=\"color:var(--text-secondary);font-size:12px;\">file</span>`;
    row.addEventListener("mouseenter", () => {
      menu.querySelectorAll(".mention-item").forEach((i) => i.classList.remove("active"));
      row.classList.add("active");
    });
    row.addEventListener("click", () => {
      const before = textBefore.slice(0, textBefore.lastIndexOf("@"));
      input.value = before + `[file:${escapeHtml(item.relPath || item.name)}] `;
      hideMentionMenu();
      input.focus();
    });
    menu.appendChild(row);
  });

  document.body.appendChild(menu);
}

export function toggleAgentMode(enabled?: boolean) {
  const checkbox = $("#agent-mode") as HTMLInputElement | null;
  if (checkbox) {
    if (typeof enabled === "boolean") checkbox.checked = enabled;
    AppState.agentMode = checkbox.checked;
    localStorage.setItem("hermes-agent-mode", AppState.agentMode ? "1" : "0");
  }
}

export function initAgentMode() {
  const saved = localStorage.getItem("hermes-agent-mode") === "1";
  const checkbox = $("#agent-mode") as HTMLInputElement | null;
  if (checkbox) checkbox.checked = saved;
  AppState.agentMode = saved;
}


