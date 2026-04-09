export const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
export const $$ = (sel: string) => document.querySelectorAll(sel) as NodeListOf<HTMLElement>;
(window as any).$ = $;
(window as any).$$ = $$;

export function updateDocumentTitle(name: string) {
  document.title = name ? `${name} — Hermes Agent` : "Hermes Agent";
}

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function showToast(message: string, duration = 3000) {
  const existing = $(".toast-msg");
  existing?.remove();
  const div = document.createElement("div");
  div.className = "toast-msg";
  div.textContent = message;
  div.style.cssText =
    "position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);padding:10px 16px;border-radius:8px;z-index:100000;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,0.25);white-space:pre-wrap;max-width:min(80vw,360px);text-align:center;";
  document.body.appendChild(div);
  setTimeout(() => div.remove(), duration);
}
