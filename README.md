# Hermes Agent

> A full-featured desktop GUI for [Hermes Agent](https://github.com/DaviRain-Su/hermes-agent) built with Electron + Bun.

[![Release](https://img.shields.io/github/v/release/DaviRain-Su/hermes-agent-gui)](https://github.com/DaviRain-Su/hermes-agent-gui/releases)
[![License](https://img.shields.io/github/license/DaviRain-Su/hermes-agent-gui)](LICENSE)

## Features

- **Streaming chat** with SSE and real-time Markdown rendering
- **Session management** — pin, archive, tag, rename, and delete conversations
- **Thinking / Reasoning cards** — collapsible reasoning output from the model
- **Mermaid diagrams** — auto-render ` ```mermaid ` blocks as SVG diagrams
- **Slash commands** — type `/` for quick actions like `/new`, `/theme`, `/clear`
- **Voice input** — click the microphone button to dictate messages (Web Speech API)
- **Tasks / Cron panel** — view and manage scheduled jobs in the sidebar
- **Memory editor** — edit `MEMORY.md` inline without leaving the app
- **Profiles** — switch between isolated Hermes configurations from Settings
- **Workspace browser** — browse files in the `~/.hermes` workspace
- **Model switching** — change provider + model on the fly; auto-restarts the backend
- **Skills management** — install, update, enable/disable, and uninstall skills
- **Drag & drop file attachments**
- **Code copy buttons** on every code block
- **Hover timestamps** on messages
- **Theme switcher** — Dark, Light, and Slate themes
- **Mobile responsive layout** — hamburger sidebar on narrow screens
- **Auto backend lifecycle** — the GUI spawns and monitors the Hermes Python API server automatically

## Download

Grab the latest release from the [Releases](https://github.com/DaviRain-Su/hermes-agent-gui/releases) page.

| Platform | Package | Install |
|---|---|---|
| Linux (universal) | `.AppImage` | Download, `chmod +x`, and run |
| Debian / Ubuntu | `.deb` | `sudo dpkg -i hermes-agent-gui_*.deb` |
| macOS (Apple Silicon) | `.dmg` | Open the DMG and drag **Hermes Agent** to **Applications** |
| macOS ( Apple Silicon ) | `.zip` | Extract and run **Hermes Agent.app** |

After installation, launch **Hermes Agent** from your applications menu or run it from the terminal.

> **Note:** The app requires `bun` and `python3` to be available on your system because the Electron shell spawns the Bun backend service, which in turn spawns the Hermes Python gateway.

## Development

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- [Node.js](https://nodejs.org) ≥ 18 (for `electron-builder`)
- Python ≥ 3.11 (for Hermes Agent backend)
- Hermes Agent source code cloned locally (auto-detected at `~/dev/active/hermes-agent` or via `HERMES_AGENT_DIR`)

### Quick start

```bash
git clone https://github.com/DaviRain-Su/hermes-agent-gui.git
cd hermes-agent-gui
bun install
npm start          # dev mode with live reload feel
```

To build the distributable packages locally:

```bash
npm run dist
```

Artifacts will appear in `dist-electron/`:
- `Hermes Agent-0.2.0.AppImage`
- `hermes-agent-gui_0.2.0_amd64.deb`
- `Hermes Agent-0.2.0.dmg`
- `Hermes Agent-0.2.0-mac.zip`

## Architecture

```
┌─────────────────────────────────────────┐
│  Electron (Chromium window)             │
│  ├─ loads http://127.0.0.1:55000/       │
│  └─ embeds frontend (src/mainview)      │
└──────────────────┬──────────────────────┘
                   │ spawns
┌──────────────────▼──────────────────────┐
│  Bun Backend Service                    │
│  ├─ HTTP static server + HTTP-RPC       │
│  ├─ SQLite direct access (state.db)     │
│  └─ proxies /api/* to Python backend    │
└──────────────────┬──────────────────────┘
                   │ spawns
┌──────────────────▼──────────────────────┐
│  Hermes Agent API Server (Python)       │
│  ├─ /v1/chat/completions (SSE)          │
│  ├─ /v1/models                          │
│  └─ /health                             │
└─────────────────────────────────────────┘
```

- **Port 55000** — Bun HTTP server (frontend static files + RPC)
- **Port 8642+** — Hermes Python API server (OpenAI-compatible endpoints)
- **Isolation** — the GUI uses its own `HERMES_HOME` (`~/.hermes-agent-gui`) so it does not interfere with an existing Telegram/Discord Gateway

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + N` | New chat |
| `Ctrl/Cmd + K` | Focus input box |
| `Enter` (default) | Send message |
| `Shift + Enter` | Insert newline |
| `/` | Open slash command menu |

## Release Workflow

This repo uses GitHub Actions to build and publish releases automatically.

1. Bump the version in `package.json`.
2. Create and push a Git tag:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. GitHub Actions builds Linux (AppImage / deb) and macOS (DMG / zip) packages and uploads them to the release page.

## License

MIT
