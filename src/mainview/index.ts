import { $, $$, escapeHtml, updateDocumentTitle, showToast } from "./utils/dom.js";
import { formatContent, formatContentForPrint } from "./utils/format.js";
import { rpc, onRpcSend, showLoginOverlay } from "./utils/rpc.js";
import {
  appendMessage,
  sendMessage,
  streamChatCompletion,
  updateTokenUsageDisplay,
  renderThinkingCard,
  postProcessMessage,
} from "./components/chat.js";
import {
  newChat,
  focusInput,
  saveDraft,
  loadDraft,
  clearDraft,
  updateComposerCount,
  updateScrollIndicator,
  playNotificationSound,
  handleSlashCommand,
  updateSlashMenu,
  hideSlashMenu,
  hideMentionMenu,
  updateMentionMenu,
  toggleAgentMode,
  initAgentMode,
} from "./components/composer.js";
import {
  renderErrorBanner,
  toggleSearch,
  clearSearch,
  highlightTextNodes,
  performSearch,
  navigateSearch,
  showCommandPalette,
  hideCommandPalette,
  renderCommandPalette,
  showShortcutsOverlay,
  hideShortcutsOverlay,
  openLightbox,
  closeLightbox,
  renderReplyBar,
  replyToMessage,
  cancelReply,
  showOverlay,
  hideOverlay,
  setOnboardingTitle,
  setOnboardingDesc,
  showPanel,
  appendInstallLog,
  updateInstallProgress,
  renderSetupForm,
  handleInstallStatus,
  startInstall,
  cancelInstall,
  submitSetup,
  retryFromError,
  openManualInstall,
  hideLoginOverlay,
  performLogin,
  checkAuth,
  showApprovalCard,
  startApprovalPolling,
} from "./components/overlays.js";
import {
  loadSessionHistory,
  loadSessionMessages,
  showSessionMenu,
  renameSession,
  togglePinSession,
  toggleArchiveSession,
  tagSession,
  deleteSession,
  duplicateSession,
  exportSession,
  importSessionFromFile,
  loadProjectsData,
  renderProjectsBar,
  createProjectFromPrompt,
} from "./components/sidebar.js";
import {
  applySystemTheme,
  setTheme,
  loadSnippets,
  saveSnippets,
  renderSnippets,
  addSnippet,
  showSnippetMenu,
  getDragAfterElement,
  openSettings,
  closeSettings,
  applyCustomCSS,
  saveCustomCSS,
  collectHermesData,
  restoreHermesData,
  backupToGist,
  restoreFromGist,
  toggleCompareMode,
  runComparison,
  exportToMarkdown,
  exportToPDF,
  setPassword,
  loadMcpServers,
  addMcpServerForm,
} from "./components/settings.js";
import {
  loadWorkspace,
  openPreview,
  closePreview,
  savePreview,
  createWsFile,
  createWsDir,
  renameWsEntry,
  deleteWsEntry,
  showWorkspaceContextMenu,
  hideWorkspaceContextMenu,
} from "./components/workspace.js";
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

// Register RPC send handlers
onRpcSend("backendStatus", (status: BackendStatus) => {
  updateBackendStatusUI(status);
  if (status.running && !AppState.backendUrl) {
    AppState.backendUrl = status.url;
    initAfterBackendReady();
  }
});
onRpcSend("backendLog", (msg: { stream: "stdout" | "stderr"; text: string }) => {
  console.log(`[Backend ${msg.stream}]`, msg.text);
});
onRpcSend("installStatus", handleInstallStatus);
onRpcSend("installLog", appendInstallLog);

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
        <div class="profile-main">
          <span class="profile-dot ${p.active ? 'on' : ''}"></span>
          <span class="profile-name">${escapeHtml(p.name)}</span>
          ${p.active ? '<span class="profile-badge">active</span>' : ''}
        </div>
        <div class="profile-actions">
          <button class="icon-btn rename-profile-btn" title="Rename">✏️</button>
          <button class="icon-btn delete-profile-btn" title="Delete">🗑️</button>
        </div>
      </div>
    `).join("");
    container.querySelectorAll<HTMLDivElement>(".profile-item").forEach((el) => {
      const name = el.dataset.name || "";
      el.querySelector(".rename-profile-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        renameProfile(name);
      });
      el.querySelector(".delete-profile-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteProfile(name);
      });
      el.addEventListener("click", async () => {
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

async function renameProfile(oldName: string) {
  const newName = prompt(`Rename profile "${oldName}":`, oldName);
  if (!newName || newName === oldName) return;
  try {
    await rpc.request.renameProfile({ oldName, newName });
    await loadProfiles();
  } catch (e: any) {
    alert("Rename profile failed: " + e.message);
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

function formatContentForPrint(content: string): string {
  return escapeHtml(content)
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

function initPage() {
  setDebug("initPage() running...");
  const savedTheme = localStorage.getItem("hermes-theme") || "dark";
  setTheme(savedTheme);
  initAgentMode();
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
  $("#agent-mode")?.addEventListener("change", () => toggleAgentMode());

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
  $("#mcp-add-btn")?.addEventListener("click", addMcpServerForm);
  $("#set-password-btn")?.addEventListener("click", setPassword);
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
