# Phase 3: Technical Spec（技术规格）

> **目的**: 把架构设计转化为可执行的接口定义、数据结构和实现路径  
> **输入**: Phase 1 PRD (`docs/01-prd.md`) + Phase 2 Architecture (`docs/02-architecture.md`)  
> **输出物**: 填写完成的本文档，存放到 `/docs/03-spec.md`

---

## 3.1 接口定义（必填）

### 3.1.1 RPC Schema 扩展

在现有 `AppRPCSchema` 基础上新增以下请求/消息。

#### Bun 主进程 → WebView (Push Messages)

| 消息名 | Payload | 触发时机 | 说明 |
|--------|---------|----------|------|
| `installStatus` | `InstallStatusPayload` | 安装阶段变化时 | 替换原来的 `backendStatus` 在首次启动流程中的角色 |
| `installLog` | `{ stream: "stdout" \| "stderr"; text: string }` | install.sh 有输出时 | 与现有 `backendLog` 格式一致 |
| `setupFields` | `{ fields: SetupFieldDef[]; values: Record<string, string> }` | 进入配置向导时 | 前端用此数据渲染表单 |

#### WebView → Bun 主进程 (Requests)

| 请求名 | Params | Response | 说明 |
|--------|--------|----------|------|
| `detectInstallation` | `{}` | `DetectInstallationResult` | 检测 hermes-agent 安装状态 |
| `startInstallation` | `{ confirm: boolean }` | `StartInstallationResult` | 开始下载并执行 install.sh |
| `cancelInstallation` | `{}` | `{ success: boolean }` | 中断 install.sh 子进程 |
| `getSetupFields` | `{}` | `{ fields: SetupFieldDef[]; values: Record<string, string> }` | 获取配置表单定义和默认值 |
| `submitSetupConfig` | `Record<string, string>` | `SubmitSetupResult` | 提交配置并写入文件 |

### 3.1.2 类型定义

```typescript
// Install / Setup 类型
interface InstallStatusPayload {
  phase: "detecting" | "not_installed" | "installing" | "needs_config" | "ready" | "error";
  progress?: number; // 0-100，installing 阶段可用
  message?: string;  // 用户可见的状态文案
  canCancel?: boolean;
  canRetry?: boolean;
}

interface DetectInstallationResult {
  installed: boolean;
  path?: string;
  version?: string;
  source?: "auto_detect" | "env_var" | "manual";
}

interface StartInstallationResult {
  success: boolean;
  errorCode?: InstallErrorCode;
  errorMessage?: string;
}

type InstallErrorCode =
  | "ALREADY_INSTALLED"
  | "DOWNLOAD_FAILED"
  | "SCRIPT_EXEC_FAILED"
  | "PERMISSION_DENIED"
  | "CANCELLED"
  | "TIMEOUT"
  | "UNKNOWN";

interface SetupFieldDef {
  id: string;
  label: string;
  type: "text" | "password" | "select" | "checkbox";
  required: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[]; // 用于 select
  defaultValue?: string;
  helpText?: string;
}

interface SubmitSetupResult {
  success: boolean;
  writtenTo: string[]; // 例如 ["~/.hermes-agent-gui/config.yaml", "~/.hermes-agent-gui/.env"]
  errors?: { fieldId: string; message: string }[];
}
```

### 3.1.3 错误码语义

| 错误码 | HTTP 对应 | 用户可见文案 | 回退动作 |
|--------|-----------|--------------|----------|
| `DOWNLOAD_FAILED` | — | "无法下载安装脚本，请检查网络连接" | 提供"重试"和"手动安装"按钮 |
| `SCRIPT_EXEC_FAILED` | — | "安装脚本执行失败，点击查看日志" | 展示完整 stderr，提供"复制命令手动执行" |
| `PERMISSION_DENIED` | — | "写入目录失败，请检查磁盘权限" | 提示用户更改 `~/.hermes` 权限或选择其他目录 |
| `CANCELLED` | — | "安装已取消" | 回到"未安装"状态，保留"重新安装"入口 |
| `TIMEOUT` | — | "安装超时，可能是网络较慢" | 提供"重试"和"离线安装指引" |

