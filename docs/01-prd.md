# Phase 1: PRD（产品需求文档）

> **目的**: 定义「要解决什么问题」和「做完后是什么样子」  
> **输出物**: 填写完成的本文档，存放到 `/docs/01-prd.md`

---

## 1.1 项目概述（必填）

**项目名称**: Hermes Agent GUI — 自动安装与配置向导  
**所属模块**: hermes-agent-gui（独立桌面应用功能模块）  
**版本**: v0.1  
**日期**: 2026-04-08  
**作者**: DaviRain  

## 1.2 问题定义（必填）

### 要解决的问题
用户想在本地使用 Hermes Agent GUI 聊天，但必须先手动在终端执行 `curl | bash` 安装 hermes-agent 源码，再运行 `hermes setup` 回答一系列交互式命令行问题，整个过程对非技术用户不友好且打断了 GUI 的连贯体验。

### 当前状态
- 用户必须手动运行安装脚本 `curl -fsSL ... | bash`
- 安装后必须手动运行 `hermes setup`（命令行交互式向导）配置 API key、模型、终端后端等
- `hermes-agent-gui` 启动时只在固定路径搜索 hermes-agent 源码，如果找不到就直接报错退出
- 没有图形化入口来管理安装和初始配置

### 目标状态
- GUI 应用首次启动时自动检测 hermes-agent 是否已安装
- 若未安装，在 GUI 内通过弹窗/向导引导用户一键安装（自动执行 install.sh 或等效流程）
- 安装完成后，若缺少有效配置，在 GUI 内提供视觉化表单替代 `hermes setup` 命令行向导
- 用户从打开 GUI 到可以开始聊天，全程不需要离开应用去操作终端

## 1.3 用户故事（必填）

| # | 角色 | 想要 | 以便 | 优先级 |
|---|------|------|------|--------|
| 1 | 非技术用户 | 打开 GUI 后自动帮我安装好 hermes-agent | 不用碰命令行 | P0 |
| 2 | 普通用户 | 在 GUI 里填写 API key 和选择模型 | 不用记忆 `hermes setup` 的命令和参数 | P0 |
| 3 | 已有 hermes-agent 的用户 | GUI 自动探测我现有的 hermes-agent 安装并使用它 | 避免重复安装和配置冲突 | P1 |
| 4 | 高级用户 | 可以跳过自动安装/向导，手动指定 hermes-agent 目录 | 保留对源码位置和配置的控制权 | P1 |

## 1.4 功能范围（必填）

### 做什么（In Scope）
- [x] **安装检测**: GUI 启动时检测 hermes-agent 源码和 CLI 是否可用
- [x] **自动安装**: 当检测不到 hermes-agent 时，在 GUI 中下载并执行官方 install.sh（带用户确认和进度展示）
- [x] **图形化配置向导**: 替代 `hermes setup` 的交互式 CLI，用 WebView 表单收集：模型提供商、API key、默认模型、终端后端偏好
- [x] **配置写入**: 将配置写入隔离的 GUI 配置目录（`~/.hermes-agent-gui/config.yaml` 和 `.env`）
- [x] **进度与日志透传**: 安装和配置过程中的 stdout/stderr 实时显示在 GUI 的日志/状态面板
- [x] **手动覆盖**: 提供环境变量或设置入口，允许高级用户手动指定 hermes-agent 安装目录

### 不做什么（Out of Scope）
- 不重新实现 hermes-agent 的安装逻辑（仍然复用官方 install.sh）
- 不处理需要系统级 root 权限的依赖自动安装（如 ffmpeg/ripgrep）；仅提示用户，不替用户执行 sudo
- 不迁移现有 Telegram/Discord gateway 配置到 GUI（GUI 仍然只启用 api_server 以保持隔离）
- 不打包/分发 hermes-agent 源码到 GUI 安装包中（仍然采用在线 clone）
- 不支持 Windows 原生安装（仍然通过 WSL2 路径间接支持，或明确提示不支持）

## 1.5 成功标准（必填）

| 标准 | 指标 | 目标值 |
|------|------|--------|
| 功能完成 | 所有 P0 用户故事在干净环境（无 hermes-agent）下通过 | 100% |
| 零终端依赖 | 首次使用的用户从打开 GUI 到成功发送第一条消息，无需打开终端 | 是 |
| 自动探测成功率 | GUI 在常见安装路径（`~/.hermes/hermes-agent`、`~/dev/hermes-agent` 等）自动探测到现有安装 | >= 90% |
| 配置隔离性 | GUI 的配置目录（`~/.hermes-agent-gui`）不会覆盖用户原有的 `~/.hermes` CLI 配置 | 0 冲突 |
| 安装失败回退 | install.sh 执行失败时，GUI 能展示错误日志并提供手动安装指引 | 100% 可回退 |

## 1.6 约束条件（必填）

