import { $, $$, escapeHtml, showToast } from "../utils/dom.js";
import { formatContent, formatContentForPrint } from "../utils/format.js";
import { rpc } from "../utils/rpc.js";
import { AppState, Snippet, MODEL_CONTEXT_LIMITS, MAX_INITIAL_MESSAGES } from "../state.js";
import { streamChatCompletion } from "./chat.js";


export function applySystemTheme() {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = prefersDark ? "dark" : "light";
}

export function setTheme(theme: string) {
  localStorage.setItem("hermes-theme", theme);
  if (AppState.systemThemeMq) {
    AppState.systemThemeMq.removeEventListener("change", applySystemTheme);
    AppState.systemThemeMq = null;
  }
  if (theme === "system") {
    AppState.systemThemeMq = window.matchMedia("(prefers-color-scheme: dark)");
    AppState.systemThemeMq.addEventListener("change", applySystemTheme);
    applySystemTheme();
  } else {
    document.documentElement.dataset.theme = theme;
  }
  $$(".theme-chip").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLButtonElement).dataset.theme === theme);
  });
}

type Snippet = { title: string; content: string; isBuiltin?: boolean };

const BUILTIN_SNIPPETS: Snippet[] = [
  { title: "Explain", content: "Explain the following in simple terms:", isBuiltin: true },
  { title: "Summarize", content: "Provide a concise summary:", isBuiltin: true },
  { title: "Refactor", content: "Refactor and improve the following code:", isBuiltin: true },
  { title: "Write tests", content: "Write comprehensive unit tests for:", isBuiltin: true },
  { title: "Translate to CN", content: "Translate the following into natural Chinese:", isBuiltin: true },
  { title: "Translate to EN", content: "Translate the following into natural English:", isBuiltin: true },
];

export function loadSnippets(): Snippet[] {
  try {
    const stored = JSON.parse(localStorage.getItem("hermes-prompt-snippets") || "[]");
    if (Array.isArray(stored) && stored.length > 0) return stored;
  } catch {}
  return BUILTIN_SNIPPETS.map((s) => ({ ...s }));
}

export function saveSnippets(list: Snippet[]) {
  // Only save non-builtin snippets to localStorage
  const custom = list.filter((s) => !s.isBuiltin);
  localStorage.setItem("hermes-prompt-snippets", JSON.stringify(custom));
}

export function renderSnippets() {
  const container = $("#snippet-list");
  if (!container) return;
  container.innerHTML = "";
  const list = loadSnippets();
  if (list.length === 0) {
    container.innerHTML = `<div class="hint" style="font-size:12px;color:var(--text-secondary)">No snippets yet.</div>`;
    return;
  }
  list.forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "snippet-item";
    const badge = s.isBuiltin ? `<span class="snippet-badge">built-in</span>` : "";
    const delBtn = s.isBuiltin ? "" : `<button data-idx="${idx}" title="Delete">✕</button>`;
    row.innerHTML = `<span>${escapeHtml(s.title)}</span>${badge}${delBtn}`;
    const btn = row.querySelector("button");
    if (btn) {
      btn.addEventListener("click", () => {
        list.splice(idx, 1);
        saveSnippets(list);
        renderSnippets();
      });
    }
    container.appendChild(row);
  });
}

export function addSnippet() {
  const titleIn = $("#snippet-title") as HTMLInputElement | null;
  const contentIn = $("#snippet-content") as HTMLTextAreaElement | null;
  if (!titleIn || !contentIn) return;
  const title = titleIn.value.trim();
  const content = contentIn.value.trim();
  if (!title || !content) return;
  const list = loadSnippets().filter((s) => !s.isBuiltin);
  list.push({ title, content });
  saveSnippets(list);
  titleIn.value = "";
  contentIn.value = "";
  renderSnippets();
}