---

## 3.2 表单 Schema（必填）

Setup Wizard 仅展示**最小必要字段**，遵循 PRD "不暴露高级选项"原则。

```typescript
const DEFAULT_SETUP_FIELDS: SetupFieldDef[] = [
  {
    id: "provider",
    label: "Model Provider",
    type: "select",
    required: true,
    defaultValue: "kimi-coding",
    helpText: "Select the service that hosts your AI model.",
    options: [
      { label: "Kimi (Moonshot) (recommended)", value: "kimi-coding" },
      { label: "OpenRouter", value: "openrouter" },
      { label: "Anthropic", value: "anthropic" },
      { label: "OpenAI", value: "openai" },
      { label: "Google Gemini", value: "gemini" },
      { label: "GitHub Copilot", value: "copilot" },
      { label: "OpenCode", value: "opencode" },
      { label: "DeepSeek", value: "deepseek" },
      { label: "xAI (Grok)", value: "xai" },
      { label: "Z.AI (GLM)", value: "zai" },
      { label: "MiniMax", value: "minimax" },
    ],
  },
  {
    id: "model",
    label: "Default Model",
    type: "text",
    required: true,
    defaultValue: "kimi-k2.5",
    placeholder: "e.g. kimi-k2.5",
    helpText: "The model ID used for conversations.",
  },
  {
    id: "api_key",
    label: "API Key",
    type: "password",
    required: true,
    placeholder: "sk-...",
    helpText: "Your provider API key. Stored locally in ~/.hermes-agent-gui/.env",
  },
  {
    id: "base_url",
    label: "Base URL (optional)",
    type: "text",
    required: false,
    placeholder: "https://api.moonshot.cn/v1",
    helpText: "Only needed for custom or local endpoints.",
  },
];
```

### 3.2.1 配置写入规则

**写入 `~/.hermes-agent-gui/config.yaml`**:
```yaml
model:
  provider: <provider>
  default: <model>

providers:
  <provider>:
    api_key: <api_key>
    base_url: <base_url if provided>
```

**写入 `~/.hermes-agent-gui/.env`**（兼容 Hermes 旧版环境变量读取逻辑）:
```bash
HERMES_PROVIDER=<provider>
HERMES_MODEL=<model>
HERMES_API_KEY=<api_key>
HERMES_BASE_URL=<base_url if provided>
```

> 注意：`config.yaml` 是主配置源，`.env` 作为 fallback，确保 Hermes 的 credential 解析逻辑能正确读取。

---

## 3.3 状态机实现细节（必填）

### 3.3.1 内存状态

```typescript
// src/bun/index.ts 顶部新增
type AppPhase = "detecting" | "not_installed" | "installing" | "needs_config" | "ready" | "error";

let appPhase: AppPhase = "detecting";
let installPath: string | null = null;
let installProcess: Subprocess | null = null;
let installLogBuffer: string[] = []; // 保留最近 500 行
```

### 3.3.2 状态转换函数

```typescript
function setPhase(phase: AppPhase, extra?: { message?: string; progress?: number }) {
  appPhase = phase;
  const payload: InstallStatusPayload = {
    phase,
    message: extra?.message,
    progress: extra?.progress,
    canCancel: phase === "installing",
    canRetry: phase === "error" || phase === "not_installed",
  };
  mainWindowRef?.webview.rpc?.send?.installStatus?.(payload);
}
```

### 3.3.3 启动入口改造

将现有的 `startBackend()` 调用替换为 orchestrator：

```typescript
async function bootstrapApp() {
  setPhase("detecting");
  const detection = await detectInstallation();

  if (detection.installed) {
    installPath = detection.path || null;
    const needsConfig = await checkNeedsConfig();
    if (needsConfig) {
      setPhase("needs_config", { message: "Please complete the setup wizard." });
      return; // WebView 处于 setup 页面，等待用户提交
    }
    setPhase("ready");
    const ok = await startBackend();
    if (!ok) setPhase("error", { message: "Backend failed to start." });
    return;
  }

  setPhase("not_installed", { message: "Hermes Agent is not installed." });
  // WebView 处于 setup 页面，展示安装确认 UI
}
```

