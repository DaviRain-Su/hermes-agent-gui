# Phase 5: Test Spec（测试规格）

> **目的**: 在写代码之前，定义所有测试用例。TDD 的核心。  
> **输入**: Phase 3 技术规格 + Phase 4 任务列表  
> **输出物**: 测试用例表 + 测试代码骨架，存放到 `/docs/05-test-spec.md`
>
> ⚠️ **每个技术规格中的接口/函数必须有对应的测试用例。**  
> ⚠️ **测试代码骨架先于实现代码编写。**

---

## 5.1 测试策略（必填）

| 测试类型 | 覆盖范围 | 工具 | 运行环境 |
|---------|---------|------|---------|
| 单元测试 | `InstallerController`、`SetupWizardController`、所有工具函数 | `bun:test` | 本地 Bun runtime |
| 集成测试 | RPC 状态机流转、配置读写、文件权限 | `bun:test` + mock 子进程 | 本地 |
| 端到端测试 | 完整首次启动流程（真实 install.sh） | 手工测试 | 干净 Linux/macOS 环境 |
| 安全测试 | 路径注入、URL 劫持、API key 泄露、权限绕过 | `bun:test` + 手工验证 | 本地 |
| 性能测试 | 安装检测耗时、后端 health check 响应 | `bun:test` / 计时测试 | 本地 |

---

## 5.2 测试用例表（必填）

### 5.2.1 `InstallerController.detect()`

**正常路径 (Happy Path)**

| # | 测试名称 | 输入 | 预期输出 | 预期状态变化 |
|---|---------|------|---------|-------------|
| H1 | 检测到默认路径安装 | `~/.hermes/hermes-agent/gateway/run.py` 存在 | `{ installed: true, path: "~/.hermes/hermes-agent" }` | 无 |
| H2 | 检测到环境变量指定路径 | `HERMES_AGENT_DIR=/custom/path` 且 `gateway/run.py` 存在 | `{ installed: true, path: "/custom/path" }` | 无 |
| H3 | 未检测到任何安装 | 所有搜索路径均不存在 | `{ installed: false }` | 无 |

**边界条件 (Boundary)**

| # | 测试名称 | 输入 | 预期行为 | 备注 |
|---|---------|------|---------|------|
| B1 | 目录存在但缺少核心文件 | `~/.hermes/hermes-agent` 存在但无 `gateway/run.py` | `{ installed: false }` | 不完整安装视为未安装 |
| B2 | 多路径同时命中 | `~/.hermes/hermes-agent` 和 `~/dev/hermes-agent` 均存在 | 返回 `HERMES_SEARCH_PATHS` 中第一个匹配的路径 | 优先级由搜索数组顺序决定 |

**异常/攻击 (Error/Attack)**

| # | 测试名称 | 输入/操作 | 预期行为 | 攻击类型 |
|---|---------|----------|---------|---------|
| E1 | 路径包含 shell 注入字符 | `HERMES_AGENT_DIR="/tmp/; rm -rf /"` | 返回 `{ installed: false }`（路径被拒绝） | 路径注入 |
| E2 | 路径包含反引号命令替换 | `` HERMES_AGENT_DIR="`/bin/sh`" `` | 返回 `{ installed: false }` | 命令注入 |

---

### 5.2.2 `InstallerController.downloadAndRun()`

**正常路径 (Happy Path)**

| # | 测试名称 | 输入 | 预期输出 | 预期状态变化 |
|---|---------|------|---------|-------------|
| H1 | 下载并执行 mock install.sh | 本地 mock 脚本输出 "Installation Complete" 并退出 0 | `true`；回调收到所有 stdout/stderr | 子进程正常退出 |

**边界条件 (Boundary)**

| # | 测试名称 | 输入 | 预期行为 | 备注 |
|---|---------|------|---------|------|
| B1 | 执行耗时刚好在超时边缘 | mock 脚本在 599999ms 内完成 | `true` | 临界点通过 |

