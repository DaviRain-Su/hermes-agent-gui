// ---------------------------------------------------------------------------
import { $, $$, escapeHtml, updateDocumentTitle, showToast } from "./utils/dom.js";
import { formatContent, formatContentForPrint } from "./utils/format.js";
import {
  BackendStatus,
  ChatMessage,
  Attachment,
  MODEL_CONTEXT_LIMITS,
  SCROLL_PAUSE_THRESHOLD,
  MAX_INITIAL_MESSAGES,
  BUILTIN_SNIPPETS,
  AppState,
} from "./state.js";

// ---------------------------------------------------------------------------
// Simple HTTP-RPC client (replaces Electroview for Tauri/Linux compatibility)
// ---------------------------------------------------------------------------
const RPC_ENDPOINT = "http://127.0.0.1:55000/rpc";
let rpcReqId = 0;

async function rpcRequest(method: string, params?: any): Promise<any> {
  const id = ++rpcReqId;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = localStorage.getItem("hermes-auth-token");
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "request", id, method, params: params ?? {} }),
  });
  if (res.status === 401) {
    localStorage.removeItem("hermes-auth-token");
    showLoginOverlay();
    throw new Error("Session expired. Please sign in again.");
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(body.error);
  }
  return body.result;
}

const rpc = {
  request: new Proxy({} as any, {
    get: (_target, prop) => {
      return (params: any) => rpcRequest(String(prop), params);
    },
  }),
  send: {
    backendStatus: (status: BackendStatus) => {
      updateBackendStatusUI(status);
      if (status.running && !AppState.backendUrl) {
        AppState.backendUrl = status.url;
        initAfterBackendReady();
      }
    },
    backendLog: (msg: { stream: "stdout" | "stderr"; text: string }) => {
      console.log(`[Backend ${msg.stream}]`, msg.text);
    },
    installStatus: (status: { phase: string; progress?: number; message?: string; canCancel?: boolean; canRetry?: boolean }) => {
      handleInstallStatus(status);
    },
    installLog: (msg: { stream: "stdout" | "stderr"; text: string }) => {
      appendInstallLog(msg);
    },
  },
};

// ---------------------------------------------------------------------------
// Debug banner helpers
// ---------------------------------------------------------------------------
function setDebug(msg: string) {
  let banner = document.getElementById("debug-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "debug-banner";
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;background:#333;color:#0f0;padding:6px 12px;z-index:9999;font-family:monospace;font-size:12px;white-space:pre-wrap;";
    document.body.appendChild(banner);
  }
  banner.textContent = msg;
}

function getContextLimit(model: string): number {
  const key = Object.keys(MODEL_CONTEXT_LIMITS).find((k) => model.toLowerCase().includes(k));
  return key ? MODEL_CONTEXT_LIMITS[key] : MODEL_CONTEXT_LIMITS.default;
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
  loadProjectsData();
  loadSessionHistory();
  loadSkills();
  loadProfiles();
  loadWorkspace();
  // Check for updates once per session
  if (!sessionStorage.getItem("hermes-update-checked")) {
    try {
      const update = await rpc.request.checkForUpdates({});
      if (update.hasUpdate) {
        const banner = $("#update-banner");
        const text = $("#update-text");
        const link = $("#update-link") as HTMLAnchorElement | null;
        if (banner && text) {
          text.textContent = `Update available: v${update.latestVersion} (current v${update.currentVersion})`;
          if (link && update.url) link.href = update.url;
          banner.classList.remove("hidden");
        }
      }
    } catch {}
    sessionStorage.setItem("hermes-update-checked", "1");
  }
}

async function loadCurrentModel() {
  try {
    const cfg = await rpc.request.getCurrentModel({});
    AppState.currentModelConfig = { model: cfg.model || "", provider: cfg.provider || "" };
    const modelInput = $("#model-input") as HTMLInputElement | null;
    const providerSelect = $("#provider-select") as HTMLSelectElement | null;
    if (modelInput) modelInput.value = AppState.currentModelConfig.model;
    if (providerSelect) providerSelect.value = AppState.currentModelConfig.provider;
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
  if (!AppState.backendUrl) return;
  try {
    const res = await fetch(`${AppState.backendUrl}/v1/models`);
    const data = await res.json();
    // We don't use a dropdown for models anymore (free text input is more flexible),
    // but we could keep a datalist for suggestions.
  } catch (e) {
    console.error("Failed to load models:", e);
  }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
async function loadWorkspace() {
  try {
    const [data, git] = await Promise.all([
      rpc.request.listWorkspace({ path: AppState.workspacePath, sessionId: AppState.currentSessionId || undefined }),
      rpc.request.getGitInfo({ sessionId: AppState.currentSessionId || undefined }).catch(() => ({ branch: null, dirtyCount: 0 })),
    ]);
    const container = $("#workspace-list");
    if (!container) return;
    const entries = data.entries || [];
    if (entries.length === 0) {
      container.innerHTML = '<div class="panel-empty">No files</div>';
    } else {
      container.innerHTML = entries.map((e: any) => `
        <div class="workspace-item ${e.isDirectory ? 'folder' : 'file'}" data-path="${escapeHtml(e.relPath)}" data-dir="${e.isDirectory ? '1' : '0'}">
          <span>${e.isDirectory ? '📁' : '📄'} ${escapeHtml(e.name)}</span>
          <span class="ws-actions">
            <button data-action="rename" title="Rename">R</button>
            <button data-action="delete" title="Delete">✕</button>
          </span>
        </div>
      `).join("");
      container.querySelectorAll<HTMLDivElement>(".workspace-item").forEach((el) => {
        el.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest(".ws-actions")) return;
          const isDir = el.dataset.dir === "1";
          const p = el.dataset.path || "";
          if (isDir) {
            AppState.workspacePath = p;
            closePreview();
            loadWorkspace();
          } else {
            openPreview(p);
          }
        });
        el.querySelector<HTMLButtonElement>('[data-action="rename"]')?.addEventListener("click", (e) => {
          e.stopPropagation();
          renameWsEntry(el.dataset.path || "");
        });
        el.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteWsEntry(el.dataset.path || "");
        });
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const isDir = el.dataset.dir === "1";
          showWorkspaceContextMenu(e, el.dataset.path || "", isDir);
        });
      });
    }

    // Breadcrumb
    const bc = $("#workspace-breadcrumb");
    if (bc) {
      const parts = AppState.workspacePath.split("/").filter(Boolean);
      bc.innerHTML = `<span data-idx="-1">~</span>` + parts.map((p, i) => ` / <span data-idx="${i}">${escapeHtml(p)}</span>`).join("");
      bc.querySelectorAll("span").forEach((sp) => {
        sp.addEventListener("click", () => {
          const idx = parseInt(sp.dataset.idx || "-1", 10);
          AppState.workspacePath = parts.slice(0, idx + 1).join("/");
          closePreview();
          loadWorkspace();
        });
      });
    }

    // Git badge
    const gb = $("#git-badge");
    if (gb) {
      if (git.branch) {
        gb.textContent = `${git.branch}${git.dirtyCount ? ` (+${git.dirtyCount})` : ''}`;
      } else {
        gb.textContent = "";
      }
    }
  } catch (e) {
    console.error("Failed to load workspace:", e);
    $("#workspace-list")!.innerHTML = '<div class="panel-empty">Error loading workspace</div>';
  }
}

async function openPreview(path: string) {
  try {
    const data = await rpc.request.readWorkspaceFile({ path, sessionId: AppState.currentSessionId || undefined });
    if (data.error) {
      alert(data.error);
      return;
    }
    const preview = $("#workspace-preview");
    const filename = $("#preview-filename");
    const contentEl = $("#preview-content");
    const editor = $("#preview-editor") as HTMLTextAreaElement | null;
    const saveBtn = $("#preview-save");
    if (!preview || !filename || !contentEl) return;

    preview.classList.remove("hidden");
    filename.textContent = path.split("/").pop() || path;
    AppState.previewHasChanges = false;

    const isMarkdown = path.toLowerCase().endsWith(".md");
    const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"].some((e) => path.toLowerCase().endsWith(e));

    if (isImage) {
      editor?.classList.add("hidden");
      saveBtn?.classList.add("hidden");
      contentEl.innerHTML = `<img src="${escapeHtml(data.content || "")}" style="max-width:100%;border-radius:8px;display:block;" alt="${escapeHtml(path)}" />`;
    } else {
      editor?.classList.remove("hidden");
      saveBtn?.classList.remove("hidden");
      if (editor) editor.value = data.content || "";
      if (isMarkdown) {
        contentEl.innerHTML = formatContent(data.content || "");
      } else {
        contentEl.innerHTML = `<pre><code>${escapeHtml(data.content || "")}</code></pre>`;
      }
      if (editor) {
        editor.oninput = () => {
          AppState.previewHasChanges = true;
          saveBtn?.classList.remove("hidden");
        };
      }
    }
  } catch (e: any) {
    alert("Preview failed: " + e.message);
  }
}

function closePreview() {
  const preview = $("#workspace-preview");
  if (preview) preview.classList.add("hidden");
  AppState.previewHasChanges = false;
}

async function savePreview() {
  const editor = $("#preview-editor") as HTMLTextAreaElement | null;
  const filename = $("#preview-filename");
  if (!editor || !filename) return;
  const name = filename.textContent || "";
  const path = AppState.workspacePath ? `${AppState.workspacePath}/${name}` : name;
  try {
    const res = await rpc.request.saveWorkspaceFile({
      path,
      content: editor.value,
      sessionId: AppState.currentSessionId || undefined,
    });
    if (res.success) {
      AppState.previewHasChanges = false;
      $("#preview-save")?.classList.add("hidden");
    } else {
      alert("Save failed: " + (res.error || "Unknown error"));
    }
  } catch (e: any) {
    alert("Save failed: " + e.message);
  }
}

async function createWsFile() {
  const name = prompt("New file name:");
  if (!name) return;
  const path = AppState.workspacePath ? `${AppState.workspacePath}/${name}` : name;
  try {
    const res = await rpc.request.saveWorkspaceFile({ path, content: "", sessionId: AppState.currentSessionId || undefined });
    if (res.success) loadWorkspace();
  } catch (e: any) {
    alert("Create failed: " + e.message);
  }
}

async function createWsDir() {
  const name = prompt("New folder name:");
  if (!name) return;
  const path = AppState.workspacePath ? `${AppState.workspacePath}/${name}` : name;
  try {
    const res = await rpc.request.createWorkspaceDir({ path, sessionId: AppState.currentSessionId || undefined });
    if (res.success) loadWorkspace();
  } catch (e: any) {
    alert("Create failed: " + e.message);
  }
}

