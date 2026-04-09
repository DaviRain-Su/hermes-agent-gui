import { escapeHtml } from "./dom.js";

export function formatContent(text: string): string {
  let html = escapeHtml(text);

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

  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  const paragraphs = html.split(/\n\n+/).map((p) => {
    if (p.startsWith("<pre>")) return p;
    return `<p>${p.replace(/\n/g, "<br>")}</p>`;
  });

  return paragraphs.join("");
}

export function formatContentForPrint(content: string): string {
  return escapeHtml(content)
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}
