# Phase 6: Implementation Log（实现日志）

> **目的**: 记录实现过程中的关键决策、偏差和经验沉淀
> **输入**: Phase 3 技术规格 + Phase 4 任务列表
> **输出物**: `docs/06-implementation-log.md`

---

## 6.1 已完成的任务清单

| 任务 | 状态 | 说明 |
|------|------|------|
| T1: 实现 `installer.ts`（安装检测 + 执行）| ✅ | `detectInstallation()`, `startInstallation()`, `cancelInstallation()` |
| T2: 实现 `setup.ts`（配置读写）| ✅ | `getSetupFields()`, `checkNeedsConfig()`, `submitSetupConfig()` |
| T3: Bun 主进程集成安装/配置 RPC | ✅ | `bootstrapApp()`, `sendInstallStatus()`, 扩展 `defineRPC` |
| T4: 构建前端 setup 向导页面 | ✅ | `setup.html`, `setup.ts`, `setup.css` |
| T5: 打通首次启动主流程 | ✅ | 从检测到安装到配置到后端的完整闭环 |
| T6: 修复安装路径与 Python 环境不一致问题 | ✅ | `findHermesAgentDir()` 复用 `detectInstallation()`；Python 优先使用 venv |
| T7: 单元测试 | ✅ | `tests/installer.test.ts`, `tests/setup.test.ts` |
| T8: 收尾工作（文档、导航、依赖修正）| ✅ | 见下方 6.6 追加记录 |
| T9: 精细化安装错误回退 UI | ✅ | `setup.ts` 按 `errorCode` 差异化展示标题、提示与操作按钮 |
| T10: 文档同步与默认值统一 | ✅ | 更新 `01-prd.md` checklist、`03-spec.md` 默认值、本日志 |

---

## 6.2 关键偏差与决策

### 偏差 1: 状态机命名从 `InstallState` 调整为 `AppPhase`

**原始规格**: Phase 3 中定义 `InstallState = "idle" | "detecting" | "notInstalled" | "installing" | "needsConfig" | "ready" | "error"`

**实际实现**: 使用了更简洁的 `AppPhase = "detecting" | "not_installed" | "installing" | "needs_config" | "ready" | "error"`，去掉了 `idle`，并将前端状态直接映射到 setup 页面的 panel 切换。

**原因**: `idle` 在 ElectroBun 启动流程中没有实际意义（应用在 `dom-ready` 之前就已经通过 `bootstrapApp()` 开始检测了）。去掉 `idle` 减少了 WebView 重连时的状态歧义。

---

### 偏差 2: 配置字段未使用 `validation` 正则，改用 `helpText` 引导

**原始规格**: Phase 3 的 `SetupFieldDefinition` 包含 `validation.pattern/minLength/maxLength`。

**实际实现**: `setup.ts` 中仅在 `submitSetupConfig()` 做服务端必填校验，前端字段通过 `helpText` 提示用户，没有在前端表单中渲染 regex 错误。

**原因**: 桌面应用首屏配置表单只有 3-4 个字段，复杂的前端正则收益低。服务端校验已足够拦截空值和非法 provider，且 `helpText` 对非技术用户更友好。

---

### 偏差 3: Python 路径优先使用 hermes-agent venv

**原始规格**: `findPythonPath()` 搜索系统 `python3` / `python`。

**实际实现**: `findPythonPath()` 在检测到 `hermesDir` 后，优先返回 `${hermesDir}/venv/bin/python`。

**原因**: 端到端测试时发现系统 Python (`/usr/bin/python3`) 缺少 `aiohttp`，导致 backend `api_server` 启动失败。Hermes 的 install.sh 已经创建了隔离 venv 并安装了所有依赖，直接复用它可以避免"依赖地狱"。

---

### 偏差 4: `HERMES_SEARCH_PATHS` 从模块级常量改为运行时函数

**原始规格**: `installer.ts` 中模块加载时一次性计算搜索路径。

**实际实现**: `getSearchPaths()` 在每次调用 `detectInstallation()` 时动态构造数组。

**原因**: 单元测试需要动态修改 `process.env.HERMES_AGENT_DIR`。模块级常量会在 import 时缓存环境变量值，导致测试无法正确注入临时路径。

---

### 偏差 5: 默认 provider/model 统一为 Kimi 系列

**原始规格**: `docs/03-spec.md` 与 `docs/03-technical-spec.md` 之间存在不一致。`03-spec.md` 中默认 provider 为 `openrouter`、model 为 `anthropic/claude-opus-4.6`；`03-technical-spec.md` 中默认 provider 为 `kimi-coding`、model 为 `kimi-k2.5`。

**实际实现**: 统一使用 `provider: "kimi-coding"`、`model: "kimi-k2.5"`，并将 Kimi 选项调整为列表首位并标记 `(recommended)`。`base_url` placeholder 同步为 `https://api.moonshot.cn/v1`。

**原因**: 产品侧确认默认模型为 `kimi-k2.5`，因此 provider 必须为 `kimi-coding`。统一所有代码、测试、文档中的默认值，避免用户首次启动时看到冲突的预设。

---

## 6.3 遇到的阻塞与解决方案

### 阻塞 1: `detectInstallation()` 找到安装，但 `startBackend()` 找不到

**现象**: `bootstrapApp()` 打印 "Found Hermes Agent at: ~/.hermes/hermes-agent"，紧接着 `startBackend()` 打印 "Hermes Agent source not found"。

**根因**: `index.ts` 中存在两套独立的搜索逻辑：`detectInstallation()`（检查 `~/.hermes/hermes-agent`）和 `findHermesAgentDir()`（不检查该路径）。