**异常/攻击 (Error/Attack)**

| # | 测试名称 | 输入/操作 | 预期错误码 | 攻击类型 |
|---|---------|----------|-----------|---------|
| E1 | 下载 URL 返回 404 | `HERMES_INSTALL_SCRIPT_URL="https://httpbin.org/status/404"` | `INSTALL_NETWORK_ERROR` | 网络不可用 |
| E2 | 执行超时 | mock 脚本 `sleep 900` | `INSTALL_TIMEOUT` | 慢速 DoS |
| E3 | 脚本退出码非 0 | mock 脚本 `exit 1` | `INSTALL_SCRIPT_EXEC_FAILED` | 损坏/恶意脚本 |

---

### 5.2.3 `SetupWizardController.submit()`

**正常路径 (Happy Path)**

| # | 测试名称 | 输入 | 预期输出 | 预期状态变化 |
|---|---------|------|---------|-------------|
| H1 | 提交有效完整配置 | `{ provider: "kimi-coding", api_key: "sk-xxx", default_model: "kimi-k2.5" }` | `{ success: true }` | 生成 `config.yaml` + `.env` |
| H2 | 提交时复用已有默认值 | 只修改 api_key，其余留默认值 | `{ success: true }` | 非 api_key 字段保持原值 |

**边界条件 (Boundary)**

| # | 测试名称 | 输入 | 预期行为 | 备注 |
|---|---------|------|---------|------|
| B1 | API key 长度最小值 | `api_key: "x"` | `success: true` | 最小长度边界 |
| B2 | API key 长度最大值 | `api_key: "x".repeat(1024)` | `success: true` | 最大长度边界（以实际 validation 为准） |
| B3 | provider 刚好在白名单末尾 | 白名单最后一个有效 provider | `success: true` | 边界值有效 |

**异常/攻击 (Error/Attack)**

| # | 测试名称 | 输入/操作 | 预期错误码 | 攻击类型 |
|---|---------|----------|-----------|---------|
| E1 | API key 为空字符串 | `api_key: ""` | `CONFIG_VALIDATION_FAILED` | 缺失必填项 |
| E2 | provider 不在白名单 | `provider: "evil-provider"` | `CONFIG_PROVIDER_UNKNOWN` | 非法输入 |
| E3 | 配置目录不可写 | `HERMES_HOME_GUI=/root/.hermes-agent-gui`（假设无权限） | `CONFIG_WRITE_FAILED` | 权限绕过 |

---

### 5.2.4 `isValidHermesPath()`

**正常路径 (Happy Path)**

| # | 测试名称 | 输入 | 预期输出 | 预期状态变化 |
|---|---------|------|---------|-------------|
| H1 | 标准 Linux 绝对路径 | `/home/user/.hermes/hermes-agent` | `true` | 无 |
| H2 | 以 ~ 开头的路径 | `~/.hermes/hermes-agent` | `true` | 无 |

**边界条件 (Boundary)**

| # | 测试名称 | 输入 | 预期行为 | 备注 |
|---|---------|------|---------|------|
| B1 | 路径长度 512 | `"x".repeat(512)` | `true` | 最大长度边界 |
| B2 | 路径长度 513 | `"x".repeat(513)` | `false` | 超过最大长度 |

**异常/攻击 (Error/Attack)**

| # | 测试名称 | 输入/操作 | 预期输出 | 攻击类型 |
|---|---------|----------|---------|---------|
| E1 | 包含分号 | `/tmp/; rm -rf /` | `false` | 命令注入 |
| E2 | 包含管道符 | `/tmp/ | cat /etc/passwd` | `false` | 命令注入 |
| E3 | 相对路径 | `./hermes-agent` | `false` | 路径遍历 |

---

### 5.2.5 `getInstallScriptUrl()`

**正常路径 (Happy Path)**