---

## 3.4 文件级实现清单（必填）

| 文件 | 改动类型 | 实现内容 | 验收标准 |
|------|----------|----------|----------|
| `src/bun/index.ts` | 修改 | 1. 新增 `appPhase`/`installPath`/`installProcess` 状态<br>2. 新增 `detectInstallation()` / `startInstallation()` / `cancelInstallation()` / `checkNeedsConfig()` / `getSetupFields()` / `submitSetupConfig()`<br>3. 改造启动入口为 `bootstrapApp()`<br>4. 注册新的 RPC handler | `detectInstallation` 在已安装环境返回 `installed: true`；在未安装环境返回 `installed: false` |
| `src/bun/installer.ts` | **新增** | `InstallerController` 纯逻辑：下载 install.sh、执行、进度回调、错误分类 | install.sh stdout 能逐行透传到 WebView |
| `src/bun/setup.ts` | **新增** | `SetupWizardController` 纯逻辑：读取/写入 `config.yaml` 和 `.env`、字段默认值、缺失检测 | 提交配置后文件存在且格式正确 |
| `src/mainview/setup.html` | **新增** | 向导页面骨架：状态面板、日志面板、表单面板 | 页面能在 WebView 中正常渲染 |
| `src/mainview/setup.css` | **新增** | 向导专用样式（与主界面风格一致） | 视觉风格统一 |
| `src/mainview/setup.ts` | **新增** | 向导前端逻辑：接收 `installStatus`/`installLog`/`setupFields`、调用 RPC、表单验证 | 点击"安装"按钮后能看到进度条和日志滚动 |
| `electrobun.config.ts` | 修改 | 增加 `copy` 规则，把 setup 页面资源复制到构建产物 | `bun run build` 后 setup 页面可用 |

---

## 3.5 安装流程详细步骤（必填）

### Step 1: 检测 (detectInstallation)
1. 读取 `process.env.HERMES_AGENT_DIR`
2. 遍历 `HERMES_SEARCH_PATHS`，检查 `gateway/run.py` 是否存在
3. 若找到，尝试运行 `python -c "import hermes_cli; print(hermes_cli.__version__)"` 获取版本
4. 返回 `{ installed: true, path, version, source: "auto_detect" }`

### Step 2: 下载 install.sh
1. 安装脚本 URL: `https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh`
2. 使用 `Bun.fetch` 或 `curl` 下载脚本内容到 `/tmp/hermes-install-<timestamp>.sh`
3. 校验脚本非空且开头包含 `#!/bin/bash`（防中间人篡改的第一道防线）

### Step 3: 执行 install.sh
```typescript
installProcess = spawn(["bash", scriptPath], {
  env: { PATH: process.env.PATH, HOME: homedir() },
  stdout: "pipe",
  stderr: "pipe",
});
```
- 通过 `reader.read()` 实时读取 stdout/stderr
- 每收到一行就 `rpc.send.installLog({ stream, text })`
- 同时推入 `installLogBuffer`

### Step 4: 完成/失败处理
- exitCode === 0 → `setPhase("needs_config")`
- exitCode !== 0 → 分析 stderr 关键字匹配错误码 → `setPhase("error", { message })`

---

## 3.6 前端路由/视图切换策略（必填）

ElectroBun 的 `BrowserWindow` 不支持 SPA 式路由切换，但支持**加载不同 URL**。采用以下策略：

| 阶段 | BrowserWindow 加载的 URL | 说明 |
|------|--------------------------|------|
| Detecting / NotInstalled / Installing / NeedsConfig / Error | `views://mainview/setup.html` | 统一由 setup 页面处理，根据 `installStatus` 消息切换内部视图 |
| Ready | `views://mainview/index.html` | 聊天主界面 |