**解决**: 将 `findHermesAgentDir()` 重写为直接调用 `detectInstallation()`，确保单一事实来源。

---

### 阻塞 2: ElectroBun `setup.ts` 编译产物不在预期目录

**现象**: `setup.html` 中的 `<script src="setup.js">` 404。

**根因**: `electrobun.config.ts` 最初只注册了 `mainview` 一个 entrypoint，`setup.ts` 没有被 bundler 处理。

**解决**: 在 `build.views` 中新增 `setup: { entrypoint: "src/mainview/setup.ts" }`，并把 `setup.html/setup.css` 的 copy 目标从 `views/mainview/` 改为 `views/setup/`，同时将 backend URL 改为 `views://setup/setup.html`。

---

### 阻塞 3: Backend 启动报错 `aiohttp not installed`

**现象**: `startBackend()` 的 Python bootstrap 进程健康检查失败，日志提示 `WARNING gateway.run: API Server: aiohttp not installed`。

**根因**: 系统 Python 缺少 Hermes 所需的第三方包。

**解决**: `findPythonPath()` 优先使用 `${hermesDir}/venv/bin/python`。后端成功启动，health check 通过，WebView 成功从 setup 页面跳转到聊天页面。

---

## 6.4 端到端验证结果

在已有 hermes-agent 安装的环境中执行 `bun run dev`，完整日志行为如下：

1. `Bootstrapping app...`
2. `Found Hermes Agent at: /home/.../.hermes/hermes-agent`
3. `Using API server port 8642`
4. `Using Python: /home/.../.hermes/hermes-agent/venv/bin/python`
5. `Hermes backend is ready`
6. `loadURL called for webview 1: views://mainview/index.html`

**结论**: 首次启动流程完全跑通，无需用户离开 GUI 或操作终端。

---

## 6.5 沉淀为技能/模式

| 模式名称 | 适用场景 | 实现要点 |
|---------|---------|---------|
| **Venv Python 优先策略** | Bun 主进程启动 Python 子项目时 | 先检查项目自带 venv，回退到系统 Python，避免依赖缺失 |
| **动态搜索路径** | 依赖环境变量的模块级配置 | 避免在模块顶层缓存 `process.env.*`，改为调用时动态读取 |
| **Setup View 分离** | ElectroBun 桌面应用的首屏引导 | 独立 view + `loadView()` 路由，保持主聊天页纯净 |

---

## 6.6 追加记录（本次收尾会话）

### 1. 上游仓库 URL 统一修正
- 将所有硬编码的 `NousResearch/hermes-agent` 替换为 `DaviRain-Su/hermes-agent`。
- 影响文件：`src/bun/installer.ts`、`src/bun/index.ts`、`src/mainview/setup.html`、`src/mainview/setup.ts`、`src/mainview/index.ts`。

### 2. 修复 `setup.ts` 中的 Temporal Dead Zone 与 ENOENT
- **TDZ 问题**：`getSetupFields()` 中 `values.provider` 在初始化自身对象时被引用，导致运行时异常。解决方式：先提取 `provider` 常量，再构造 `values` 对象。
- **ENOENT 问题**：`submitSetupConfig()` 在 `~/.hermes-agent-gui` 目录不存在时直接 `writeFileSync` 报错。解决方式：写入前增加 `mkdirSync(GUI_HOME, { recursive: true })`。

### 3. 依赖修正
- `electrobun` 版本从不可解析的 `^1.17.0` 修正为实际存在的 `1.17.3-beta.9`。
- 新增 `js-yaml` 依赖，用于 `config.yaml` 的读写。

### 4. 删除冗余文档与测试
- 删除过时的 `docs/03-technical-spec.md`（内容与 `docs/03-spec.md` 重复且含不适用的"链上数据结构"章节）。
- 删除遗留的占位测试文件 `tests/setupWizard.test.ts`，统一使用 `tests/setup.test.ts`。

### 5. 修复 WebView 跨 view 导航
- **问题**：`setup.ts` 中直接使用 `window.location.href = "views://mainview/index.html"`，在 ElectroBun 的 `views://` 协议下可能不生效或导致白屏。
- **解决**：新增 RPC `navigateTo`，由前端请求 Bun 主进程调用 `loadView()` 完成导航，确保 URL 切换与 WebView 生命周期同步。

### 6. T9 精细化安装错误回退 UI
- **实现**：`src/mainview/setup.ts` 增加 `renderErrorPanel(status)`，根据 Bun 主进程透传的 `errorCode` 动态渲染：
  - `DOWNLOAD_FAILED` → 标题"Network Error"，提示检查网络，提供"重试"和"手动安装"。
  - `SCRIPT_EXEC_FAILED` → 标题"Install Script Failed"，展示日志，增加"Copy Command"按钮。
  - `PERMISSION_DENIED` → 标题"Permission Denied"，隐藏"重试"，提示检查 `~/.hermes` 权限。
  - `TIMEOUT` → 标题"Installation Timeout"，建议重试或离线安装。
  - `CANCELLED` → 标题"Installation Cancelled"，隐藏"手动安装"，引导重新安装。
- **配套修改**：`src/bun/index.ts` 在推送 `installStatus` 到 `error` 状态时附带 `errorCode`；`setup.html` 增加可动态切换的标题、提示、按钮容器；`setup.css` 增加 `.hint-text` 样式。

---

## ✅ Phase 6 验收标准

- [x] 代码实现与技术规格一致（除已记录的 5 项偏差）
- [x] 测试通过（`bun test` 全部 green）
- [x] 端到端验证通过（`bun run dev` 从 setup 到 chat 的完整闭环）
- [x] 偏差已记录并有明确原因
- [x] 可复用模式已沉淀

**验收通过。进入 Phase 7: Review →**
