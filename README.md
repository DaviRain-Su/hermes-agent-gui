# Hermes Agent GUI

一个用 **ElectroBun** 为 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 打造的轻量级桌面 GUI。

## 架构

```
┌─────────────────────────────────────┐
│  ElectroBun App (TypeScript + Bun)  │
│  ├─ Bun 主进程: 启动/管理 Python    │
│  └─ WebView 前端: 聊天界面          │
└────────────┬────────────────────────┘
             │ HTTP localhost:8642
┌────────────▼────────────────────────┐
│  Hermes Agent API Server (Python)   │
│  ├─ /v1/chat/completions (SSE)      │
│  ├─ /v1/models                      │
│  └─ /health                         │
└─────────────────────────────────────┘
```

- **体积小**：不打包 Chromium，使用系统 WebView
- **隔离性好**：GUI 使用独立的 `HERMES_HOME` (`~/.hermes-agent-gui`)，不会干扰你正在运行的 Telegram/Discord Gateway
- **API 优先**：完全复用 Hermes 已有的 OpenAI-compatible API Server，不改动任何 Agent 核心逻辑

## 环境要求

1. **Bun** (≥1.2) — [安装指南](https://bun.sh/docs/installation)
2. **Python** (≥3.11) — Hermes Agent 运行所需
3. **Hermes Agent 源码** — 你的 fork (`DaviRain-Su/hermes-agent`) 或原版 NousResearch 仓库

## 安装依赖

```bash
cd /path/to/hermes-agent-gui
bun install
```

## 配置 Hermes 路径

程序会自动在以下位置搜索 Hermes Agent 源码：
- `$HERMES_AGENT_DIR` (环境变量)
- `~/dev/active/hermes-agent`
- `~/dev/hermes-agent`
- `~/Projects/hermes-agent`
- `~/hermes-agent`

如果源码在其他位置，请设置环境变量：

```bash
export HERMES_AGENT_DIR=/path/to/your/hermes-agent
```

## 运行（开发模式）

```bash
bun run dev
```

这会启动 ElectroBun 桌面窗口，Bun 主进程会自动：
1. 寻找 Python 和 Hermes 源码
2. 创建隔离的 `~/.hermes-agent-gui` 目录
3. 复制你的 `~/.hermes/config.yaml`（仅保留 `api_server` 相关配置）
4. 启动 Hermes API Server（端口自动探测，默认从 8642 开始）
5. 前端连接本地 API 并开始聊天

## 项目结构

```
hermes-agent-gui/
├── electrobun.config.ts      # ElectroBun 构建配置
├── package.json
├── python/
│   └── bootstrap.py          # 启动 Hermes Gateway（仅 API_SERVER）
├── src/
│   ├── bun/
│   │   └── index.ts          # Bun 主进程：生命周期 + RPC
│   ├── mainview/
│   │   ├── index.html        # 聊天界面
│   │   ├── index.css         # 暗色主题样式
│   │   └── index.ts          # 前端逻辑：SSE 流式渲染
│   └── types/
│       └── rpc.ts            # (可选) 共享 RPC 类型
└── README.md
```

## 功能现状

- ✅ 自动启动/停止 Hermes API Server
- ✅ 隔离的 `HERMES_HOME`，不冲突现有 Gateway
- ✅ 流式对话（SSE `/v1/chat/completions`）
- ✅ Markdown 基础渲染（代码块、加粗、斜体、链接）
- ✅ 新会话 / 历史清空
- ✅ 后端状态指示器 + 一键重启
- ✅ 后端日志通过 RPC 透传到 DevTools Console
- ✅ **模型切换**：侧边栏直接修改 Provider + Model，自动写 `config.yaml` 并重启后端生效
- ✅ **会话历史侧边栏**：读取 `~/.hermes-agent-gui/sessions/`，点击加载历史消息
- ✅ **文件拖拽上传**：拖拽文件到聊天区域，保存到 `~/.hermes-agent-gui/uploads/`，随消息一起发送
- ✅ **Tool call 可视化**：流式完成后自动把 `` `emoji ToolName` `` 渲染为可折叠卡片
- ✅ **应用内快捷键**：`Ctrl/Cmd+N` 新建会话、`Ctrl/Cmd+K` 聚焦输入框

## 待办 / 可扩展方向

- [ ] **全局系统快捷键**：`Cmd/Ctrl + Shift + Space` 快速唤起窗口（等待 ElectroBun 暴露 globalShortcut API）
- [ ] **Vision 图片分析**：当前 API Server 对 `image_url` 支持有限，待 Hermes 升级后可自动解析附件图片
- [ ] **打包分发**：`bun run build` 后得到 macOS/Windows/Linux 原生应用

## 打包 release（示例）

```bash
bun run build
```

构建产物通常位于 `dist/` 或 ElectroBun 默认输出目录。你可以参考 [ElectroBun 文档](https://blackboard.sh/electrobun/) 进行签名和自动更新配置。

## 常见问题

**Q: 为什么后端显示 Offline？**
A: 检查 ElectroBun 主进程 Console（启动时带 `--verbose` 或查看终端输出），通常是：
- Python 未找到
- Hermes Agent 源码路径不正确
- `aiohttp` 未安装（运行 `pip install aiohttp` 或在 Hermes 虚拟环境中安装）

**Q: 如何与已有的 Hermes Gateway（Telegram 等）共存？**
A: 本 GUI 使用独立的 `HERMES_HOME=~/.hermes-agent-gui`，所以不会冲突。但它也不会共享你的 Telegram 会话历史。如果你希望共享，需要更复杂的架构（如连接到已有 Gateway 的 API Server）。

**Q: 可以修改前端技术栈吗？**
A: 完全可以。`src/mainview/` 是一个标准 WebView 页面，你可以加入 React/Vue/Svelte 或 Tailwind CSS，只需要把 `electrobun.config.ts` 的 `entrypoint` 指向你的构建产物即可。
