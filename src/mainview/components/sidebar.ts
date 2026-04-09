import { $, $$, escapeHtml, showToast, updateDocumentTitle } from "../utils/dom.js";
import { formatContent } from "../utils/format.js";
import { rpc } from "../utils/rpc.js";
import { AppState, ChatMessage } from "../state.js";
import { appendMessage, renderThinkingCard, postProcessMessage, updateTokenUsageDisplay } from "./chat.js";
import { loadDraft } from "./composer.js";
import { newChat } from "./composer.js";


export async function loadProjectsData() {
  try {
    const res = await rpc.request.getProjects({});
    AppState.projects = res.projects || [];
    renderProjectsBar();
  } catch (e) {
    console.error("Failed to load AppState.projects:", e);
  }
}

export function renderProjectsBar() {
  const bar = $("#projects-bar");
  const list = $("#projects-list");
  if (!bar || !list) return;
  if (AppState.projects.length === 0) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  list.innerHTML = AppState.projects
    .map(
      (p) =>
        `<button class="project-chip ${AppState.activeProjectFilter === p.id ? "active" : ""}" data-project="${escapeHtml(p.id)}">` +
        `<span class="dot" style="background:${escapeHtml(p.color)}"></span>${escapeHtml(p.name)}</button>`
    )
    .join("");

  const allChip = bar.querySelector('.project-chip[data-project=""]') as HTMLElement | null;
  if (allChip) allChip.classList.toggle("active", AppState.activeProjectFilter === "");

  list.querySelectorAll(".project-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      AppState.activeProjectFilter = (btn as HTMLButtonElement).dataset.project || "";
      renderProjectsBar();
      loadSessionHistory();
    });
  });
}

export async function createProjectFromPrompt() {
  const name = prompt("Project name:");
  if (!name) return;
  try {
    await rpc.request.createProject({ name });
    await loadProjectsData();
  } catch (e: any) {
    alert("Create project failed: " + (e.message || e));
  }
}

// ---------------------------------------------------------------------------
// Session History
// ---------------------------------------------------------------------------
export async function loadSessionHistory() {
  try {
    const sessions = await rpc.request.listSessions({});
    const container = $("#sessions-list")!;
    if (sessions.length === 0) {
      container.innerHTML = '<div class="sessions-empty">No sessions yet</div>';
      return;
    }
    container.innerHTML = "";
    const filtered = sessions.filter((s: any) => {
      if (AppState.activeProjectFilter === "") return true;
      return s.project_id === AppState.activeProjectFilter;
    });
    const search = (($("#session-search-input") as HTMLInputElement | null)?.value || "").toLowerCase();
    const searched = filtered.filter((s: any) => {
      if (!search) return true;
      const name = (s.display_name || "").toLowerCase();
      const tags = (s.tags || []).join(" ").toLowerCase();
      return name.includes(search) || tags.includes(search);
    });
    if (searched.length === 0) {
      container.innerHTML = '<div class="sessions-empty">No matching sessions</div>';
    }
    searched.forEach((s: any) => {
      const el = document.createElement("div");
      el.className = "session-item";
      if (s.pinned) el.classList.add("pinned");
      if (s.archived) el.classList.add("archived");
      el.dataset.id = s.id;
      if (s.project_id) {
        el.dataset.projectId = s.project_id;
        const project = AppState.projects.find((p) => p.id === s.project_id);
        if (project) {
          el.style.borderLeftColor = project.color;
        }
      }
      if (s.id === AppState.currentSessionId) el.classList.add("active");

      if (!s.pinned) {
        el.draggable = true;
        el.addEventListener("dragstart", (e) => {
          AppState.draggedSessionId = s.id;
          el.classList.add("dragging");
          e.dataTransfer?.setData("text/plain", s.id);
        });
        el.addEventListener("dragend", () => {
          AppState.draggedSessionId = null;
          el.classList.remove("dragging");
          $$<HTMLElement>(".drop-indicator").forEach((i) => i.remove());
        });
      }

      const dateStr = s.updated_at ? new Date(s.updated_at).toLocaleDateString() : "";
      const tagChips = (s.tags || []).map((t: string) => `<span class="session-tag">#${escapeHtml(t)}</span>`).join("");
      el.innerHTML = `
        <div class="session-main">
          <div class="session-name">${escapeHtml(s.display_name)}</div>
          <div class="session-meta">${dateStr} · ${s.message_count} msgs${tagChips}</div>
        </div>
        <button class="session-menu-btn" title="Actions">⋮</button>
      `;
      el.querySelector(".session-main")?.addEventListener("click", () => loadSessionMessages(s.id, s.display_name));
      el.querySelector(".session-menu-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        showSessionMenu(s.id, s.display_name, e.target as HTMLElement);
      });
      container.appendChild(el);
    });
  } catch (e) {
    console.error("Failed to load sessions:", e);
  }
}

const MAX_INITIAL_MESSAGES = 100;

