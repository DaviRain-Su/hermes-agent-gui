import { $, $$, escapeHtml, updateDocumentTitle, showToast } from "../utils/dom.js";
import { formatContent } from "../utils/format.js";
import { rpc } from "../utils/rpc.js";
import { AppState, ChatMessage, Attachment, MODEL_CONTEXT_LIMITS, MAX_INITIAL_MESSAGES } from "../state.js";
import { loadWorkspace } from "./workspace.js";
import { focusInput, saveDraft, loadDraft, playNotificationSound, hideSlashMenu, hideMentionMenu } from "./composer.js";
import { clearSearch, renderReplyBar, cancelReply } from "./overlays.js";


export function toggleTTS(text: string, btn: HTMLButtonElement) {
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

export function appendMessage(role: "user" | "assistant", content: string, timestamp?: string): HTMLElement {
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

export function editMessage(wrapper: HTMLElement) {
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

export function enhanceCodeBlocks(contentDiv: HTMLElement) {
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

export function enhanceMermaidBlocks(contentDiv: HTMLElement) {
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
export function postProcessMessage(contentDiv: HTMLElement) {
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

export async function streamChatCompletion(body: any, contentDiv: HTMLElement, signal: AbortSignal, targetSessionId: string): Promise<{ content: string; toolCalls?: any[] }> {
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
    const message = json.choices?.[0]?.message || {};
    const content = message.content || json.message || JSON.stringify(json);
    const toolCalls = message.tool_calls || undefined;
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
    return { content: typeof content === "string" ? content : "", toolCalls };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const builder = new MessageBlockBuilder(contentDiv);
  let toolCalls: any[] | undefined = undefined;
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
          if (delta?.tool_calls) {
            if (!toolCalls) toolCalls = [];
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || "", type: tc.type || "function", function: { name: "", arguments: "" } };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.type) toolCalls[idx].type = tc.type;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
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
  const content = builder.blocks
    .map((b) => (b.type === "text" ? b.content : `\`${b.name}\``))
    .join("");
  return { content, toolCalls };
}

export function _postProcessInlineToolCodes(el: HTMLElement) {
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
export function renderAttachments() {
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

export async function handleFileDrop(file: File) {
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

async function runAgentLoop(body: any, contentDiv: HTMLElement, controller: AbortController, targetSessionId: string) {
  const maxSteps = 10;
  for (let step = 0; step < maxSteps; step++) {
    let tools: any[] = [];
    const toolServerMap = new Map<string, string>();
    try {
      const toolRes = await rpc.request.listMcpTools({});
      tools = (toolRes.tools || []).map((t: any) => {
        toolServerMap.set(t.name, t.server || "");
        return {
          type: "function",
          function: {
            name: t.name,
            description: t.description || "",
            parameters: t.inputSchema || { type: "object", properties: {} },
          },
        };
      });
    } catch (e) {
      console.error("Failed to list MCP tools:", e);
    }

    const stepBody = { ...body, ...(tools.length > 0 ? { tools } : {}) };
    const stepIndicator = document.createElement("div");
    stepIndicator.className = "agent-step running";
    stepIndicator.textContent = `Thinking... (step ${step + 1})`;
    contentDiv.appendChild(stepIndicator);
    if (!AppState.userScrolledUp) {
      const messagesEl = $("#messages")!;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    const result = await streamChatCompletion(stepBody, contentDiv, controller.signal, targetSessionId);
    stepIndicator.className = "agent-step done";
    stepIndicator.textContent = `Step ${step + 1} complete`;

    const assistantMsg: any = { role: "assistant", content: result.content };
    if (result.toolCalls && result.toolCalls.length > 0) {
      assistantMsg.tool_calls = result.toolCalls;
    }
    AppState.conversation.push(assistantMsg);

    if (!result.toolCalls || result.toolCalls.length === 0) {
      break;
    }

    for (const tc of result.toolCalls) {
      const toolIndicator = document.createElement("div");
      toolIndicator.className = "agent-step running";
      toolIndicator.textContent = `Executing ${tc.function.name}...`;
      contentDiv.appendChild(toolIndicator);
      if (!AppState.userScrolledUp) {
        const messagesEl = $("#messages")!;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      let toolResultText = "";
      try {
        const server = toolServerMap.get(tc.function.name) || "";
        const toolRes = await rpc.request.callMcpTool({
          server,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || "{}"),
        });
        toolResultText = typeof toolRes.content === "string" ? toolRes.content : JSON.stringify(toolRes.content);
        toolIndicator.className = "agent-step done";
        toolIndicator.textContent = `${tc.function.name} executed`;
      } catch (e: any) {
        toolResultText = `Error: ${e.message || String(e)}`;
        toolIndicator.className = "agent-step";
        toolIndicator.style.color = "#ef4444";
        toolIndicator.textContent = `${tc.function.name} failed: ${toolResultText}`;
      }

      AppState.conversation.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content: toolResultText,
      });
    }

    body.messages = [...AppState.conversation];
  }
}

// ---------------------------------------------------------------------------
// Send Message
// ---------------------------------------------------------------------------
export async function sendMessage() {
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

    if (AppState.agentMode) {
      await runAgentLoop(body, contentDiv, AppState.activeStreamController, targetSessionId);
    } else {
      const result = await streamChatCompletion(body, contentDiv, AppState.activeStreamController.signal, targetSessionId);
      AppState.conversation.push({ role: "assistant", content: result.content });
    }
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

export async function updateTokenUsageDisplay() {
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

export function renderThinkingCard(contentDiv: HTMLElement, reasoning: string) {
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

