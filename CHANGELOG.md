# Changelog

All notable changes to this project will be documented in this file.

## [0.5.0] - 2026-04-09

### Refactor
- **Major architecture overhaul**: split the 4256-line `src/mainview/index.ts` monolith into maintainable modules:
  - `state.ts` — centralized mutable state and shared types
  - `utils/dom.ts` — DOM helpers
  - `utils/format.ts` — content formatting
  - `utils/rpc.ts` — HTTP-RPC client with `onRpcSend` handler registry (eliminates circular deps)
  - `components/workspace.ts` — workspace CRUD + preview
  - `components/chat.ts` — message rendering, streaming, sending
  - `components/composer.ts` — drafts, slash commands, mentions
  - `components/overlays.ts` — search, palette, lightbox, onboarding, install
  - `components/sidebar.ts` — sessions, projects, drag-sort
  - `components/settings.ts` — themes, snippets, CSS, gist sync, export
- Reduced `index.ts` from **4256 → ~1600 lines** (-62%).

### Added
- Settings panel: inline **Rename** and **Delete** actions for profiles.
- Settings panel: **Security** section for updating the auth password (`setPassword`).

### Fixed
- ESM immutability issue with shared state: migrated from `export let` to a mutable `AppState` container.

---

## [0.4.1] - 2026-04-08

### Added
- **Command Palette** (`Ctrl/Cmd+Shift+P`) for quick navigation and actions.
- **Cloud sync** via GitHub Gist (backup/restore settings).
- **Model Compare** mode: A/B split-pane testing for two models side-by-side.
- **Custom CSS injection** in Settings.
- Copy full message text button.
- **Mermaid diagram export** to SVG.
- Lightbox for attachment thumbnails in messages and workspace previews.
- Code block language badge.
- Session list search filter in sidebar.
- Workspace right-click context menu.
- Scroll-to-bottom indicator when scrolled up.
- Pause auto-scroll when user scrolls up during streaming.
- Composer word and character count.
- Message timestamp display with Settings toggle.
- Built-in prompt snippet library.
- Auto-save composer draft per session.
- Copy button for code blocks.
- Print / save as PDF for conversation.
- In-conversation message search.
- Session drag-sort in sidebar.
- Composer `@` mention for workspace files.

### Fixed
- CI build failures in release workflow.
- Optimized long conversation loading.

---

## [0.4.0] and earlier

See git history for detailed changes prior to v0.4.0.