async function renameWsEntry(path: string) {
  const name = path.split("/").pop() || path;
  const newName = prompt("Rename:", name);
  if (!newName || newName === name) return;
  try {
    const res = await rpc.request.renameWorkspaceFile({ path, newName, sessionId: AppState.currentSessionId || undefined });
    if (res.success) {
      if (AppState.previewHasChanges && $("#preview-filename")?.textContent === name) closePreview();
      loadWorkspace();
    } else {
      alert("Rename failed: " + (res.error || "Unknown error"));
    }
  } catch (e: any) {
    alert("Rename failed: " + e.message);
  }
}

async function deleteWsEntry(path: string) {
  if (!confirm(`Delete "${path.split("/").pop()}?"`)) return;
  try {
    const res = await rpc.request.deleteWorkspaceFile({ path, sessionId: AppState.currentSessionId || undefined });
    if (res.success) {
      if ($("#preview-filename")?.textContent === path.split("/").pop()) closePreview();
      loadWorkspace();
    } else {
      alert("Delete failed: " + (res.error || "Unknown error"));
    }
  } catch (e: any) {
    alert("Delete failed: " + e.message);
  }
}

function hideWorkspaceContextMenu() {
  $(".workspace-context-menu")?.remove();
}

function showWorkspaceContextMenu(e: MouseEvent, path: string, isDirectory: boolean) {
  e.preventDefault();
  hideWorkspaceContextMenu();
  const menu = document.createElement("div");
  menu.className = "workspace-context-menu";
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;`;
  const items: { label: string; action: () => void }[] = [];
  items.push({
    label: isDirectory ? "Open folder" : "Open file",
    action: () => {
      if (isDirectory) {
        AppState.workspacePath = path;
        closePreview();
        loadWorkspace();
      } else {
        openPreview(path);
      }
    },
  });
  items.push({ label: "Rename", action: () => renameWsEntry(path) });
  items.push({ label: "Delete", action: () => deleteWsEntry(path) });
  items.forEach((it) => {
    const row = document.createElement("div");
    row.className = "context-menu-item";
    row.textContent = it.label;
    row.addEventListener("click", () => {
      it.action();
      hideWorkspaceContextMenu();
    });
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
}

async function loadTasks() {
  try {
    const data = await rpc.request.listCron({});
    const container = $("#tasks-list");
    if (!container) return;
    const jobs = data.jobs || [];
    if (jobs.length === 0) {
      container.innerHTML = '<div class="panel-empty">No tasks</div>';
      return;
    }
    container.innerHTML = jobs.map((j: any) => {
      const isPaused = j.state === "paused" || j.enabled === false;
      return `
        <div class="task-item" data-job-id="${escapeHtml(j.id || j.job_id || '')}">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="task-name" style="font-weight:500;">${escapeHtml(j.name || j.id || 'Untitled')}</span>
            <span class="task-actions">
              <button data-action="run" title="Run">▸</button>
              ${isPaused ? '<button data-action="resume" title="Resume">▶</button>' : '<button data-action="pause" title="Pause">⏸</button>'}
              <button data-action="edit" title="Edit">✎</button>
              <button data-action="output" title="Output">📄</button>
              <button data-action="delete" title="Delete">✕</button>
            </span>
          </div>
          <div class="task-schedule" style="font-size:11px;color:var(--text-secondary);">${escapeHtml(j.schedule_display || j.schedule || j.cron || '')} · ${isPaused ? 'paused' : 'scheduled'}</div>
        </div>
      `;
    }).join("");
    container.querySelectorAll<HTMLDivElement>(".task-item").forEach((el) => {
      const jobId = el.dataset.jobId || "";
      el.querySelector<HTMLButtonElement>('[data-action="run"]')?.addEventListener("click", (e) => { e.stopPropagation(); runTask(jobId); });
      el.querySelector<HTMLButtonElement>('[data-action="pause"]')?.addEventListener("click", (e) => { e.stopPropagation(); pauseTask(jobId); });
      el.querySelector<HTMLButtonElement>('[data-action="resume"]')?.addEventListener("click", (e) => { e.stopPropagation(); resumeTask(jobId); });
      el.querySelector<HTMLButtonElement>('[data-action="edit"]')?.addEventListener("click", (e) => { e.stopPropagation(); editTask(jobId); });
      el.querySelector<HTMLButtonElement>('[data-action="output"]')?.addEventListener("click", (e) => { e.stopPropagation(); showTaskOutput(jobId); });
      el.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener("click", (e) => { e.stopPropagation(); deleteTask(jobId); });
    });
  } catch (e) {
    console.error("Failed to load tasks:", e);
    $("#tasks-list")!.innerHTML = '<div class="panel-empty">Error loading tasks</div>';
  }
}

async function runTask(jobId: string) {
  try {
    const res = await rpc.request.runCron({ jobId });
    if (res.ok) loadTasks();
    else alert(res.error || "Run failed");
  } catch (e: any) {
    alert("Run failed: " + e.message);
  }
}

async function pauseTask(jobId: string) {
  try {
    const res = await rpc.request.pauseCron({ jobId });
    if (res.ok) loadTasks();
    else alert(res.error || "Pause failed");
  } catch (e: any) {
    alert("Pause failed: " + e.message);
  }
}

async function resumeTask(jobId: string) {
  try {
    const res = await rpc.request.resumeCron({ jobId });
    if (res.ok) loadTasks();
    else alert(res.error || "Resume failed");
  } catch (e: any) {
    alert("Resume failed: " + e.message);
  }
}

async function editTask(jobId: string) {
  const schedule = prompt("New schedule (e.g. every 2h):");
  if (schedule === null) return;
  const promptText = prompt("New prompt (optional):");
  if (promptText === null) return;
  const updates: any = {};
  if (schedule.trim()) updates.schedule = schedule.trim();
  if (promptText.trim()) updates.prompt = promptText.trim();
  if (Object.keys(updates).length === 0) return;
  try {
    const res = await rpc.request.updateCron({ jobId, updates });
    if (res.ok) loadTasks();
    else alert(res.error || "Update failed");
  } catch (e: any) {
    alert("Update failed: " + e.message);
  }
}

async function showTaskOutput(jobId: string) {
  const outEl = $("#task-output");
  if (!outEl) return;
  try {
    const data = await rpc.request.getCronOutput({ jobId });
    const outputs = data.outputs || [];
    if (outputs.length === 0) {
      outEl.innerHTML = '<div class="panel-empty">No output yet</div>';
    } else {
      outEl.innerHTML = outputs.map((o: any) => `
        <div style="margin-bottom:8px;border-bottom:1px solid var(--border);padding-bottom:4px;">
          <div style="font-size:10px;color:var(--text-secondary);">${escapeHtml(o.time)}</div>
          <pre style="margin:4px 0;white-space:pre-wrap;">${escapeHtml(o.content.slice(0, 300))}${o.content.length > 300 ? '...' : ''}</pre>
        </div>
      `).join("");
    }
    outEl.classList.remove("hidden");
  } catch (e: any) {
    outEl.innerHTML = '<div class="panel-empty">Error loading output</div>';
    outEl.classList.remove("hidden");
  }
}

async function deleteTask(jobId: string) {
  if (!confirm("Delete this cron job?")) return;
  try {
    const res = await rpc.request.deleteCron({ jobId });
    if (res.ok) loadTasks();
    else alert(res.error || "Delete failed");
  } catch (e: any) {
    alert("Delete failed: " + e.message);
  }
}

function extractTodos() {
  const todos: { text: string; done: boolean; sourceIdx: number }[] = [];
  AppState.conversation.forEach((msg, idx) => {
    const lines = (msg.content || "").split("\n");
    lines.forEach((line) => {
      const m = line.match(/^(\s*)-?\s*\[([ xX])\]\s+(.+)$/);
      if (m) {
        todos.push({ text: m[3].trim(), done: m[2].toLowerCase() === "x", sourceIdx: idx });
      }
    });
  });
  return todos;
}

function renderTodos() {
  const container = $("#todos-list");
  if (!container) return;
  const todos = extractTodos();
  if (todos.length === 0) {
    container.innerHTML = '<div class="panel-empty">No todos in current session</div>';
    return;
  }
  container.innerHTML = todos.map((t, i) => `
    <div class="todo-item ${t.done ? 'done' : ''}" data-idx="${i}">
      <input type="checkbox" ${t.done ? 'checked' : ''} />
      <span>${escapeHtml(t.text)}</span>
    </div>
  `).join("");
  container.querySelectorAll<HTMLDivElement>(".todo-item").forEach((el) => {
    const cb = el.querySelector("input") as HTMLInputElement | null;
    cb?.addEventListener("change", () => {
      // Visual toggle only; editing source message is complex
      el.classList.toggle("done", cb.checked);
    });
  });
}

async function loadSpaces() {
  try {
    const data = await rpc.request.listSpaces({});
    const container = $("#spaces-list");
    if (!container) return;
    const spaces = data.spaces || [];
    if (spaces.length === 0) {
      container.innerHTML = '<div class="panel-empty">No spaces</div>';
      return;
    }
    container.innerHTML = spaces.map((s: any, i: number) => `
      <div class="space-item" data-idx="${i}" data-path="${escapeHtml(s.path)}">
        <span>${escapeHtml(s.name || s.path)}</span>
        <span class="space-actions">
          <button data-action="rename" title="Rename">R</button>
          <button data-action="delete" title="Delete">✕</button>
        </span>
      </div>
    `).join("");
    container.querySelectorAll<HTMLDivElement>(".space-item").forEach((el) => {
      const path = el.dataset.path || "";
      el.querySelector<HTMLButtonElement>('[data-action="rename"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        renameSpace(path);
      });
      el.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        removeSpace(path);
      });
      el.addEventListener("click", () => {
        AppState.workspacePath = "";
        closePreview();
        // Set this space as active? For now just refresh workspace
        loadWorkspace();
      });
    });
  } catch (e) {
    console.error("Failed to load spaces:", e);
    $("#spaces-list")!.innerHTML = '<div class="panel-empty">Error loading spaces</div>';
  }
}

async function addSpace() {
  const input = $("#space-path-input") as HTMLInputElement | null;
  const path = input?.value.trim();
  if (!path) return;
  try {
    const res = await rpc.request.addSpace({ path, name: "" });
    if (res.success) {
      input && (input.value = "");
      loadSpaces();
    } else {
      alert(res.error || "Add failed");
    }
  } catch (e: any) {
    alert("Add failed: " + e.message);
  }
}

async function renameSpace(path: string) {
  const name = prompt("New name:");
  if (!name) return;
  try {
    const res = await rpc.request.renameSpace({ path, name });
    if (res.success) loadSpaces();
    else alert(res.error || "Rename failed");
  } catch (e: any) {
    alert("Rename failed: " + e.message);
  }
}

async function removeSpace(path: string) {
  if (!confirm("Remove this space from the list?")) return;
  try {
    const res = await rpc.request.removeSpace({ path });
    if (res.success) loadSpaces();
    else alert(res.error || "Remove failed");
  } catch (e: any) {
    alert("Remove failed: " + e.message);
  }
}


async function loadMemory() {
  try {
    const data = await rpc.request.getMemory({ section: AppState.activeMemorySection });
    const editor = $("#memory-editor") as HTMLTextAreaElement | null;
    if (editor) editor.value = data.content || "";
  } catch (e) {
    console.error("Failed to load memory:", e);
  }
}

async function saveMemory() {
  const editor = $("#memory-editor") as HTMLTextAreaElement | null;
  if (!editor) return;
  try {
    const res = await rpc.request.saveMemory({ section: AppState.activeMemorySection, content: editor.value });
    if (res.success) {
      alert("Memory saved.");
    } else {
      alert("Save failed: " + (res.error || "Unknown error"));
    }
  } catch (e: any) {
    alert("Save failed: " + e.message);
  }
}

async function loadProfiles() {
  try {
    const data = await rpc.request.listProfiles({});
    const container = $("#profile-list");
    if (!container) return;
    const profiles = data.profiles || [];
    container.innerHTML = profiles.map((p: any) => `
      <div class="profile-item ${p.active ? 'active' : ''}" data-name="${escapeHtml(p.name)}">
        <span class="profile-dot ${p.active ? 'on' : ''}"></span>
        <span class="profile-name">${escapeHtml(p.name)}</span>
        ${p.active ? '<span class="profile-badge">active</span>' : ''}
      </div>
    `).join("");
    container.querySelectorAll<HTMLDivElement>(".profile-item").forEach((el) => {
      el.addEventListener("click", async () => {
        const name = el.dataset.name || "";
        if (!name) return;
        await rpc.request.switchProfile({ name });
        await loadProfiles();
      });
    });
  } catch (e) {
    console.error("Failed to load profiles:", e);
    $("#profile-list")!.innerHTML = '<div class="panel-empty">Error loading profiles</div>';
  }
}

async function createProfile() {
  const input = $("#new-profile-name") as HTMLInputElement | null;
  const name = input?.value.trim();
  if (!name) return;
  try {
    await rpc.request.createProfile({ name });
    input && (input.value = "");
    await loadProfiles();
  } catch (e: any) {
    alert("Create profile failed: " + e.message);
  }
}

async function deleteProfile(name: string) {
  if (!confirm(`Delete profile "${name}"?`)) return;
  try {
    await rpc.request.deleteProfile({ name });
    await loadProfiles();
  } catch (e: any) {
    alert("Delete profile failed: " + e.message);
  }
}

async function loadSkills() {
  try {
    const data = await rpc.request.listSkills({});
    renderSkillsList(data.skills || []);
  } catch (e) {
    console.error("Failed to load skills:", e);
    renderSkillsList([]);
  }
}

function renderSkillsList(skills: any[]) {
  const container = $("#skills-list");
  if (!container) return;

  if (skills.length === 0) {
    container.innerHTML = '<div class="skills-empty">No skills installed</div>';
    return;
  }

  container.innerHTML = "";
  skills.forEach((skill) => {
    const isDisabled = skill.enabled === false || skill.disabled === true;
    const el = document.createElement("div");
    el.className = `skill-item ${isDisabled ? "disabled" : ""}`;
    el.title = skill.description || "";
    el.dataset.skillName = skill.name || "";

    const actionsHtml = `
      <div class="skill-actions">
        <button class="skill-action-btn skill-btn-use" title="Use">▸</button>
        <button class="skill-action-btn skill-btn-toggle" title="${isDisabled ? "Enable" : "Disable"}">${isDisabled ? "◯" : "◉"}</button>
        <button class="skill-action-btn skill-btn-update" title="Update">↻</button>
        <button class="skill-action-btn skill-btn-uninstall" title="Uninstall">✕</button>
      </div>
    `;

    el.innerHTML = `
      <div class="skill-name">${escapeHtml(skill.name || "Unnamed")}</div>
      <div class="skill-desc">${escapeHtml((skill.description || "").slice(0, 60))}</div>
      ${actionsHtml}
    `;

    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".skill-actions")) return;
      const input = $("#message-input") as HTMLTextAreaElement | null;
      if (!input) return;
      const slug = (skill.name || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      input.value = `/${slug} `;
      input.focus();
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    });

    el.querySelector(".skill-btn-use")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const input = $("#message-input") as HTMLTextAreaElement | null;
      if (!input) return;
      const slug = (skill.name || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      input.value = `/${slug} `;
      input.focus();
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    });

    el.querySelector(".skill-btn-toggle")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSkill(skill.name || "", isDisabled);
    });

    el.querySelector(".skill-btn-update")?.addEventListener("click", (e) => {
      e.stopPropagation();
      updateSkill(skill.name || "");
    });

    el.querySelector(".skill-btn-uninstall")?.addEventListener("click", (e) => {
      e.stopPropagation();
      uninstallSkill(skill.name || "");
    });

    container.appendChild(el);
  });
}

async function toggleSkill(name: string, currentlyDisabled: boolean) {
  try {
    if (currentlyDisabled) {
      await rpc.request.enableSkill({ name });
    } else {
      await rpc.request.disableSkill({ name });
    }
    loadSkills();
  } catch (e: any) {
    alert(currentlyDisabled ? "Enable failed" : "Disable failed");
    console.error(e);
  }
}

async function updateSkill(name: string) {
  try {
    const res = await rpc.request.updateSkill({ name });
    if (res.success) {
      loadSkills();
    } else {
      alert(res.error || "Update failed");
    }
  } catch (e: any) {
    alert("Update failed");
    console.error(e);
  }
}

async function uninstallSkill(name: string) {
  if (!confirm(`Uninstall skill "${name}"?`)) return;
  try {
    const res = await rpc.request.uninstallSkill({ name });
    if (res.success) {
      loadSkills();
    } else {
      alert(res.error || "Uninstall failed");
    }
  } catch (e: any) {
    alert("Uninstall failed");
    console.error(e);
  }
}

async function installNewSkill() {
  const input = $("#skill-install-input") as HTMLInputElement | null;
  if (!input) return;
  const identifier = input.value.trim();
  if (!identifier) return;
  input.value = "";
  try {
    const res = await rpc.request.installSkill({ identifier });
    if (res.success) {
      loadSkills();
    } else {
      alert(res.error || "Install failed");
    }
  } catch (e: any) {
    alert("Install failed");
    console.error(e);
  }
}

function toggleSkillsPanel() {
  const wrapper = $(".skills-wrapper");
  wrapper?.classList.toggle("collapsed");
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async function loadProjectsData() {
  try {
    const res = await rpc.request.getProjects({});
    AppState.projects = res.AppState.projects || [];
    renderProjectsBar();
  } catch (e) {
    console.error("Failed to load AppState.projects:", e);
  }
}

function renderProjectsBar() {
  const bar = $("#AppState.projects-bar");
  const list = $("#AppState.projects-list");
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

async function createProjectFromPrompt() {
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
async function loadSessionHistory() {
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

async function loadSessionMessages(sessionId: string, displayName?: string, showAll = false) {
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
function toggleTTS(text: string, btn: HTMLButtonElement) {
  const synth = window.speechSynthesis;
  if (!synth) return;
  if (btn.classList.contains("playing")) {
    synth.cancel();
    btn.classList.remove("playing");
    btn.textContent = "🔊";
    return;
  }
  // Stop any other playing button
  $$(".tts-btn.playing").forEach((b) => {
    b.classList.remove("playing");
    b.textContent = "🔊";
  });
  const stripMarkdown = (s: string) => s.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]+`/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[#*_\-\[\]]/g, " ").replace(/\s+/g, " ").trim();
  const utter = new SpeechSynthesisUtterance(stripMarkdown(text));
  utter.lang = "zh-CN";
  utter.onend = () => {
    btn.classList.remove("playing");
    btn.textContent = "🔊";
  };
  utter.onerror = () => {
    btn.classList.remove("playing");
    btn.textContent = "🔊";
  };
  btn.classList.add("playing");
  btn.textContent = "⏹";
  synth.cancel();
  synth.speak(utter);
}

function appendMessage(role: "user" | "assistant", content: string, timestamp?: string): HTMLElement {
  const messagesEl = $("#messages")!;

  const emptyState = messagesEl.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "U" : "H";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const showTimestamps = localStorage.getItem("hermes-show-timestamps") !== "0";
  if (timestamp && showTimestamps) {
    const d = new Date(timestamp);
    const timeStr = isNaN(d.getTime()) ? String(timestamp) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = isNaN(d.getTime()) ? '' : d.toLocaleDateString();
    const timeSpan = document.createElement("span");
    timeSpan.className = "message-time";
    timeSpan.textContent = timeStr;
    timeSpan.title = dateStr ? `${dateStr} ${timeStr}` : timeStr;
    meta.appendChild(timeSpan);
  }

  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";
  contentDiv.innerHTML = formatContent(content);

  wrapper.appendChild(avatar);
  wrapper.appendChild(meta);
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const replyBtn = document.createElement("button");
  replyBtn.textContent = "Reply";
  replyBtn.addEventListener("click", () => replyToMessage(wrapper));
  actions.appendChild(replyBtn);
  const copyBtn = document.createElement("button");
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(content);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    } catch {
      showToast("Copy failed");
    }
  });
  actions.appendChild(copyBtn);
  if (role === "user") {
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => editMessage(wrapper));
    actions.appendChild(editBtn);
  }
  wrapper.appendChild(actions);
  if (role === "assistant") {
    const ttsBtn = document.createElement("button");
    ttsBtn.className = "tts-btn";
    ttsBtn.textContent = "🔊";
    ttsBtn.title = "Read aloud";
    ttsBtn.addEventListener("click", () => toggleTTS(content, ttsBtn));
    contentDiv.appendChild(ttsBtn);
  }
  wrapper.appendChild(contentDiv);
  messagesEl.appendChild(wrapper);
  if (!AppState.userScrolledUp) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  updateScrollIndicator();

  // Desktop notification for assistant messages when hidden/unfocused
  if (role === "assistant" && document.hidden) {
    const api = (window as any).electronAPI;
    if (api?.showNotification) {
      const snippet = content.replace(/[#*_`\[\]()>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      api.showNotification("Hermes Agent", snippet || "New message");
    }
    if (localStorage.getItem("hermes-notify-sound") === "1") {
      playNotificationSound();
    }
  }

  // Render mermaid diagrams inside this message
  if ((window as any).mermaid) {
    try {
      (window as any).mermaid.run({ nodes: contentDiv.querySelectorAll('.mermaid') });
      enhanceMermaidBlocks(contentDiv);
    } catch {}
  }

  // Syntax highlight code blocks
  if ((window as any).Prism) {
    try {
      (window as any).Prism.highlightAllUnder(contentDiv);
    } catch {}
  }

  enhanceCodeBlocks(contentDiv);

  return contentDiv;
}

function editMessage(wrapper: HTMLElement) {
  if (AppState.activeStreamController) {
    alert("Cannot edit while a response is streaming.");
    return;
  }
  const messagesEl = $("#messages")!;
  const allMessages = Array.from(messagesEl.querySelectorAll(".message"));
  const idx = allMessages.indexOf(wrapper);
  if (idx < 0 || idx >= AppState.conversation.length) return;
  // Truncate AppState.conversation and DOM after this message
  AppState.conversation = AppState.conversation.slice(0, idx + 1);
  for (let i = allMessages.length - 1; i > idx; i--) {
    allMessages[i].remove();
  }
  const content = AppState.conversation[idx]?.content || "";
  const input = $("#message-input") as HTMLTextAreaElement | null;
  if (input) {
    input.value = content;
    input.focus();
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }
}

function renderErrorBanner() {
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

function formatContent(text: string): string {
  let html = escapeHtml(text);

  // Code blocks
  const langMap: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    sh: "bash",
    shell: "bash",
    yml: "yaml",
  };
  html = html.replace(
    /```(\w+)?\n([\s\S]*?)```/g,
    (_, lang, code) => {
      const lg = (lang || "").toLowerCase();
      const safeCode = escapeHtml(code.trim());
      if (lg === "mermaid") {
        return `<div class="mermaid">${safeCode}</div>`;
      }
      const prismLang = langMap[lg] || lg || "text";
      const safeLang = escapeHtml(lang || "");
      const isArtifact = lg === "html" || lg === "svg";
      const isPython = lg === "python" || lg === "py";
      const previewBtn = isArtifact
        ? `<button class="artifact-preview-btn" data-action="toggle-artifact">Preview</button>`
        : "";
      const runBtn = isPython
        ? `<button class="exec-run-btn" data-action="run-python">▶ Run</button>`
        : "";
      const artifactFrame = isArtifact
        ? `<div class="artifact-preview hidden"><iframe sandbox="allow-scripts" srcdoc="${safeCode.replace(/"/g, '&quot;')}" style="width:100%;height:220px;border:none;border-radius:0 0 8px 8px;background:#fff;"></iframe></div>`
        : "";
      const execOutput = isPython
        ? `<div class="exec-output hidden"><pre class="exec-stdout"></pre><pre class="exec-stderr"></pre></div>`
        : "";
      return `<div class="code-block ${isArtifact ? "artifact-block" : ""}"><div class="code-header"><span class="code-lang">${safeLang}</span>${previewBtn}${runBtn}<button class="code-copy-btn" onclick="navigator.clipboard.writeText(this.closest('.code-block').querySelector('code').innerText).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)}).catch(()=>this.textContent='Failed')">Copy</button></div><pre><code class="language-${prismLang}">${safeCode}</code></pre>${artifactFrame}${execOutput}</div>`;
    }
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

function enhanceCodeBlocks(contentDiv: HTMLElement) {
  contentDiv.querySelectorAll("pre").forEach((pre) => {
    if (pre.closest(".code-block-wrapper")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";
    pre.parentNode?.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);
    const codeEl = pre.querySelector("code");
    const langMatch = codeEl?.className.match(/language-(\w+)/);
    if (langMatch) {
      const badge = document.createElement("span");
      badge.className = "code-lang-badge";
      badge.textContent = langMatch[1];
      wrapper.appendChild(badge);
    }
    const btn = document.createElement("button");
    btn.className = "copy-code-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      const code = pre.querySelector("code")?.textContent || pre.textContent || "";
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = "Copy"), 1500);
      } catch {
        showToast("Copy failed");
      }
    });
    wrapper.appendChild(btn);
  });
}