| 约束类型 | 具体描述 |
|---------|---------|
| 技术约束 | GUI 使用 ElectroBun（Bun + 系统 WebView），安装流程由 Bun 主进程通过 `Bun.spawn` 驱动 |
| 时间约束 | MVP 版本在单周内完成 Phase 1-6（按 dev-lifecycle 分形粒度） |
| 资源约束 | 1 人开发，保持最小可维护代码量 |
| 依赖约束 | 复用 NousResearch/hermes-agent 官方 install.sh，不 fork 或修改其安装逻辑 |
| 安全约束 | install.sh 涉及 `curl | bash`，必须在 GUI 中明确提示用户并获得确认；日志需完整透出 |

## 1.7 先搜索，再建造 (Search Before Building)

### Layer 1: 经过验证的 (Tried and True)

| 搜索项 | 搜索位置 | 预期结果 |
|--------|---------|---------|
| hermes-agent 官方安装脚本 | `https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh` | 脚本内容：安装 uv → Python 3.11 → git clone → venv → 依赖 → `hermes setup` → gateway service（可选） |
| hermes-agent 官方 README | `https://raw.githubusercontent.com/NousResearch/hermes-agent/main/README.md` | 确认安装入口、配置命令、`hermes setup` 的作用范围 |
| ElectroBun 子进程 API | 现有代码库 `src/bun/index.ts` | `Bun.spawn` 已成熟使用，可复用现有日志透传机制 |

**关键发现**: install.sh 已经完整处理了环境初始化流程，包括 uv、Python、Node.js、venv、PATH 设置。我们不需要重写，只需要在 GUI 中调用它并展示进度。

### Layer 2: 新颖流行的 (New and Popular)

| 搜索项 | 搜索位置 | 注意事项 |
|--------|---------|---------|
| 桌面应用内嵌安装脚本的最佳实践 | 经验/社区讨论 | 核心共识：必须给用户明确的确认 + 实时进度 + 取消按钮；`curl \| bash` 虽然常见但要有透明度 |
| 配置向导表单替代 CLI 向导 | 竞品分析 (Ollama Desktop, Claude Desktop) | 均采用首次启动向导 + 设置页 fallback 的模式 |

### Layer 3: 第一性原理 (First Principles)

| 思考问题 | 记录 |
|---------|------|
| 大家都在做的假设是什么？ | "用户已经会打开终端并执行安装命令" |
| 这些假设在当前场景下还成立吗？ | 不成立。GUI 的目标用户可能正是为了"不用终端" |
| 如果打破这些假设，会有什么新方案？ | 把 install.sh 当作一个可被 GUI 编排的"后端服务"，GUI 负责：触发、监控、失败回退、结果配置 |

### Eureka Moment（顿悟时刻）

> **命名**: "Installer as a Service"  
> **核心洞察**: 我们不是在重写安装器，而是在为安装器提供一个图形化的壳（Shell）。这个壳的价值不是替代 install.sh 的逻辑，而是把它的输入/输出转化为用户可理解的视觉流程。  
> **庆祝它**: 这意味着实现成本极低（复用现有脚本），但用户体验收益极高。  
- [x] 命名它
- [x] 记录它
- [x] 庆祝它

## 1.8 代码库探索 (Explore Agent)

### 项目概况
- **语言/框架**: TypeScript (Bun runtime) + ElectroBun + Python (bootstrap)
- **代码规模**: 约 15 个源文件
- **主要模块**: 
  - `src/bun/index.ts` — Bun 主进程（生命周期、RPC、子进程管理）
  - `src/mainview/` — WebView 前端（HTML/CSS/TS）
  - `python/bootstrap.py` — 启动 Hermes API Server 的 Python 入口
  - `python/config_manager.py` — 配置管理辅助脚本（模型切换、会话列表）

### 关键发现
1. `src/bun/index.ts` 已有成熟的 `Bun.spawn` 日志透传机制和 RPC，可直接复用
2. `python/bootstrap.py` 已会创建隔离的 `HERMES_HOME=~/.hermes-agent-gui` 并清理平台配置（只保留 `api_server`）
3. 现有 RPC 接口包括 `getCurrentModel`、`setModel`、`listSessions` 等，说明 RPC 通道已经打通
4. `findHermesAgentDir()` 只在 5 个固定路径搜索，且找不到就直接报错；这是本次优化的核心入口

### 与本次需求的关联
- **复用机会**: `Bun.spawn` + RPC 日志透传、`python/bootstrap.py` 的隔离 HERMES_HOME 机制
- **集成点**: 在 `startBackend()` 之前插入"安装检测 → 可选安装 → 可选配置向导"流程
- **潜在风险**: install.sh 可能在非交互式环境（如 `curl | bash`）中出现 tty 读取问题；需要测试并从 GUI 正确传递 stdin

## 1.9 相关文档（可选）

| 文档 | 链接 | 关系 |
|------|------|------|
| hermes-agent install.sh | `https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh` | 复用对象 |
| hermes-agent README | `https://github.com/NousResearch/hermes-agent` | 上游项目 |
| hermes-agent-gui README | `./README.md` | 当前项目背景 |

---

## ✅ Phase 1 验收标准

- [x] 1.1-1.6 所有「必填」部分已完成
- [x] 用户故事至少 3 个
- [x] 「不做什么」已明确列出
- [x] 成功标准可量化
- [ ] 团队/相关人已 review（单人项目，待作者自审后通过）

**验收通过后，进入 Phase 2: Architecture →**