export async function loadSessionMessages(sessionId: string, displayName?: string, showAll = false) {
  try {
    const messages = await rpc.request.loadSession({ sessionId });
    AppState.currentSessionId = sessionId;
    updateDocumentTitle(displayName || "Hermes Agent");
    AppState.conversation = messages.filter((m) => m.role === "user" || m.role === "assistant");

    // Update UI active state
    $$<HTMLDivElement>(".session-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.id === sessionId);
    });

    const messagesEl = $("#messages")!;
    messagesEl.innerHTML = "";
    if (AppState.conversation.length === 0) {
      messagesEl.innerHTML = `
        <div class="empty-state">
          <h2>Empty Session</h2>
          <p>No messages found in this session.</p>
        </div>
      `;
      return;
    }

    let start = 0;
    let showLoadMore = false;
    if (!showAll && AppState.conversation.length > MAX_INITIAL_MESSAGES) {
      start = AppState.conversation.length - MAX_INITIAL_MESSAGES;
      showLoadMore = true;
    }

    if (showLoadMore) {
      const loadMore = document.createElement("div");
      loadMore.className = "load-more";
      loadMore.innerHTML = `<button class="small-btn">Load older messages (${start} hidden)</button>`;
      loadMore.querySelector("button")?.addEventListener("click", () => {
        loadSessionMessages(sessionId, displayName, true);
      });
      messagesEl.appendChild(loadMore);
    }

    AppState.conversation.slice(start).forEach((msg) => {
      const ts = msg.created_at || msg.timestamp || undefined;
      const contentDiv = appendMessage(msg.role as any, msg.content || "", ts);
      if (msg.reasoning) renderThinkingCard(contentDiv, msg.reasoning);
      postProcessMessage(contentDiv);
    });
    updateTokenUsageDisplay();
    renderTodos();
    loadDraft();
  } catch (e) {
    console.error("Failed to load session messages:", e);
  }
}

// ---------------------------------------------------------------------------
// Chat UI
// ---------------------------------------------------------------------------
export function showSessionMenu(sessionId: string, displayName: string, anchor: HTMLElement) {
  const existing = $(".session-action-menu");
  existing?.remove();

  const menu = document.createElement("div");
  menu.className = "session-action-menu";
  const rect = anchor.getBoundingClientRect();
  menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left - 120}px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:6px 0;z-index:1000;min-width:140px;box-shadow:0 8px 30px rgba(0,0,0,0.25);`;

  const projectSubItems = AppState.projects.map((p) => ({
    label: `  → ${p.name}`,
    action: async () => {
      await rpc.request.moveSessionToProject({ sessionId, projectId: p.id });
      await loadSessionHistory();
    },
  }));
  const actions = [
    { label: "Rename", action: () => renameSession(sessionId) },
    { label: "Duplicate", action: () => duplicateSession(sessionId) },
    { label: "Export JSON", action: () => exportSession(sessionId) },
    { label: "Pin / Unpin", action: () => togglePinSession(sessionId) },
    { label: "Archive / Unarchive", action: () => toggleArchiveSession(sessionId) },
    { label: "Tag", action: () => tagSession(sessionId) },
    ...(AppState.projects.length ? [{ label: "Move to project", action: () => {}, disabled: true } as any] : []),
    ...projectSubItems,
    { label: "Remove from project", action: async () => { await rpc.request.moveSessionToProject({ sessionId, projectId: null }); await loadSessionHistory(); } },
    { label: "Delete", action: () => deleteSession(sessionId), danger: true },
  ];

  actions.forEach((a) => {
    const btn = document.createElement("div");
    btn.className = "session-action-item";
    btn.textContent = a.label;
    if (a.danger) btn.style.color = "var(--error)";
    btn.addEventListener("click", async () => {
      menu.remove();
      await a.action();
    });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  const dismiss = () => menu.remove();
  setTimeout(() => document.addEventListener("click", dismiss, { once: true }), 0);
}

export async function renameSession(sessionId: string) {
  const name = prompt("New session name:");
  if (!name) return;
  await rpc.request.renameSession({ sessionId, name });
  await loadSessionHistory();
}

export async function togglePinSession(sessionId: string) {
  const el = $(`.session-item[data-id="${sessionId}"]`);
  const pinned = el?.classList.contains("pinned");
  await rpc.request.pinSession({ sessionId, pinned: !pinned });
  await loadSessionHistory();
}

export async function toggleArchiveSession(sessionId: string) {
  const el = $(`.session-item[data-id="${sessionId}"]`);
  const archived = el?.classList.contains("archived");
  await rpc.request.archiveSession({ sessionId, archived: !archived });
  await loadSessionHistory();
}

export async function tagSession(sessionId: string) {
  const raw = prompt("Tags (comma separated):");
  if (raw === null) return;
  const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
  await rpc.request.tagSession({ sessionId, tags });
  await loadSessionHistory();
}

export async function deleteSession(sessionId: string) {
  if (!confirm("Delete this session permanently?")) return;
  await rpc.request.deleteSession({ sessionId });
  if (AppState.currentSessionId === sessionId) newChat();
  await loadSessionHistory();
}

export async function duplicateSession(sessionId: string) {
  try {
    const res = await rpc.request.duplicateSession({ sessionId });
    if (res.success) {
      await loadSessionHistory();
      if (res.newSessionId) await loadSessionMessages(res.newSessionId);
    } else {
      alert("Duplicate failed: " + (res.error || "Unknown error"));
    }
  } catch (e: any) {
    alert("Duplicate failed: " + e.message);
  }
}

export async function exportSession(sessionId: string) {
  try {
    const data = await rpc.request.exportSession({ sessionId });
    if (data.error) {
      alert("Export failed: " + data.error);
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hermes-${sessionId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e: any) {
    alert("Export failed: " + e.message);
  }
}

export async function importSessionFromFile(file: File) {
  try {
    const text = await file.text();
    const res = await rpc.request.importSession({ data: text });
    if (res.success && res.newSessionId) {
      await loadSessionHistory();
      await loadSessionMessages(res.newSessionId);
    } else {
      alert("Import failed: " + (res.error || "Unknown error"));
    }
  } catch (e: any) {
    alert("Import failed: " + e.message);
  }
}