function enhanceMermaidBlocks(contentDiv: HTMLElement) {
  contentDiv.querySelectorAll(".mermaid").forEach((el) => {
    if (el.closest(".mermaid-wrapper")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "mermaid-wrapper";
    el.parentNode?.insertBefore(wrapper, el);
    wrapper.appendChild(el);
    const btn = document.createElement("button");
    btn.className = "mermaid-export-btn";
    btn.textContent = "↓ SVG";
    btn.title = "Download SVG";
    btn.addEventListener("click", () => {
      const svg = el.querySelector("svg");
      if (!svg) return;
      const serializer = new XMLSerializer();
      const source = serializer.serializeToString(svg);
      const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `diagram-${Date.now()}.svg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
    wrapper.appendChild(btn);
  });
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
          if (/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u.test(inner.trim())) {
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
// SSE Streaming Parser with live tool-call detection
// ---------------------------------------------------------------------------
class MessageBlockBuilder {
  container: HTMLElement;
  blocks: Array<
    | { type: "text"; content: string; el: HTMLElement }
    | { type: "tool"; name: string; el: HTMLElement }
    | { type: "subagent"; name: string; el: HTMLElement }
  > = [];
  private _removedThinking = false;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  private _ensureThinkingRemoved() {
    if (this._removedThinking) return;
    this._removedThinking = true;
    const thinking = this.container.querySelector(".thinking");
    if (thinking) thinking.remove();
  }

  appendText(text: string) {
    this._ensureThinkingRemoved();
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.type === "text") {
      last.content += text;
      last.el.innerHTML = formatContent(last.content);
    } else {
      const el = document.createElement("div");
      el.className = "message-text-block";
      el.innerHTML = formatContent(text);
      this.container.appendChild(el);
      this.blocks.push({ type: "text", content: text, el });
    }
  }

  addTool(name: string) {
    this._ensureThinkingRemoved();
    const el = document.createElement("div");
    el.className = "tool-call-card running";
    el.innerHTML = `
      <div class="tool-call-header" onclick="this.closest('.tool-call-card').classList.toggle('open')">
        <span class="tool-call-title">${escapeHtml(name)}</span>
        <span class="tool-call-arrow">▶</span>
      </div>
      <div class="tool-call-body">Executing via Hermes Agent tool runtime.</div>
    `;
    this.container.appendChild(el);
    this.blocks.push({ type: "tool", name, el });
  }

  addSubagent(name: string) {
    this._ensureThinkingRemoved();
    const el = document.createElement("div");
    el.className = "subagent-card running";
    el.innerHTML = `
      <div class="subagent-header" onclick="this.closest('.subagent-card').classList.toggle('open')">
        <span class="subagent-label">Subagent</span>
        <span class="subagent-title">${escapeHtml(name)}</span>
        <span class="tool-call-arrow">▶</span>
      </div>
      <div class="subagent-body">Delegated task running via Hermes subagent.</div>
    `;
    this.container.appendChild(el);
    this.blocks.push({ type: "subagent", name, el });
  }

  completeTools() {
    this.blocks.forEach((b) => {
      if (b.type === "tool" || b.type === "subagent") {
        b.el.classList.remove("running");
        const body = b.el.querySelector(b.type === "tool" ? ".tool-call-body" : ".subagent-body");
        if (body) body.textContent = b.type === "tool" ? "Tool execution completed." : "Subagent task completed.";
      }
    });
  }

  processBuffer() {
    const last = this.blocks[this.blocks.length - 1];
    if (!last || last.type !== "text") return;

    const toolPattern = /(?:^|\n)`([\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}][^`]+)`\n/u;
    const subagentPattern = /(?:^|\n)▶ Subagent:\s*([^\n]+)\n/;

    while (true) {
      const toolMatch = last.content.match(toolPattern);
      const subagentMatch = last.content.match(subagentPattern);

      let match: RegExpMatchArray | null = null;
      let type: "tool" | "subagent" = "tool";
      let captureIndex = 1;

      if (toolMatch && subagentMatch) {
        const tIdx = toolMatch.index ?? Infinity;
        const sIdx = subagentMatch.index ?? Infinity;
        if (tIdx <= sIdx) {
          match = toolMatch;
          type = "tool";
        } else {
          match = subagentMatch;
          type = "subagent";
        }
      } else if (toolMatch) {
        match = toolMatch;
        type = "tool";
      } else if (subagentMatch) {
        match = subagentMatch;
        type = "subagent";
      }

      if (!match) break;

      const idx = match.index ?? 0;
      const raw = match[0];
      const before = last.content.slice(0, idx);
      const after = last.content.slice(idx + raw.length);

      last.content = before.replace(/\n+$/, "");
      last.el.innerHTML = formatContent(last.content);

      if (type === "tool") this.addTool(match[captureIndex]);
      else this.addSubagent(match[captureIndex].trim());

      const remaining = after.replace(/^\n+/, "");
      if (remaining) {
        const el = document.createElement("div");
        el.className = "message-text-block";
        el.innerHTML = formatContent(remaining);
        this.container.appendChild(el);
        this.blocks.push({ type: "text", content: remaining, el });
      } else {
        const el = document.createElement("div");
        el.className = "message-text-block";
        el.innerHTML = "";
        this.container.appendChild(el);
        this.blocks.push({ type: "text", content: "", el });
      }
    }
  }
}

async function streamChatCompletion(body: any, contentDiv: HTMLElement, signal: AbortSignal, targetSessionId: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AppState.currentSessionId) {
    headers["X-Hermes-Session-Id"] = AppState.currentSessionId;
  }

  const response = await fetch(`${AppState.backendUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    let errMsg = errText;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson.error?.message || errJson.message || errText;
    } catch {
      // not JSON, use raw text
    }
    throw new Error(errMsg || `HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";

  // If backend returned plain JSON (non-streaming), parse it directly.
  if (!contentType.includes("text/event-stream") || !response.body) {
    const json: any = await response.json().catch(() => ({}));
    const content = json.choices?.[0]?.message?.content || json.message || JSON.stringify(json);
    if (typeof content === "string") {
      contentDiv.innerHTML = formatContent(content);
      _postProcessInlineToolCodes(contentDiv);
    } else {
      contentDiv.innerHTML = `<p style="color:#ef4444">Unexpected response format</p>`;
    }
    const sessionHeader = response.headers.get("X-Hermes-Session-Id");
    if (sessionHeader) {
      AppState.currentSessionId = sessionHeader;
      loadSessionHistory();
    }
    return typeof content === "string" ? content : "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const builder = new MessageBlockBuilder(contentDiv);
  let lastDataTime = Date.now();
  const readTimeoutMs = 40000;

  async function readNext() {
    const remaining = readTimeoutMs - (Date.now() - lastDataTime);
    if (remaining <= 0) throw new Error("Stream read timeout (no data from backend)");
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Stream read timeout (no data from backend)")), remaining)
      ),
    ]);
    return result;
  }

  while (true) {
    const { done, value } = await readNext();
    if (done) break;

    lastDataTime = Date.now();
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
            builder.appendText(delta.content);
            builder.processBuffer();
            const messagesEl = $("#messages")!;
            if (!AppState.userScrolledUp) messagesEl.scrollTop = messagesEl.scrollHeight;
            updateScrollIndicator();
          }
          // Some backends wrap errors inside SSE data
          if (parsed.error) {
            throw new Error(parsed.error.message || JSON.stringify(parsed.error));
          }
        } catch (e) {
          if (e instanceof Error && e.message !== "Unexpected token") {
            throw e;
          }
          // ignore malformed JSON lines
        }
      }
    }
  }

  builder.completeTools();

  // Fallback: post-process any inline emoji code patterns in remaining text blocks
  builder.blocks.forEach((b) => {
    if (b.type === "text") {
      _postProcessInlineToolCodes(b.el);
    }
  });

  // Desktop notification when stream completes while page is hidden
  if (document.hidden) {
    const api = (window as any).electronAPI;
    if (api?.showNotification) {
      const textBlock = builder.blocks.find((b) => b.type === "text");
      const snippet = (textBlock?.content || "")
        .replace(/[#*_`\[\]()></]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      api.showNotification("Hermes Agent", snippet || "New message");
    }
    if (localStorage.getItem("hermes-notify-sound") === "1") {
      playNotificationSound();
    }
  }

  // If stream finished but we got zero text/tool blocks, try to show a friendly fallback
  const hasContent = builder.blocks.some((b) => (b.type === "text" ? b.content.trim() : true));
  if (!hasContent) {
    contentDiv.innerHTML = `<p style="color:#a3a3a3">No response content received from backend.</p>`;
  }

  // Try to capture session id from headers for future loads
  const sessionHeader = response.headers.get("X-Hermes-Session-Id");
  if (sessionHeader) {
    AppState.currentSessionId = sessionHeader;
    loadSessionHistory();
  }

  // Reconstruct full text from blocks for AppState.conversation history
  return builder.blocks
    .map((b) => (b.type === "text" ? b.content : `\`${b.name}\``))
    .join("");
}

function _postProcessInlineToolCodes(el: HTMLElement) {
  const children = Array.from(el.children);
  children.forEach((child) => {
    if (child.tagName === "P") {
      let pHtml = child.innerHTML;
      pHtml = pHtml.replace(
        /`([^`]+)`/g,
        (_: string, inner: string) => {
          if (/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u.test(inner.trim())) {
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
      pHtml = pHtml.replace(
        /▶ Subagent:\s*([^<\n]+)/g,
        (_: string, name: string) => {
          const n = name.trim();
          return `
            <div class="subagent-card">
              <div class="subagent-header" onclick="this.closest('.subagent-card').classList.toggle('open')">
                <span class="subagent-label">Subagent</span>
                <span class="subagent-title">${escapeHtml(n)}</span>
                <span class="tool-call-arrow">▶</span>
              </div>
              <div class="subagent-body">Delegated task via Hermes subagent.</div>
            </div>
          `;
        }
      );
      if (pHtml !== child.innerHTML) child.innerHTML = pHtml;
    }
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
function renderAttachments() {
  const container = $("#AppState.attachments")!;
  if (AppState.attachments.length === 0) {
    container.innerHTML = "";
    return;
  }
  const isImage = (name: string) =>
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"].some((e) => name.toLowerCase().endsWith(e));

  container.innerHTML = AppState.attachments
    .map((a, idx) => {
      const imgPreview = a.previewUrl && isImage(a.name)
        ? `<img src="${escapeHtml(a.previewUrl)}" class="attachment-thumb" alt="" />`
        : "📎";
      return `
        <span class="attachment-chip">
          ${imgPreview}
          <span class="attachment-name">${escapeHtml(a.name)}</span>
          <span class="remove" data-idx="${idx}">×</span>
        </span>
      `;
    })
    .join("");

  container.querySelectorAll(".remove").forEach((el) => {
    el.addEventListener("click", (e) => {
      const idx = parseInt((e.target as HTMLElement).dataset.idx || "-1", 10);
      if (idx >= 0) {
        AppState.attachments.splice(idx, 1);
        renderAttachments();
      }
    });
  });
}

async function handleFileDrop(file: File) {
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const commaIdx = dataUrl.indexOf(",");
    const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    const res = await rpc.request.saveFileUpload({ name: file.name, dataBase64: base64 });
    if (res.success) {
      const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"].some((e) => file.name.toLowerCase().endsWith(e));
      AppState.attachments.push({ name: file.name, path: res.path, previewUrl: isImage ? dataUrl : undefined });
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
  if (!input || !sendBtn || AppState.activeStreamController || !AppState.backendUrl) return;

  let text = input.value.trim();
  if (!text && AppState.attachments.length === 0) return;

  // Slash commands
  if (text.startsWith("/")) {
    const parts = text.slice(1).split(/\s+/);
    const cmd = parts[0];
    const arg = parts.slice(1).join(" ");
    const handled = await handleSlashCommand(cmd, arg);
    if (handled) {
      input.value = "";
      input.style.height = "auto";
      return;
    }
  }

  // Append attachment references
  if (AppState.attachments.length > 0) {
    const attachText = AppState.attachments.map((a) => `[Attached file: ${a.path}]`).join("\n");
    text = text ? `${text}\n\n${attachText}` : attachText;
  }

  // Prefix reply quote if active
  if (AppState.activeReplyTo) {
    const quote = AppState.activeReplyTo.content
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    text = `${quote}\n\n${text}`;
    cancelReply();
  }

  // Add user message to UI and history
  appendMessage("user", text);
  AppState.conversation.push({ role: "user", content: text });
  input.value = "";
  input.style.height = "auto";
  AppState.attachments = [];
  renderAttachments();
  clearDraft();

  const targetSessionId = AppState.currentSessionId || "new";
  AppState.activeStreamController = new AbortController();
  sendBtn.disabled = true;
  sendBtn.classList.add("loading");

  // Create assistant message container with thinking spinner + cancel
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
  thinking.innerHTML = `
    <span class="thinking-dots"><span></span><span></span><span></span></span>
    <span class="thinking-text">Thinking</span>
    <button class="cancel-btn">Cancel</button>
  `;
  thinking.querySelector(".cancel-btn")?.addEventListener("click", () => {
    AppState.activeStreamController?.abort();
  });
  contentDiv.appendChild(thinking);
  wrapper.appendChild(avatar);
  wrapper.appendChild(contentDiv);
  messagesEl.appendChild(wrapper);
  if (!AppState.userScrolledUp) messagesEl.scrollTop = messagesEl.scrollHeight;
  updateScrollIndicator();

  const fetchTimeout = setTimeout(() => AppState.activeStreamController?.abort(), 90000);

  try {
    const body = {
      model: AppState.currentModelConfig.model || "hermes-agent",
      messages: AppState.conversation,
      stream: true,
    };

    const assistantText = await streamChatCompletion(body, contentDiv, AppState.activeStreamController.signal, targetSessionId);
    AppState.conversation.push({ role: "assistant", content: assistantText });
  } catch (err: any) {
    if (err.name === "AbortError") {
      contentDiv.innerHTML = `<p style="color:#a3a3a3">Generation cancelled.</p>`;
    } else if (targetSessionId !== AppState.currentSessionId) {
      AppState.backgroundErrors.set(targetSessionId, err.message || "Stream error");
      renderErrorBanner();
    } else {
      contentDiv.innerHTML = `<p style="color:#ef4444">Error: ${escapeHtml(err.message || String(err))}</p>`;
    }
  } finally {
    clearTimeout(fetchTimeout);
    AppState.activeStreamController = null;
    sendBtn.disabled = false;
    sendBtn.classList.remove("loading");
    updateTokenUsageDisplay();
  }
}

async function updateTokenUsageDisplay() {
  const el = $("#token-usage-display");
  const metrics = $("#composer-metrics");
  const barWrap = $("#context-bar");
  const fill = $("#context-fill") as HTMLElement | null;
  const label = $("#context-label");
  if (!el || !metrics) return;
  const enabled = localStorage.getItem("hermes-token-usage") === "1";
  if (!enabled || !AppState.currentSessionId) {
    el.textContent = "";
    metrics.style.display = "none";
    return;
  }
  try {
    const data = await rpc.request.getTokenUsage({ sessionId: AppState.currentSessionId });
    if (data.error) {
      el.textContent = "";
      metrics.style.display = "none";
      return;
    }
    const parts: string[] = [];
    const totalTokens = data.inputTokens + data.outputTokens + data.cacheReadTokens + data.cacheWriteTokens + data.reasoningTokens;
    if (totalTokens > 0) parts.push(`${totalTokens.toLocaleString()} tokens`);
    if (data.estimatedCost > 0) parts.push(`$${data.estimatedCost.toFixed(4)}`);
    else if (data.actualCost > 0) parts.push(`$${data.actualCost.toFixed(4)}`);
    el.textContent = parts.join(" · ");

    // Context usage bar
    const limit = getContextLimit(AppState.currentModelConfig.model);
    const pct = limit > 0 ? Math.min(100, (totalTokens / limit) * 100) : 0;
    if (fill && label && barWrap) {
      fill.style.width = `${pct}%`;
      fill.classList.remove("warn", "danger");
      if (pct >= 80) fill.classList.add("danger");
      else if (pct >= 50) fill.classList.add("warn");
      label.textContent = `${totalTokens.toLocaleString()} / ${(limit / 1000).toFixed(0)}k`;
      barWrap.style.display = "flex";
    }
    metrics.style.display = "flex";
  } catch (e) {
    el.textContent = "";
    metrics.style.display = "none";
  }
}

function newChat() {
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

function focusInput() {
  const input = $("#message-input") as HTMLTextAreaElement | null;
  input?.focus();
}

function draftKey(sessionId?: string) {
  return `hermes-draft-${sessionId || "new"}`;
}

function saveDraft() {
  const input = $("#message-input") as HTMLTextAreaElement | null;
  if (!input) return;
  const text = input.value;
  if (text.trim()) {
    localStorage.setItem(draftKey(AppState.currentSessionId), text);
  } else {
    localStorage.removeItem(draftKey(AppState.currentSessionId));
  }
}

function loadDraft() {
  const input = $("#message-input") as HTMLTextAreaElement | null;
  if (!input) return;
  const text = localStorage.getItem(draftKey(AppState.currentSessionId)) || "";
  input.value = text;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  updateComposerCount();
}

function clearDraft() {
  localStorage.removeItem(draftKey(AppState.currentSessionId));
}

function updateComposerCount() {
  const input = $("#message-input") as HTMLTextAreaElement | null;
  const el = $("#composer-count");
  if (!input || !el) return;
  const text = input.value;
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  el.textContent = `${words} words · ${chars} chars`;
}

function updateScrollIndicator() {
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

function showSessionMenu(sessionId: string, displayName: string, anchor: HTMLElement) {
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

async function renameSession(sessionId: string) {
  const name = prompt("New session name:");
  if (!name) return;
  await rpc.request.renameSession({ sessionId, name });
  await loadSessionHistory();
}

async function togglePinSession(sessionId: string) {
  const el = $(`.session-item[data-id="${sessionId}"]`);
  const pinned = el?.classList.contains("pinned");
  await rpc.request.pinSession({ sessionId, pinned: !pinned });
  await loadSessionHistory();
}

async function toggleArchiveSession(sessionId: string) {
  const el = $(`.session-item[data-id="${sessionId}"]`);
  const archived = el?.classList.contains("archived");
  await rpc.request.archiveSession({ sessionId, archived: !archived });
  await loadSessionHistory();
}

async function tagSession(sessionId: string) {
  const raw = prompt("Tags (comma separated):");
  if (raw === null) return;
  const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
  await rpc.request.tagSession({ sessionId, tags });
  await loadSessionHistory();
}

async function deleteSession(sessionId: string) {
  if (!confirm("Delete this session permanently?")) return;
  await rpc.request.deleteSession({ sessionId });
  if (AppState.currentSessionId === sessionId) newChat();
  await loadSessionHistory();
}

async function duplicateSession(sessionId: string) {
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

async function exportSession(sessionId: string) {
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

async function importSessionFromFile(file: File) {
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

function renderThinkingCard(contentDiv: HTMLElement, reasoning: string) {
  if (!reasoning?.trim()) return;
  const card = document.createElement("div");
  card.className = "thinking-card";
  card.innerHTML = `
    <div class="thinking-header" onclick="this.closest('.thinking-card').classList.toggle('open')">
      <span>🧠 Thinking</span>
      <span class="thinking-arrow">▶</span>
    </div>
    <div class="thinking-body"><pre>${escapeHtml(reasoning)}</pre></div>
  `;
  contentDiv.insertBefore(card, contentDiv.firstChild);
}

function showToast(message: string, duration = 3000) {
  const existing = $(".toast-msg");
  existing?.remove();
  const div = document.createElement("div");
  div.className = "toast-msg";
  div.textContent = message;
  div.style.cssText = "position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);padding:10px 16px;border-radius:8px;z-index:100000;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,0.25);white-space:pre-wrap;max-width:min(80vw,360px);text-align:center;";
  document.body.appendChild(div);
  setTimeout(() => div.remove(), duration);
}

function playNotificationSound() {
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

async function handleSlashCommand(cmd: string, arg: string): Promise<boolean> {
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

function updateSlashMenu() {
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

function hideSlashMenu() {
  $(".slash-menu")?.remove();
}


function hideMentionMenu() {
  $(".mention-menu")?.remove();
}

async function updateMentionMenu() {
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


function applySystemTheme() {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = prefersDark ? "dark" : "light";
}

function setTheme(theme: string) {
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

function loadSnippets(): Snippet[] {
  try {
    const stored = JSON.parse(localStorage.getItem("hermes-prompt-snippets") || "[]");
    if (Array.isArray(stored) && stored.length > 0) return stored;
  } catch {}
  return BUILTIN_SNIPPETS.map((s) => ({ ...s }));
}

function saveSnippets(list: Snippet[]) {
  // Only save non-builtin snippets to localStorage
  const custom = list.filter((s) => !s.isBuiltin);
  localStorage.setItem("hermes-prompt-snippets", JSON.stringify(custom));
}

function renderSnippets() {
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

function addSnippet() {
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


function toggleSearch(show?: boolean) {
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

function clearSearch() {
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

function highlightTextNodes(node: Node, query: string) {
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

function performSearch(query: string) {
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

function navigateSearch(dir: 1 | -1) {
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

function showSnippetMenu() {
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

function getDragAfterElement(container: HTMLElement, y: number) {
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

function openSettings() {
  $("#settings-overlay")?.classList.remove("hidden");
  const savedTheme = localStorage.getItem("hermes-theme") || "dark";
  $$(".theme-chip").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLButtonElement).dataset.theme === savedTheme);
  });
  renderSnippets();
  const cssInput = $("#custom-css-input") as HTMLTextAreaElement | null;
  if (cssInput) cssInput.value = localStorage.getItem("hermes-custom-css") || "";
}

function closeSettings() {
  $("#settings-overlay")?.classList.add("hidden");
}

function applyCustomCSS() {
  const css = localStorage.getItem("hermes-custom-css") || "";
  let style = $("#custom-css-override") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "custom-css-override";
    document.head.appendChild(style);
  }
  style.textContent = css;
}

function saveCustomCSS() {
  const cssInput = $("#custom-css-input") as HTMLTextAreaElement | null;
  if (!cssInput) return;
  localStorage.setItem("hermes-custom-css", cssInput.value);
  applyCustomCSS();
  showToast("Custom CSS applied");
}

function collectHermesData(): Record<string, string> {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("hermes-")) {
      data[key] = localStorage.getItem(key) || "";
    }
  }
  return data;
}

function restoreHermesData(data: Record<string, string>) {
  Object.entries(data).forEach(([key, value]) => {
    if (typeof value === "string") localStorage.setItem(key, value);
  });
}

async function backupToGist() {
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

async function restoreFromGist() {
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


function showCommandPalette() {
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

function hideCommandPalette() {
  $("#command-palette")?.classList.add("hidden");
  AppState.paletteActiveIndex = -1;
}

function renderCommandPalette(query: string) {
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

function showShortcutsOverlay() {
  $("#shortcuts-overlay")?.classList.remove("hidden");
}

function hideShortcutsOverlay() {
  $("#shortcuts-overlay")?.classList.add("hidden");
}

function toggleCompareMode(show?: boolean) {
  const panel = $("#compare-panel");
  if (!panel) return;
  const shouldShow = show !== undefined ? show : panel.classList.contains("hidden");
  if (shouldShow) {
    panel.classList.remove("hidden");
  } else {
    panel.classList.add("hidden");
  }
}

async function runComparison() {
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

function exportToMarkdown() {
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

function exportToPDF() {
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

function formatContentForPrint(content: string): string {
  return escapeHtml(content)
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

function openLightbox(src: string) {
  const box = $("#lightbox");
  const img = $("#lightbox-img") as HTMLImageElement | null;
  if (!box || !img) return;
  img.src = src;
  box.classList.remove("hidden");
}

function closeLightbox() {
  const box = $("#lightbox");
  const img = $("#lightbox-img") as HTMLImageElement | null;
  if (!box) return;
  box.classList.add("hidden");
  if (img) img.src = "";
}

function renderReplyBar() {
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

function replyToMessage(wrapper: HTMLElement) {
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

function cancelReply() {
  AppState.activeReplyTo = null;
  renderReplyBar();
}

// ---------------------------------------------------------------------------
// Onboarding (Install + Setup Wizard)
// ---------------------------------------------------------------------------

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
  AppState.installLogBuffer += prefix + msg.text;
  logEl.textContent = AppState.installLogBuffer;
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

async function handleInstallStatus(status: { phase: string; progress?: number; message?: string; canCancel?: boolean; canRetry?: boolean }) {
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
function showLoginOverlay() {
  $("#login-overlay")?.classList.remove("hidden");
  const input = $("#login-password") as HTMLInputElement | null;
  input?.focus();
}

function hideLoginOverlay() {
  $("#login-overlay")?.classList.add("hidden");
  const err = $("#login-error");
  if (err) err.textContent = "";
  const input = $("#login-password") as HTMLInputElement | null;
  if (input) input.value = "";
}

async function performLogin() {
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

async function checkAuth() {
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

function initPage() {
  setDebug("initPage() running...");
  const savedTheme = localStorage.getItem("hermes-theme") || "dark";
  setTheme(savedTheme);
  checkAuth();

  // Connect to backend via HTTP-RPC
  (async () => {
    const hd = document.getElementById("hard-debug");
    const maxRetries = 60;
    for (let i = 0; i < maxRetries; i++) {
      if (hd) {
        hd.style.background = "#ca8a04";
        hd.textContent = `Connecting to backend... (attempt ${i + 1}/${maxRetries})`;
      }
      try {
        const s = await rpc.request.getBackendStatus({});
        if (hd) {
          hd.style.background = s.running ? "#16a34a" : "#ca8a04";
          hd.textContent = "Backend: running=" + s.running + " url=" + s.url;
        }
        updateBackendStatusUI(s);
        if (s.running && !AppState.backendUrl) {
          AppState.backendUrl = s.url;
          initAfterBackendReady();
          return;
        }
        // Backend RPC is reachable but Python backend not ready yet; keep polling
        await new Promise((r) => setTimeout(r, 500));
      } catch (e: any) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (hd) {
      hd.style.background = "#7f1d1d";
      hd.textContent = "Backend RPC ERROR: unable to connect to " + RPC_ENDPOINT;
    }
  })();

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
      const sendKey = localStorage.getItem("hermes-sendkey") || "enter";
      if (sendKey === "mod+enter") {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          sendMessage();
        }
      } else {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      }
    });

    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
      updateSlashMenu();
      updateMentionMenu();
      saveDraft();
      updateComposerCount();
    });
    input.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        showSnippetMenu();
        return;
      }
      const snippetMenu = $(".snippet-menu");
      const mentionMenu = $(".mention-menu");
      const slashMenu = $(".slash-menu");
      const menu = snippetMenu || mentionMenu || slashMenu;
      if (menu) {
        const selector = snippetMenu ? ".snippet-item-row" : mentionMenu ? ".mention-item" : ".slash-item";
        const items = Array.from(menu.querySelectorAll<HTMLDivElement>(selector));
        let active = items.findIndex((i) => i.classList.contains("active"));
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (active >= 0) items[active].classList.remove("active");
          active = (active + 1) % items.length;
          items[active].classList.add("active");
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (active >= 0) items[active].classList.remove("active");
          active = (active - 1 + items.length) % items.length;
          items[active].classList.add("active");
        } else if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (active >= 0) items[active].click();
          else if (items[0]) items[0].click();
        } else if (e.key === "Escape") {
          hideSlashMenu();
          hideMentionMenu();
          $(".snippet-menu")?.remove();
        }
        return;
      }
    });

    input.addEventListener("paste", (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imageItems = items.filter((it) => it.type.startsWith("image/"));
      if (!imageItems.length) return;
      e.preventDefault();
      imageItems.forEach((it) => {
        const blob = it.getAsFile();
        if (blob) {
          const ext = it.type.split("/")[1] || "png";
          const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: it.type });
          handleFileDrop(file);
        }
      });
    });
  }

  // Voice input mic button
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (SpeechRecognition && input) {
    const inputBox = input.closest(".input-box") as HTMLElement | null;
    if (inputBox) {
      const micBtn = document.createElement("button");
      micBtn.className = "icon-btn mic-btn";
      micBtn.textContent = "🎤";
      micBtn.title = "Voice input";
      micBtn.type = "button";
      let rec: any = null;
      let prefix = "";
      let finalText = "";
      micBtn.addEventListener("click", () => {
        if (micBtn.classList.contains("recording")) {
          rec?.stop();
          micBtn.classList.remove("recording");
          return;
        }
        prefix = input.value;
        finalText = "";
        micBtn.classList.add("recording");
        rec = new SpeechRecognition();
        rec.continuous = false;
        rec.interimResults = true;
        rec.lang = "zh-CN";
        rec.onresult = (event: any) => {
          let interim = "";
          let fin = finalText;
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const t = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              fin += t;
            } else {
              interim += t;
            }
          }
          finalText = fin;
          const committed = prefix + (prefix && !prefix.endsWith(" ") && !prefix.endsWith("\n") && finalText ? " " + finalText : finalText);
          input.value = committed + interim;
          input.style.height = "auto";
          input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
        };
        rec.onend = () => micBtn.classList.remove("recording");
        rec.onerror = (event: any) => {
          micBtn.classList.remove("recording");
          const msgs: Record<string, string> = {
            "not-allowed": "Microphone access denied.",
            "no-speech": "No speech detected. Try again.",
            "network": "Speech recognition unavailable.",
          };
          showToast(msgs[event.error] || "Voice input error: " + event.error, 3000);
        };
        rec.start();
      });
      const sendBtn = inputBox.querySelector("#send-btn");
      if (sendBtn) inputBox.insertBefore(micBtn, sendBtn);
      else inputBox.appendChild(micBtn);
    }
  }

  // Artifact preview toggle + Python run
  $("#messages")?.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const artBtn = target.closest(".artifact-preview-btn") as HTMLButtonElement | null;
    if (artBtn) {
      const block = artBtn.closest(".code-block") as HTMLElement | null;
      const preview = block?.querySelector(".artifact-preview") as HTMLElement | null;
      if (!preview) return;
      const isHidden = preview.classList.toggle("hidden");
      artBtn.textContent = isHidden ? "Preview" : "Hide";
      return;
    }
    const runBtn = target.closest(".exec-run-btn") as HTMLButtonElement | null;
    if (runBtn) {
      const block = runBtn.closest(".code-block") as HTMLElement | null;
      const codeEl = block?.querySelector("code");
      const output = block?.querySelector(".exec-output") as HTMLElement | null;
      const stdoutEl = block?.querySelector(".exec-stdout") as HTMLElement | null;
      const stderrEl = block?.querySelector(".exec-stderr") as HTMLElement | null;
      if (!codeEl || !output || !stdoutEl || !stderrEl) return;
      const code = codeEl.textContent || "";
      runBtn.disabled = true;
      runBtn.textContent = "Running...";
      try {
        const res = await rpc.request.executePython({ code });
        stdoutEl.textContent = res.stdout || "";
        stderrEl.textContent = res.stderr || "";
        output.classList.remove("hidden");
      } catch (err: any) {
        stdoutEl.textContent = "";
        stderrEl.textContent = err.message || "Execution failed";
        output.classList.remove("hidden");
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = "▶ Run";
      }
      return;
    }
  });

  // Mobile sidebar toggle
  $("#menu-toggle")?.addEventListener("click", () => {
    $(".sidebar")?.classList.toggle("open");
    $("#mobile-overlay")?.classList.toggle("visible");
  });
  $("#mobile-overlay")?.addEventListener("click", () => {
    $(".sidebar")?.classList.remove("open");
    $("#mobile-overlay")?.classList.remove("visible");
  });

  // Chat header actions
  $("#export-md-btn")?.addEventListener("click", exportToMarkdown);
  $("#export-pdf-btn")?.addEventListener("click", exportToPDF);
  $("#search-btn")?.addEventListener("click", () => toggleSearch(true));

  $("#compare-btn")?.addEventListener("click", () => toggleCompareMode(true));

  // Compare panel
  $("#compare-close")?.addEventListener("click", () => toggleCompareMode(false));
  $("#compare-run")?.addEventListener("click", runComparison);
  const paletteInput = $("#command-palette-input") as HTMLInputElement | null;
  paletteInput?.addEventListener("input", () => renderCommandPalette(paletteInput.value));

  // Search bar
  $("#chat-search-close")?.addEventListener("click", () => toggleSearch(false));
  $("#chat-search-prev")?.addEventListener("click", () => navigateSearch(-1));
  $("#chat-search-next")?.addEventListener("click", () => navigateSearch(1));
  const searchInput = $("#chat-search-input") as HTMLInputElement | null;
  searchInput?.addEventListener("input", () => performSearch(searchInput.value));

  // Snippet actions
  $("#snippet-btn")?.addEventListener("click", showSnippetMenu);
  $("#snippet-add-btn")?.addEventListener("click", addSnippet);

  // Reply bar
  $("#reply-cancel")?.addEventListener("click", cancelReply);

  // Settings panel
  $("#settings-btn")?.addEventListener("click", openSettings);
  $("#settings-close")?.addEventListener("click", closeSettings);
  $("#settings-overlay")?.addEventListener("click", (e) => {
    if (e.target === $("#settings-overlay")) closeSettings();
  });

  // Theme chips
  $$<HTMLButtonElement>(".theme-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const theme = btn.dataset.theme || "dark";
      setTheme(theme);
    });
  });

  // Start minimized (Electron only)
  const startMinimizedCheckbox = $("#start-minimized") as HTMLInputElement | null;
  if (startMinimizedCheckbox) {
    const api = (window as any).electronAPI;
    if (api?.getStartMinimized) {
      api.getStartMinimized().then((v: boolean) => {
        startMinimizedCheckbox.checked = !!v;
      }).catch(() => {});
      startMinimizedCheckbox.addEventListener("change", () => {
        api.setStartMinimized?.(startMinimizedCheckbox.checked);
      });
    } else {
      // Hide the row if not running inside Electron
      startMinimizedCheckbox.closest(".setting-row")?.classList.add("hidden");
    }
  }

  // Send key preference
  const savedSendKey = localStorage.getItem("hermes-sendkey") || "enter";
  const sendKeyRadios = $$<HTMLInputElement>("input[name='sendkey']");
  sendKeyRadios.forEach((r) => {
    if (r.value === savedSendKey) r.checked = true;
    r.addEventListener("change", () => {
      localStorage.setItem("hermes-sendkey", r.value);
    });
  });

  // Timestamps toggle
  const timestampsToggle = $("#toggle-timestamps") as HTMLInputElement | null;
  if (timestampsToggle) {
    timestampsToggle.checked = localStorage.getItem("hermes-show-timestamps") !== "0";
    timestampsToggle.addEventListener("change", () => {
      localStorage.setItem("hermes-show-timestamps", timestampsToggle.checked ? "1" : "0");
      if (AppState.currentSessionId) {
        const name = document.title.replace(" — Hermes Agent", "");
        loadSessionMessages(AppState.currentSessionId, name || undefined);
      }
    });
  }

  // Token usage toggle
  const tokenToggle = $("#toggle-token-usage") as HTMLInputElement | null;
  if (tokenToggle) {
    tokenToggle.checked = localStorage.getItem("hermes-token-usage") === "1";
    tokenToggle.addEventListener("change", () => {
      localStorage.setItem("hermes-token-usage", tokenToggle.checked ? "1" : "0");
      updateTokenUsageDisplay();
    });
  }

  // Background error toggle
  const bgErrToggle = $("#toggle-background-errors") as HTMLInputElement | null;
  if (bgErrToggle) {
    bgErrToggle.checked = localStorage.getItem("hermes-bg-errors") !== "0";
    bgErrToggle.addEventListener("change", () => {
      localStorage.setItem("hermes-bg-errors", bgErrToggle.checked ? "1" : "0");
      renderErrorBanner();
    });
  }

  // Notification sound toggle
  const notifySoundToggle = $("#notify-sound") as HTMLInputElement | null;
  if (notifySoundToggle) {
    notifySoundToggle.checked = localStorage.getItem("hermes-notify-sound") === "1";
    notifySoundToggle.addEventListener("change", () => {
      localStorage.setItem("hermes-notify-sound", notifySoundToggle.checked ? "1" : "0");
      if (notifySoundToggle.checked) playNotificationSound();
    });
  }

  // Rightpanel
  $("#rightpanel-close")?.addEventListener("click", () => {
    $(".rightpanel")?.classList.remove("open");
  });
  $("#preview-close")?.addEventListener("click", closePreview);
  $("#preview-save")?.addEventListener("click", savePreview);
  $("#ws-new-file")?.addEventListener("click", createWsFile);
  $("#ws-new-dir")?.addEventListener("click", createWsDir);

  // Custom CSS
  applyCustomCSS();
  $("#custom-css-save")?.addEventListener("click", saveCustomCSS);
  $("#gist-backup")?.addEventListener("click", backupToGist);
  $("#gist-restore")?.addEventListener("click", restoreFromGist);
  const patInput = $("#gist-pat") as HTMLInputElement | null;
  if (patInput) {
    const savedPat = localStorage.getItem("hermes-gist-pat");
    if (savedPat) patInput.value = savedPat;
    patInput.addEventListener("change", () => {
      localStorage.setItem("hermes-gist-pat", patInput.value);
    });
  }
  const gistStatus = $("#gist-status");
  const savedGistId = localStorage.getItem("hermes-gist-id");
  if (gistStatus && savedGistId) gistStatus.textContent = `Gist: ${savedGistId}`;

  // Drag resize for rightpanel
  (function initRightpanelResize() {
    const handle = $("#rightpanel-resize");
    const panel = $(".rightpanel") as HTMLElement | null;
    if (!handle || !panel) return;
    let startX = 0;
    let startW = 0;
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      handle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        const newW = Math.min(500, Math.max(180, startW + delta));
        panel.style.width = `${newW}px`;
      };
      const onUp = () => {
        handle.classList.remove("dragging");
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove as any);
        document.removeEventListener("mouseup", onUp as any);
      };
      document.addEventListener("mousemove", onMove as any);
      document.addEventListener("mouseup", onUp as any);
    });
  })();

  // Session list drag-and-drop
  const sessionsList = $("#sessions-list");
  if (sessionsList) {
    sessionsList.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!AppState.draggedSessionId) return;
      const after = getDragAfterElement(sessionsList as HTMLElement, e.clientY);
      let indicator = $(".drop-indicator");
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.className = "drop-indicator";
      }
      if (after) sessionsList.insertBefore(indicator, after);
      else sessionsList.appendChild(indicator);
    });
    sessionsList.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && !(e.relatedTarget as HTMLElement).closest("#sessions-list")) {
        $(".drop-indicator")?.remove();
      }
    });
    sessionsList.addEventListener("drop", async (e) => {
      e.preventDefault();
      $(".drop-indicator")?.remove();
      if (!AppState.draggedSessionId) return;
      const after = getDragAfterElement(sessionsList as HTMLElement, e.clientY);
      const draggedEl = sessionsList.querySelector(`[data-id="${AppState.draggedSessionId}"]`) as HTMLElement | null;
      if (draggedEl) {
        if (after) sessionsList.insertBefore(draggedEl, after);
        else sessionsList.appendChild(draggedEl);
      }
      const orderedIds = Array.from(sessionsList.querySelectorAll(".session-item")).map((el) => (el as HTMLElement).dataset.id).filter((id): id is string => !!id);
      try {
        await rpc.request.reorderSessions({ orderedIds });
        await loadSessionHistory();
      } catch (err: any) {
        showToast("Reorder failed: " + (err.message || err));
        await loadSessionHistory();
      }
    });
  }

  // Panels in sidebar: tasks, todos, spaces, memory
  $("#tasks-panel")?.querySelector(".panel-header")?.addEventListener("click", () => {
    $("#tasks-panel")?.classList.toggle("collapsed");
    if (!$("#tasks-panel")?.classList.contains("collapsed")) {
      $("#task-output")?.classList.add("hidden");
      loadTasks();
    }
  });
  $("#todos-panel")?.querySelector(".panel-header")?.addEventListener("click", () => {
    $("#todos-panel")?.classList.toggle("collapsed");
    if (!$("#todos-panel")?.classList.contains("collapsed")) renderTodos();
  });
  $("#spaces-panel")?.querySelector(".panel-header")?.addEventListener("click", () => {
    $("#spaces-panel")?.classList.toggle("collapsed");
    if (!$("#spaces-panel")?.classList.contains("collapsed")) loadSpaces();
  });
  $("#space-add-btn")?.addEventListener("click", addSpace);
  $("#memory-panel")?.querySelector(".panel-header")?.addEventListener("click", () => {
    $("#memory-panel")?.classList.toggle("collapsed");
    if (!$("#memory-panel")?.classList.contains("collapsed")) loadMemory();
  });
  $("#update-dismiss")?.addEventListener("click", () => {
    $("#update-banner")?.classList.add("hidden");
    sessionStorage.setItem("hermes-update-dismissed", "1");
  });
  if (sessionStorage.getItem("hermes-update-dismissed")) {
    $("#update-banner")?.classList.add("hidden");
  }

  $("#memory-save-btn")?.addEventListener("click", saveMemory);
  $$<HTMLButtonElement>(".memory-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      AppState.activeMemorySection = (btn.dataset.section as "memory" | "user") || "memory";
      $$<HTMLButtonElement>(".memory-tab").forEach((b) => b.classList.toggle("active", b === btn));
      loadMemory();
    });
  });

  // Profiles inside settings
  $("#profile-create-btn")?.addEventListener("click", createProfile);
  const importFileInput = $("#session-import-file") as HTMLInputElement | null;
  const importBtn = $("#session-import-btn");
  importBtn?.addEventListener("click", () => importFileInput?.click());
  importFileInput?.addEventListener("change", () => {
    const file = importFileInput.files?.[0];
    if (file) {
      importSessionFromFile(file);
      importFileInput.value = ""; // reset
    }
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const palette = $("#command-palette");
    const paletteOpen = palette && !palette.classList.contains("hidden");
    if (paletteOpen) {
      const list = $("#command-palette-list");
      const items = list ? Array.from(list.querySelectorAll<HTMLDivElement>(".command-palette-item")) : [];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (AppState.paletteActiveIndex >= 0) items[AppState.paletteActiveIndex]?.classList.remove("active");
        AppState.paletteActiveIndex = (AppState.paletteActiveIndex + 1) % items.length;
        items[AppState.paletteActiveIndex]?.classList.add("active");
        items[AppState.paletteActiveIndex]?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (AppState.paletteActiveIndex >= 0) items[AppState.paletteActiveIndex]?.classList.remove("active");
        AppState.paletteActiveIndex = (AppState.paletteActiveIndex - 1 + items.length) % items.length;
        items[AppState.paletteActiveIndex]?.classList.add("active");
        items[AppState.paletteActiveIndex]?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const activeId = items[AppState.paletteActiveIndex]?.dataset.id;
        const cmd = PALETTE_COMMANDS.find((c) => c.id === activeId);
        if (cmd) { hideCommandPalette(); cmd.action(); }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideCommandPalette();
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      showCommandPalette();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      newChat();
      focusInput();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      focusInput();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "/") {
      e.preventDefault();
      showShortcutsOverlay();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      toggleSearch(true);
    }
    if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const active = document.activeElement;
      const isTyping = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
      if (!isTyping) {
        showShortcutsOverlay();
      }
    }
    if (e.key === "Escape") {
      const lightbox = $("#lightbox");
      if (lightbox && !lightbox.classList.contains("hidden")) {
        e.preventDefault();
        closeLightbox();
        return;
      }
      const searchBar = $("#chat-search-bar");
      if (searchBar && !searchBar.classList.contains("hidden")) {
        e.preventDefault();
        toggleSearch(false);
        return;
      }
      const shortcuts = $("#shortcuts-overlay");
      if (shortcuts && !shortcuts.classList.contains("hidden")) {
        e.preventDefault();
        hideShortcutsOverlay();
      }
    }
  });

  $("#shortcuts-close")?.addEventListener("click", hideShortcutsOverlay);
  $("#shortcuts-overlay")?.addEventListener("click", (e) => {
    if (e.target === $("#shortcuts-overlay")) hideShortcutsOverlay();
  });

  // Lightbox
  $("#lightbox")?.addEventListener("click", (e) => {
    if (e.target === $("#lightbox")) closeLightbox();
  });
  document.addEventListener("click", (e) => {
    hideWorkspaceContextMenu();
    const target = e.target as HTMLElement;
    if (target.tagName === "IMG" && (target.closest(".message-content") || target.closest("#preview-content") || target.closest(".attachment-chip"))) {
      openLightbox((target as HTMLImageElement).src);
    }
  });

  // Drag & drop
  const chatContainer = $("#chat-container");
  const dropOverlay = $("#drop-overlay") as HTMLElement | null;
  if (chatContainer && dropOverlay) {
    chatContainer.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dropOverlay.classList.add("active");
    });
    chatContainer.addEventListener("dragover", (e) => {
      e.preventDefault();
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

  // Skills toggle & install
  $("#skills-toggle")?.addEventListener("click", toggleSkillsPanel);
  $("#skill-install-btn")?.addEventListener("click", installNewSkill);
  $("#skill-install-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      installNewSkill();
    }
  });

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

  // Polling fallback: actively pull backend status until it's ready
  // (message pushes from Bun can be lost during WebView navigation)
  let pollCount = 0;
  const maxPolls = 60;
  const pollInterval = setInterval(async () => {
    pollCount++;
    setDebug(`poll #${pollCount}: calling getBackendStatus...`);
    try {
      const s = await rpc.request.getBackendStatus({});
      setDebug(`poll #${pollCount}: running=${s.running} url=${s.url}`);
      updateBackendStatusUI(s);
      if (s.running) {
        if (!AppState.backendUrl) {
          AppState.backendUrl = s.url;
          initAfterBackendReady();
        }
        clearInterval(pollInterval);
      } else if (pollCount >= maxPolls) {
        clearInterval(pollInterval);
        console.warn("Backend status poll timeout");
        const badge = $("#backend-status");
        if (badge) badge.textContent = "Offline";
      }
    } catch (e: any) {
      setDebug(`poll #${pollCount}: ERROR ${e?.message || String(e)}`);
      console.error("Backend status poll failed:", e);
      if (pollCount >= maxPolls) {
        clearInterval(pollInterval);
        const badge = $("#backend-status");
        if (badge) badge.textContent = "Offline";
      }
    }
  }, 800);

  // Login
  $("#login-btn")?.addEventListener("click", performLogin);
  const loginInput = $("#login-password") as HTMLInputElement | null;
  loginInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") performLogin();
  });

  // Messages scroll pause
  const messagesEl = $("#messages");
  if (messagesEl) {
    messagesEl.addEventListener("scroll", () => {
      const atBottom = messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - SCROLL_PAUSE_THRESHOLD;
      AppState.userScrolledUp = !atBottom;
      updateScrollIndicator();
    });
  }

  // Scroll to bottom button
  $("#scroll-to-bottom")?.addEventListener("click", () => {
    const messagesEl = $("#messages");
    if (messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      AppState.userScrolledUp = false;
      updateScrollIndicator();
    }
  });

  // Mobile nav
  $$(".mobile-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = (btn as HTMLButtonElement).dataset.panel || "chat";
      mobileSwitchPanel(panel);
    });
  });

  // Projects
  $("#project-add-btn")?.addEventListener("click", createProjectFromPrompt);

  // Session list search
  $("#session-search-input")?.addEventListener("input", () => {
    loadSessionHistory();
  });

  startApprovalPolling();
}

