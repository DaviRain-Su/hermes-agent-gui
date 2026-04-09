// Skills
import { $, $$, escapeHtml, showToast } from "../utils/dom.js";
import { formatContent } from "../utils/format.js";
import { rpc } from "../utils/rpc.js";
import { AppState } from "../state.js";

export async function loadWorkspace() {
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

export async function openPreview(path: string) {
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

export function closePreview() {
  const preview = $("#workspace-preview");
  if (preview) preview.classList.add("hidden");
  AppState.previewHasChanges = false;
}

export async function savePreview() {
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

export async function createWsFile() {
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

export async function createWsDir() {
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

export async function renameWsEntry(path: string) {
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

export async function deleteWsEntry(path: string) {
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

export function hideWorkspaceContextMenu() {
  $(".workspace-context-menu")?.remove();
}

export function showWorkspaceContextMenu(e: MouseEvent, path: string, isDirectory: boolean) {
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