export function showSnippetMenu() {
  hideMentionMenu();
  hideSlashMenu();
  const existing = $(".snippet-menu");
  if (existing) { existing.remove(); return; }

  const input = $("#message-input") as HTMLTextAreaElement | null;
  if (!input) return;
  const list = loadSnippets();
  if (list.length === 0) {
    showToast("No snippets saved. Add them in Settings.");
    return;
  }
  const rect = input.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "snippet-menu slash-menu";
  menu.style.cssText = `position:fixed;left:${rect.left}px;bottom:${window.innerHeight - rect.top + 4}px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:6px 0;z-index:1000;min-width:180px;box-shadow:0 8px 30px rgba(0,0,0,0.25);`;

  list.forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "snippet-item-row slash-item" + (idx === 0 ? " active" : "");
    row.style.cssText = "padding:8px 14px;cursor:pointer;display:flex;justify-content:space-between;gap:12px;";
    row.innerHTML = `<span>${escapeHtml(s.title)}</span>`;
    row.addEventListener("mouseenter", () => {
      menu.querySelectorAll(".snippet-item-row").forEach((i) => i.classList.remove("active"));
      row.classList.add("active");
    });
    row.addEventListener("click", () => {
      input.value += (input.value && !input.value.endsWith(" ") ? " " : "") + s.content;
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
      menu.remove();
      input.focus();
    });
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
}

export function getDragAfterElement(container: HTMLElement, y: number) {
  const items = Array.from(container.querySelectorAll<HTMLElement>(".session-item:not(.dragging):not(.pinned)"));
  return items.reduce<{ offset: number; el?: HTMLElement }>((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, el: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY }).el;
}

export function openSettings() {
  $("#settings-overlay")?.classList.remove("hidden");
  const savedTheme = localStorage.getItem("hermes-theme") || "dark";
  $$(".theme-chip").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLButtonElement).dataset.theme === savedTheme);
  });
  renderSnippets();
  loadMcpServers();
  const cssInput = $("#custom-css-input") as HTMLTextAreaElement | null;
  if (cssInput) cssInput.value = localStorage.getItem("hermes-custom-css") || "";
}

export function closeSettings() {
  $("#settings-overlay")?.classList.add("hidden");
}

export function applyCustomCSS() {
  const css = localStorage.getItem("hermes-custom-css") || "";
  let style = $("#custom-css-override") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "custom-css-override";
    document.head.appendChild(style);
  }
  style.textContent = css;
}

export function saveCustomCSS() {
  const cssInput = $("#custom-css-input") as HTMLTextAreaElement | null;
  if (!cssInput) return;
  localStorage.setItem("hermes-custom-css", cssInput.value);
  applyCustomCSS();
  showToast("Custom CSS applied");
}

export function collectHermesData(): Record<string, string> {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("hermes-")) {
      data[key] = localStorage.getItem(key) || "";
    }
  }
  return data;
}

export function restoreHermesData(data: Record<string, string>) {
  Object.entries(data).forEach(([key, value]) => {
    if (typeof value === "string") localStorage.setItem(key, value);
  });
}

export async function backupToGist() {
  const patInput = $("#gist-pat") as HTMLInputElement | null;
  const status = $("#gist-status");
  const pat = patInput?.value.trim();
  if (!pat) {
    status && (status.textContent = "Please enter a PAT");
    return;
  }
  status && (status.textContent = "Backing up...");
  try {
    const payload = {
      description: "Hermes Agent GUI settings backup",
      public: false,
      files: {
        "hermes-backup.json": {
          content: JSON.stringify({
            version: 1,
            exportedAt: new Date().toISOString(),
            data: collectHermesData(),
          }, null, 2),
        },
      },
    };
    const gistId = localStorage.getItem("hermes-gist-id");
    const url = gistId ? `https://api.github.com/gists/${gistId}` : "https://api.github.com/gists";
    const method = gistId ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `token ${pat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    localStorage.setItem("hermes-gist-id", json.id);
    status && (status.textContent = `Backed up to gist ${json.id}`);
  } catch (e: any) {
    status && (status.textContent = "Backup failed: " + (e.message || e));
  }
}

export async function restoreFromGist() {
  const patInput = $("#gist-pat") as HTMLInputElement | null;
  const status = $("#gist-status");
  const pat = patInput?.value.trim();
  const gistId = localStorage.getItem("hermes-gist-id");
  if (!pat) {
    status && (status.textContent = "Please enter a PAT");
    return;
  }
  if (!gistId) {
    status && (status.textContent = "No gist ID found. Backup first.");
    return;
  }
  status && (status.textContent = "Restoring...");
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: { Authorization: `token ${pat}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const file = json.files && json.files["hermes-backup.json"];
    if (!file) throw new Error("Backup file not found in gist");
    const content = file.content || (await fetch(file.raw_url).then((r) => r.text()));
    const parsed = JSON.parse(content);
    if (parsed.data) restoreHermesData(parsed.data);
    applyCustomCSS();
    renderSnippets();
    status && (status.textContent = "Restored successfully");
    showToast("Settings restored from Gist");
  } catch (e: any) {
    status && (status.textContent = "Restore failed: " + (e.message || e));
  }
}