| # | 测试名称 | 输入 | 预期输出 | 预期状态变化 |
|---|---------|------|---------|-------------|
| H1 | 使用环境变量 URL | `HERMES_INSTALL_SCRIPT_URL="https://mirror.example.com/install.sh"` | `"https://mirror.example.com/install.sh"` | 无 |
| H2 | 使用默认 URL | 无环境变量 | `"https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh"` | 无 |

**异常/攻击 (Error/Attack)**

| # | 测试名称 | 输入/操作 | 预期行为 | 攻击类型 |
|---|---------|----------|---------|---------|
| E1 | 环境变量使用 http | `HERMES_INSTALL_SCRIPT_URL="http://evil.com/install.sh"` | 抛出错误（拒绝非 HTTPS） | 协议降级攻击 |

---

## 5.3 集成测试场景（必填）

| # | 场景名称 | 步骤 | 预期结果 |
|---|---------|------|---------|
| I1 | 完整首次启动流程 | 1. 创建临时干净 home 目录 2. 启动 Bun 主进程逻辑 3. `detectInstallation` 返回未安装 4. 调用 `startInstallation` 执行 mock install.sh 5. install.sh 成功后 `checkConfig` 返回需要配置 6. `submitSetupConfig` 写入配置 7. 调用 `startBackend` 并 health check | `backendReady === true`，流程可进入聊天状态 |
| I2 | 安装中途取消 | 1. 启动安装（mock 脚本 sleep 60） 2. 调用 `cancelInstallation` 3. 检查子进程是否已终止 | 子进程 PID 不再存在，状态变为 `error` (`INSTALL_CANCELLED`) |
| I3 | 已有安装直接就绪 | 1. 预置 hermes-agent 源码和目标配置 2. 启动检测 3. 直接调用 `startBackend` | 跳过安装和配置向导，直接 health check 成功 |
| I4 | 安装成功但后端启动失败 | 1. 执行 mock install.sh 2. 提交配置 3. mock backend 启动脚本为 `exit 1` | 状态变为 `error` (`BACKEND_START_FAILED`) |

## 5.4 安全测试场景（必填）

| # | 攻击名称 | 攻击方式 | 预期防御 | 验证方法 |
|---|---------|---------|---------|---------|
| S1 | 自定义路径命令注入 | `HERMES_AGENT_DIR="/tmp/; whoami"` | `detect()` 视其为无效路径 | 单元测试 E1 |
| S2 | 安装脚本 URL 劫持 | `HERMES_INSTALL_SCRIPT_URL="http://evil.com/install.sh"` | `getInstallScriptUrl()` 抛出错误拒绝 http | 单元测试 E1 |
| S3 | API key 文件权限泄露 | 检查 `.env` 文件权限和日志输出 | Unix 权限 `0o600`；日志中不打印 key 内容 | 集成测试 |
| S4 | 重复快速提交配置 | 模拟用户连续点击两次提交 | 第二次提交幂等，不导致文件损坏或配置丢失 | 集成测试 |

## 5.5 浏览器测试规格

本产品基于 ElectroBun（系统 WebView），无传统浏览器兼容性矩阵。测试聚焦于 WebView 内部关键路径。

### 关键路径测试

| # | 路径 | 步骤 | 预期结果 | 等级 |
|---|------|------|---------|------|
| P1 | 向导页首屏加载 | 启动 GUI | 安装向导或聊天界面在 < 1s 内渲染，DevTools Console 无报错 | Quick |
| P2 | 安装确认到进度展示 | 点击"安装"按钮 | 进度条出现，日志面板实时追加文本 | Quick |
| P3 | 配置表单提交 | 填写 provider 和 API key，点击保存 | 成功提示，随后 backend 状态指示灯变绿 | Quick |
| P4 | 错误状态展示 | 模拟断网/install.sh 失败 | 页面展示友好错误信息和"重试"按钮，无崩溃 | Standard |