function showApprovalCard(sessionId: string, pending: any) {
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

function startApprovalPolling() {
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

function mobileSwitchPanel(name: string) {
  const sidebar = $(".sidebar");
  const rightpanel = $(".rightpanel");
  if (name === "chat") {
    sidebar?.classList.remove("open");
    rightpanel?.classList.remove("open");
    $("#settings-overlay")?.classList.add("hidden");
  } else if (name === "settings") {
    sidebar?.classList.remove("open");
    rightpanel?.classList.remove("open");
    openSettings();
  } else if (name === "workspace") {
    sidebar?.classList.remove("open");
    $("#settings-overlay")?.classList.add("hidden");
    rightpanel?.classList.add("open");
    loadWorkspace();
  } else {
    sidebar?.classList.add("open");
    rightpanel?.classList.remove("open");
    $("#settings-overlay")?.classList.add("hidden");
    // Expand target panel, collapse others
    $("#tasks-panel")?.classList.toggle("collapsed", name !== "tasks");
    $("#todos-panel")?.classList.toggle("collapsed", name !== "todos");
    $("#memory-panel")?.classList.toggle("collapsed", name !== "memory");
  }
  // Update active tab
  $$(".mobile-nav-btn").forEach((btn) => {
    const isActive = (btn as HTMLButtonElement).dataset.panel === name;
    btn.classList.toggle("active", isActive);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPage);
} else {
  initPage();
}