const PALETTE_COMMANDS = [
  { id: "newChat", label: "New chat", shortcut: "Ctrl/Cmd+Shift+N", action: () => { newChat(); focusInput(); } },
  { id: "focusInput", label: "Focus composer", shortcut: "Ctrl/Cmd+K", action: () => focusInput() },
  { id: "toggleSearch", label: "Search messages", shortcut: "Ctrl/Cmd+Shift+F", action: () => toggleSearch(true) },
  { id: "toggleCompare", label: "Open model compare", action: () => toggleCompareMode(true) },
  { id: "exportMarkdown", label: "Export AppState.conversation to Markdown", action: () => exportToMarkdown() },
  { id: "exportPDF", label: "Print / Save as PDF", action: () => exportToPDF() },
  { id: "toggleSettings", label: "Open settings", action: () => openSettings() },
  { id: "toggleShortcuts", label: "Keyboard shortcuts", shortcut: "? or Ctrl/", action: () => showShortcutsOverlay() },
  { id: "toggleThemeDark", label: "Theme: Dark", action: () => setTheme("dark") },
  { id: "toggleThemeLight", label: "Theme: Light", action: () => setTheme("light") },
  { id: "toggleThemeSystem", label: "Theme: System", action: () => setTheme("system") },
  { id: "reloadWindow", label: "Reload window", action: () => location.reload() },
];


export function toggleCompareMode(show?: boolean) {
  const panel = $("#compare-panel");
  if (!panel) return;
  const shouldShow = show !== undefined ? show : panel.classList.contains("hidden");
  if (shouldShow) {
    panel.classList.remove("hidden");
  } else {
    panel.classList.add("hidden");
  }
}

export async function runComparison() {
  const modelA = (($("#compare-model-a") as HTMLInputElement | null)?.value || "").trim();
  const modelB = (($("#compare-model-b") as HTMLInputElement | null)?.value || "").trim();
  const prompt = (($("#compare-prompt") as HTMLTextAreaElement | null)?.value || "").trim();
  if (!modelA || !modelB || !prompt) {
    showToast("Please fill both models and the prompt");
    return;
  }

  const resultA = $("#compare-result-a")!;
  const resultB = $("#compare-result-b")!;
  resultA.innerHTML = `<div class="thinking"><span class="thinking-dots"><span></span><span></span><span></span></span><span>Thinking</span></div>`;
  resultB.innerHTML = `<div class="thinking"><span class="thinking-dots"><span></span><span></span><span></span></span><span>Thinking</span></div>`;

  const runSide = async (model: string, container: HTMLElement) => {
    const ctrl = new AbortController();
    const body = {
      model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    };
    try {
      await streamChatCompletion(body, container, ctrl.signal, AppState.currentSessionId || "new");
    } catch (err: any) {
      container.innerHTML = `<p style="color:#ef4444">Error: ${escapeHtml(err.message || String(err))}</p>`;
    }
  };

  await Promise.all([runSide(modelA, resultA), runSide(modelB, resultB)]);
}