### 可访问性检查

- [ ] 所有表单输入都有关联的 `<label>`
- [ ] 错误提示可通过键盘焦点访问
- [ ] 颜色对比度满足暗色主题下文字清晰可读
- [ ] 进度条和日志区域有适当的 ARIA 角色（`role="log"`、`role="progressbar"`）

## 5.6 测试代码骨架（必填）

测试文件位于 `tests/` 目录，使用 `bun:test`。

### `tests/installer.test.ts`

```typescript
import { describe, it, expect } from "bun:test";

// TODO: import InstallerController and utilities once implemented
// import { InstallerController } from "../src/bun/installer";
// import { isValidHermesPath, getInstallScriptUrl } from "../src/bun/installer";

describe("InstallerController.detect()", () => {
  it("H1: should return installed=true when hermes-agent exists at default path", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("H2: should return installed=true when HERMES_AGENT_DIR points to valid path", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("H3: should return installed=false when no installation exists", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("B1: should return installed=false when directory exists but gateway/run.py is missing", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("E1: should reject path containing shell injection characters", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });
});

describe("InstallerController.downloadAndRun()", () => {
  it("H1: should return true and stream logs when mock install.sh succeeds", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("B1: should succeed when execution completes just before timeout", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("E1: should throw INSTALL_NETWORK_ERROR when URL returns 404", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("E2: should throw INSTALL_TIMEOUT when script runs too long", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("E3: should throw INSTALL_SCRIPT_EXEC_FAILED when script exits non-zero", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });
});

describe("security - path validation", () => {
  it("E1: should reject path with semicolon", () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("E2: should reject path with backticks", () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("E3: should reject relative path", () => {
    // TODO: implement
    expect(true).toBe(true);
  });
});

describe("security - URL validation", () => {
  it("E1: should throw when HERMES_INSTALL_SCRIPT_URL uses http", () => {
    // TODO: implement
    expect(true).toBe(true);
  });
});
```

### `tests/setupWizard.test.ts`

```typescript
import { describe, it, expect } from "bun:test";

// TODO: import SetupWizardController once implemented
// import { SetupWizardController } from "../src/bun/setupWizard";

describe("SetupWizardController.submit()", () => {
  it("H1: should succeed and write config files for valid input", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("H2: should preserve non-key fields when only api_key is changed", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("B1: should accept api_key of minimum length 1", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("B2: should accept api_key of maximum configured length", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("E1: should fail with CONFIG_VALIDATION_FAILED when api_key is empty", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("E2: should fail with CONFIG_PROVIDER_UNKNOWN for invalid provider", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });

  it("E3: should fail with CONFIG_WRITE_FAILED when directory is not writable", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });
});

describe("SetupWizardController - file permissions", () => {
  it("S3: should create .env with 0o600 permissions on Unix", async () => {
    // TODO: implement
    expect(true).toBe(true);
  });
});
```

## 5.7 测试覆盖目标（必填）

| 指标 | 目标 | 说明 |
|------|------|------|
| 语句覆盖率 | ≥ 80% | 核心控制器和工具函数 |
| 分支覆盖率 | ≥ 75% | 条件判断（如路径验证、状态机分支） |
| 安全测试场景 | 100% 通过 | S1-S4 全部覆盖 |
| 集成测试场景 | 100% 通过 | I1-I4 |
| 端到端手工测试 | P1-P4 全部通过 | Quick 和 Standard 等级 |

---

## ✅ Phase 5 验收标准

- [x] 技术规格中的每个接口/函数都有对应测试用例
- [x] Happy Path + Boundary + Error 三类齐全
- [x] 安全测试场景已从安全架构映射
- [x] 测试代码骨架已编写（可编译，但 TODO 未实现）
- [x] 集成测试至少 3 个完整场景（实际 4 个）
- [x] 覆盖目标已定义

**验收通过后，进入 Phase 6: Implementation →**