**Bun 主进程中的切换逻辑**：
```typescript
function loadView(url: string) {
  mainWindowRef?.webview.loadURL(url);
}

// 在 bootstrapApp 和状态转换中调用
if (appPhase === "ready") {
  loadView("views://mainview/index.html");
} else {
  loadView("views://mainview/setup.html");
}
```

> 备选方案：如果 `loadURL` 有闪屏问题，可以在 setup 页面内用 CSS `display:none` 隐藏不同面板，避免页面重载。

---

## 3.7 错误处理与降级策略（必填）

| 错误场景 | 检测方式 | 降级行为 |
|----------|----------|----------|
| install.sh 下载失败 | `fetch().catch()` 或 `exitCode !== 0` | 展示"手动安装命令"：`git clone ... && cd hermes-agent && ./scripts/install.sh` |
| install.sh 执行到一半网络断开 | stderr 出现 `git clone` timeout / `curl` failure | `setPhase("error", { canRetry: true })` |
| 用户取消安装 | `cancelInstallation()` 被调用 | `installProcess.kill(9)`，清理临时脚本，回到 `not_installed` |
| 配置缺少必填项 | 前端表单验证 + 后端二次校验 | 表单字段标红，阻止提交 |
| config.yaml 写入失败 | `writeFileSync` throw | `SubmitSetupResult.success = false`，展示错误详情 |
| backend 启动失败 | health check timeout | `setPhase("error")`，提供"查看日志"和"重新配置"按钮 |

---

## 3.8 安全细节（必填）

1. **脚本执行前确认**
   - `startInstallation` RPC 要求 `params.confirm === true`，防止前端误触发
   - 首次调用时 Bun 进程会在日志中写入 `[SECURITY] Executing install.sh from https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh`

2. **API Key 输入保护**
   - 表单 `api_key` 字段 `type="password"`
   - `.env` 文件写入后 `chmod 600`

3. **路径注入防护**
   - `HERMES_AGENT_DIR` 从环境变量读取，不在 UI 中允许用户自由输入
   - 若未来需要自定义路径，先经过 `Path.resolve()` 和非法字符过滤 (`/[;|&$(){}[\]\\*?<>]/`)

---

## 3.9 测试策略（必填）

### 单元测试（Phase 5 执行）
- `detectInstallation()` 的 mock 测试（模拟目录存在/不存在）
- `SetupWizardController.writeConfig()` 的临时目录测试（验证 YAML 和 .env 输出）
- 错误码分类函数测试（给定 stderr 字符串，返回正确 `InstallErrorCode`）

### 集成测试（Phase 5 执行）
- 干净环境首次启动：临时 HOME 目录 → 启动 GUI → 验证进入 `not_installed` 状态
- 已有安装环境启动：指定 `HERMES_AGENT_DIR` → 启动 GUI → 验证直接跳转聊天界面或配置向导

### 手动测试清单
- [ ] 未安装环境：打开 GUI → 展示安装确认 → 点击安装 → 进度条和日志可见 → 安装完成后进入配置表单
- [ ] 已安装无配置环境：打开 GUI → 直接进入配置表单 → 填写 API key → 提交 → 进入聊天界面
- [ ] 已安装已配置环境：打开 GUI → 直接启动 backend → 3 秒内进入聊天界面
- [ ] 取消安装：安装过程中点击取消 → 子进程终止 → 展示"已取消" → 可重新安装
- [ ] 安装失败：断开网络后点击安装 → 展示下载失败 → 提供手动安装命令

---

## ✅ Phase 3 验收标准

- [x] RPC 接口已详细定义（参数、返回值、错误码）
- [x] 表单 Schema 已确定（字段、默认值、验证规则）
- [x] 状态机转换逻辑已文档化
- [x] 每个文件的职责和验收标准已明确
- [x] 安全细节（确认机制、密码输入、权限）已覆盖
- [x] 测试策略已规划

**验收通过后，进入 Phase 4: Implementation →**