export function exportToMarkdown() {
  if (!AppState.conversation.length) {
    showToast("No AppState.conversation to export");
    return;
  }
  const lines: string[] = [];
  lines.push(`# Hermes Agent Conversation`);
  lines.push("");
  if (AppState.currentSessionId) lines.push(`Session: ${AppState.currentSessionId}`);
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push("");
  AppState.conversation.forEach((msg) => {
    const roleTitle = msg.role === "user" ? "User" : "Assistant";
    lines.push(`## ${roleTitle}`);
    lines.push("");
    lines.push(msg.content || "");
    lines.push("");
  });
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hermes-${AppState.currentSessionId || "chat"}-${Date.now()}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportToPDF() {
  if (!AppState.conversation.length) {
    showToast("No AppState.conversation to print");
    return;
  }
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) { iframe.remove(); return; }

  const isDark = window.getComputedStyle(document.body).backgroundColor.includes("33") || document.documentElement.dataset.theme === "dark";
  const bg = isDark ? "#1a1a1a" : "#ffffff";
  const fg = isDark ? "#e5e5e5" : "#1a1a1a";
  const accent = isDark ? "#f59e0b" : "#d97706";

  let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Hermes Agent Conversation</title>
<style>
  body { margin: 0; padding: 24px; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: ${bg}; color: ${fg}; line-height: 1.5; }
  h1 { font-size: 18px; margin: 0 0 12px 0; color: ${accent}; }
  .meta { font-size: 12px; color: #888; margin-bottom: 20px; }
  .msg { margin-bottom: 16px; page-break-inside: avoid; }
  .role { font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 0.4px; color: ${accent}; margin-bottom: 4px; }
  .content { font-size: 13px; white-space: pre-wrap; word-break: break-word; }
  .content pre { background: rgba(128,128,128,0.12); padding: 8px; border-radius: 4px; overflow-x: auto; }
  .content code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: rgba(128,128,128,0.12); padding: 1px 4px; border-radius: 3px; }
  @media print { body { background: #fff !important; color: #000 !important; } }
</style>
</head>
<body>
<h1>Hermes Agent Conversation</h1>
<div class="meta">Session: ${escapeHtml(AppState.currentSessionId || "—")}<br>Date: ${new Date().toISOString()}</div>
`;

  AppState.conversation.forEach((msg) => {
    const roleLabel = msg.role === "user" ? "User" : "Assistant";
    html += `<div class="msg"><div class="role">${roleLabel}</div><div class="content">${formatContentForPrint(msg.content || "")}</div></div>`;
  });

  html += "</body></html>";
  doc.open();
  doc.write(html);
  doc.close();

  requestAnimationFrame(() => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {}
    setTimeout(() => iframe.remove(), 3000);
  });
}

export async function setPassword() {
  const newPass = ($("#new-password") as HTMLInputElement | null)?.value.trim();
  const confirmPass = ($("#confirm-password") as HTMLInputElement | null)?.value.trim();
  const status = $("#password-status");
  if (!newPass) {
    if (status) status.textContent = "Please enter a new password.";
    return;
  }
  if (newPass !== confirmPass) {
    if (status) status.textContent = "Passwords do not match.";
    return;
  }
  try {
    const res = await rpc.request.setPassword({ password: newPass });
    if (res.success) {
      if (status) status.textContent = "Password updated successfully.";
      ($("#new-password") as HTMLInputElement | null)!.value = "";
      ($("#confirm-password") as HTMLInputElement | null)!.value = "";
    } else {
      if (status) status.textContent = res.error || "Failed to update password.";
    }
  } catch (e: any) {
    if (status) status.textContent = "Error: " + (e.message || String(e));
  }
}

export async function loadMcpServers() {
  try {
    const servers = await rpc.request.listMcpServers({});
    renderMcpServers(servers || []);
  } catch (e) {
    console.error("Failed to load MCP servers:", e);
    const container = $("#mcp-server-list");
    if (container) container.innerHTML = '<div class="panel-empty">Error loading MCP servers</div>';
  }
}

export function renderMcpServers(servers: any[]) {
  const container = $("#mcp-server-list");
  if (!container) return;
  if (servers.length === 0) {
    container.innerHTML = '<div class="panel-empty">No MCP servers configured</div>';
    return;
  }
  container.innerHTML = servers.map((s: any) => `
    <div class="mcp-item ${s.enabled !== false ? 'enabled' : 'disabled'}" data-name="${escapeHtml(s.name)}">
      <div class="mcp-main">
        <span class="mcp-dot ${s.connected ? 'on' : ''}"></span>
        <span class="mcp-name">${escapeHtml(s.name)}</span>
        <span class="mcp-transport">${escapeHtml(s.transport)}</span>
      </div>
      <div class="mcp-actions">
        <button class="icon-btn mcp-toggle-btn" title="${s.enabled !== false ? 'Disable' : 'Enable'}">${s.enabled !== false ? '⏸' : '▶'}</button>
        <button class="icon-btn mcp-tools-btn" title="View tools">🔧</button>
        <button class="icon-btn mcp-remove-btn" title="Remove">✕</button>
      </div>
      <div class="mcp-tools hidden"></div>
    </div>
  `).join("");
  container.querySelectorAll(".mcp-item").forEach((el) => {
    const name = (el as HTMLElement).dataset.name || "";
    el.querySelector(".mcp-toggle-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMcpServer(name);
    });
    el.querySelector(".mcp-remove-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      removeMcpServerHandler(name);
    });
    el.querySelector(".mcp-tools-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      expandMcpTools(el as HTMLElement, name);
    });
  });
}

export async function addMcpServerForm() {
  const nameEl = $("#mcp-name") as HTMLInputElement | null;
  const transportEl = $("#mcp-transport") as HTMLSelectElement | null;
  const commandEl = $("#mcp-command") as HTMLInputElement | null;
  const argsEl = $("#mcp-args") as HTMLInputElement | null;
  const name = nameEl?.value.trim();
  const transport = transportEl?.value as "stdio" | "sse";
  const command = commandEl?.value.trim();
  const args = argsEl?.value.trim().split(/\s+/).filter(Boolean) || [];
  if (!name || !command) {
    showToast("Name and command/URL are required");
    return;
  }
  try {
    const res = await rpc.request.addMcpServer({
      name,
      transport,
      command,
      args: transport === "stdio" ? args : undefined,
      url: transport === "sse" ? command : undefined,
      enabled: true,
    });
    if (res.success) {
      nameEl && (nameEl.value = "");
      commandEl && (commandEl.value = "");
      argsEl && (argsEl.value = "");
      await loadMcpServers();
    } else {
      showToast(res.error || "Failed to add MCP server");
    }
  } catch (e: any) {
    showToast("Error: " + (e.message || String(e)));
  }
}

export async function toggleMcpServer(name: string) {
  try {
    const servers: any[] = await rpc.request.listMcpServers({});
    const s = servers.find((x) => x.name === name);
    if (!s) return;
    const enabled = s.enabled === false ? true : false;
    await rpc.request.addMcpServer({ ...s, enabled });
    await loadMcpServers();
  } catch (e: any) {
    showToast("Error: " + (e.message || String(e)));
  }
}

export async function removeMcpServerHandler(name: string) {
  if (!confirm(`Remove MCP server "${name}"?`)) return;
  try {
    await rpc.request.removeMcpServer({ name });
    await loadMcpServers();
  } catch (e: any) {
    showToast("Error: " + (e.message || String(e)));
  }
}

export async function expandMcpTools(el: HTMLElement, serverName: string) {
  const toolsEl = el.querySelector(".mcp-tools") as HTMLElement | null;
  if (!toolsEl) return;
  if (!toolsEl.classList.contains("hidden")) {
    toolsEl.classList.add("hidden");
    return;
  }
  try {
    const data = await rpc.request.listMcpTools({});
    const tools = (data.tools || []).filter((t: any) => t.server === serverName);
    if (tools.length === 0) {
      toolsEl.innerHTML = '<div class="panel-empty" style="padding:4px 0">No tools available</div>';
    } else {
      toolsEl.innerHTML = tools.map((t: any) => `
        <div class="mcp-tool">
          <span class="mcp-tool-name">${escapeHtml(t.name)}</span>
          <span class="mcp-tool-desc">${escapeHtml(t.description || "")}</span>
        </div>
      `).join("");
    }
    toolsEl.classList.remove("hidden");
  } catch (e: any) {
    toolsEl.innerHTML = '<div class="panel-empty" style="padding:4px 0">Error loading tools</div>';
    toolsEl.classList.remove("hidden");
  }
}

