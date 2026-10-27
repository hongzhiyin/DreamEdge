# Windows 核心测试兼容性修复

日期：2026-10-28。环境：Windows x64、Node.js 24.14.0、npm 11.11.0、Electron 44.7.0、.NET SDK 10.0.403。

## 结果与范围

初始核心测试为 396 项，314 通过、82 失败。修复后原有测试全部通过；新增 4 项回归后为 **400/400 通过，0 跳过**。类型检查、构建及 20 项 Electron 界面回归通过。

源码与 Windows x64 应用包均已验证。自动回归使用本地模型协议夹具与临时数据目录，没有调用真实模型服务。修复版已替换 `release/DreamEdge-win32-x64` 并用原数据目录启动；配置及数据库记录前后核对一致。此次未更新公开发布附件、复测流光忆庭两端联调，或执行 macOS、Linux、Windows ARM64 回归；未记录新的产品人工验收。

## 原始 82 项失败分类

按原始日志中首先阻止测试通过的原因分类。同一个用例还可能存在后续清理或等待时间问题，以下数量不重复计数。

| 分类 | 数量 | 原因 |
| --- | ---: | --- |
| Windows 运行兼容性缺陷 | 65 | 原生路径被拒绝、搜索进程禁用 Windows、Pi 编辑预览路径与 Windows 解析结果不一致 |
| Windows 测试夹具问题 | 15 | POSIX 权限位假设、数据库关闭晚于目录删除、测试 PATH/路径分隔符假设、直接执行 shebang 文件 |
| 缺失公共配置示例 | 1 | `config/mcp.example.json` 未纳入仓库，与操作系统无关 |
| 负载敏感的协议测试超时 | 1 | Google 协议夹具在高并发冷启动时触发 5 秒请求期限；受控并发下通过，不据此认定为 Windows 协议实现缺陷 |

原始 Windows 运行缺陷涉及以下用例组：

| 测试文件（`test/` 下） | 原始失败数 |
| --- | ---: |
| `account-file-policy.test.ts` | 7 |
| `device-access.test.ts` | 4 |
| `file-batch-recovery.test.ts` | 4 |
| `file-batch.test.ts` | 8 |
| `file-operation-coverage.test.ts` | 3 |
| `file-operations.test.ts` | 9 |
| `file-scope-policy.test.ts` | 1 |
| `file-scope-read.test.ts` | 3 |
| `mutation-commit.test.ts` | 6 |
| `mutation-loop.test.ts` | 4 |
| `mutation-storage.test.ts` | 3 |
| `read-tool-loop.test.ts` | 5 |
| `scoped-read-tools.test.ts` | 8 |

15 项夹具失败分布：`desktop-config` 1、`device-access` 1、`file-batch-recovery` 1、`file-scope-storage` 1、`mcp-json-settings` 1、`mcp-registry` 4、`pi-file-tools` 1、`reading` 1、`storage-integrity` 2、`storage-recovery` 1、`tool-loop` 1。其余两项位于 `mcp-config` 与 `protocols`。

## 实现

- `scope-paths.ts` 接受本机路径分隔符，同时保留范围、目录身份、链接、硬链接和敏感文件检查。Windows 输入在解析前拒绝上级遍历、设备命名空间、备用数据流、盘符相对路径、保留设备名以及尾随空格/点别名；整机路径解析也执行拼写检查。
- `mutation-preview.ts` 使用本机 `join()` 创建仅供 Pi 注入 operations 使用的虚拟路径，仍不写入真实预览文件。Pi 的写入、编辑与差异算法保持不变。
- `read-worker.ts` 使用受控快照和独立进程运行现有 Pi 工具。Windows 将随包 ripgrep 复制到私有 Pi `bin/rg.exe`，使用宿主生成的固定配置，排除父级和全局忽略规则；不继承宿主的 Node preload、ripgrep 配置或 Pi 工具目录。ASAR 二进制路径支持两类分隔符。
- `pi-read-worker.ts` 使用本机路径范围判断替代硬编码 `/` 前缀。`read-worker-process.ts` 在 Windows 使用固定 System32 路径的 `taskkill /T /F` 并等待完成，随后才清理快照；POSIX 保留进程组终止行为。
- `mutation-policy.ts` 补充 Windows 系统目录、启动目录和 PowerShell profile 的确认规则。`McpJsonSettings` 支持 Windows 环境变量名称大小写及已带 `.exe` 扩展名的程序。
- 测试辅助数据库使用作用域清理，重启产生的服务在所属目录删除前关闭；失败的服务结算不再让测试数据库句柄遗留。Windows 权限断言检查 Node 能表达的读写位，POSIX 仍检查完整 `0600`；这不等同于验证 Windows ACL。
- 阅读器 CLI 允许宿主传入固定的前置参数，UTF-8 测试通过 Node 显式运行脚本，操作白名单和无 shell 启动方式不变。
- 补齐默认禁用的 MCP 示例。补齐示例后暴露出许可证 CRLF/LF 差异，通过 `.gitattributes` 固定许可证为上游 LF 字节，保留逐字节一致性断言。
- 核心测试限制为 4 个并发文件进程。批量文件审批的测试等待预算改为 20 秒，四工具读取夹具的请求预算改为 30 秒；产品运行期限、权限有效期及超时测试自身的期限不变。串行复测也证实多次 Pi 冷启动会超过原 3 秒夹具等待窗口。

## 上游复用与差异

核对的是实际安装版本，不采用主分支接口：

| 组件 | 版本与入口 | 本次处理 |
| --- | --- | --- |
| Pi Coding Agent | 1.1.0；`createReadTool`、`createLsTool`、`createFindTool`、`createGrepTool`、`createWriteTool`、`createEditTool` | 复用工厂、operations、文件队列、匹配与截断逻辑；依赖版本不变 |
| Pi 工具发现 | 1.1.0；`utils/tools-manager.js` 的 `getToolPath`，优先查找私有 `bin/rg.exe` | Windows 使用此既有发现入口；grep 没有公开进程/argv 注入点，因此通过私有原生程序与固定配置适配 |
| Pi 进程终止 | 1.1.0；`utils/shell.js` 的 `killProcessTree` | 此函数未通过包 exports 公开，且不等待退出；DreamEdge 使用相同原生机制，增加可等待的清理边界 |
| DSH 文件后端 | `@deepseek-ai/dsh-fs-local` 0.0.1-rc.1、Cordis 4.0.1-rc.1 | 保留独立 Cordis service、`LocalFileSystem` 路径解析和发布逻辑及 dispose 生命周期；继续使用上游 Windows ACL/替换实现，不重写文件发布算法 |

Pi、DSH 及第三方许可证保留，`package-lock.json` 未修改。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm run build` | 通过 |
| `node --test --test-concurrency=4 dist/test/*.test.js`（`npm test` 的测试阶段） | 400/400，0 失败，0 跳过 |
| Electron 选定回归 | 20/20，0 失败，0 跳过 |
| Windows x64 打包版选定回归 | 21/21，0 失败，0 跳过 |
| `git diff --check` | 通过 |

Electron 回归包含 `chat`、`recovery`、`read-files`、`file-mutations`、`file-batch`、`file-operations`、`mcp-connections`。覆盖真实 Pi 文件读取/搜索、DSH 写入、敏感覆盖审批、批量拒绝与恢复、目录/复制/移动、删除适配、MCP 授权以及历史恢复。

新增回归覆盖 Windows 路径与危险别名、Windows 系统配置确认、PATH 名称/扩展名，以及实际父子孙进程的取消。原有快照超时、环境污染、敏感文件排除、版本失效和取消用例保持执行。

本机日志及逐项原始失败分类位于忽略目录 `test-results/local-windows-2026-10-28/`：`core-tests.log`、`failure-classification.json`、`core-final.log`、`ui-compat-final.log`。该目录包含测试证据，不作为源码分发。

### 复现命令

在仓库根目录的 PowerShell 中执行，前提是已安装锁定的 npm 依赖、Electron 二进制和 .NET 10 SDK。`npm test` 会重新构建核心代码并限制为四个并发测试文件；下面的界面命令只运行本次记录的选定回归，不代表全部界面测试。

```powershell
npm run check
npm test
npm run build:ui

$windowsUiCases = @(
  'chat', 'recovery', 'read-files', 'file-mutations',
  'file-batch', 'file-operations', 'mcp-connections'
) | ForEach-Object { "dist/test/ui/$_.test.js" }
$previousPackageExecutable = $env:DREAMEDGE_PACKAGE_EXECUTABLE
try {
  $env:DREAMEDGE_PACKAGE_EXECUTABLE = $null
  node --test --test-concurrency=1 @windowsUiCases
  if ($LASTEXITCODE -ne 0) { throw 'Source UI regression failed' }

  npm run package:app -- --out release/windows-compat-validation
  if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
  $env:DREAMEDGE_PACKAGE_EXECUTABLE = Join-Path $PWD 'release/windows-compat-validation/DreamEdge-win32-x64/DreamEdge.exe'
  node --test --test-concurrency=1 @windowsUiCases dist/test/ui/windows-shell.test.js
  if ($LASTEXITCODE -ne 0) { throw 'Packaged UI regression failed' }
} finally {
  $env:DREAMEDGE_PACKAGE_EXECUTABLE = $previousPackageExecutable
}
```

逐条检查命令退出码后再继续。暂存目录须与正在运行的包分开；打包命令会覆盖同一输出目录下的应用包。测试夹具自行创建临时数据目录和本地模型服务。整体界面套件另由 `npm run test:ui` / `npm run test:packaged` 运行，其全部用例不计入本次 20/21 项结果。

## Windows 应用包替换验证

- 使用独立暂存目录重新执行 `npm run package:app`，完成 Electron 44.7.0 归档及 .NET 10 Windows x64 自包含启动器发布。私有文件检查通过；包内 185 个构建文件与本次构建输出逐字节一致。
- 打包版执行上述七组 Electron 回归及 `windows-shell`，共 21 项通过。验证真实 ASAR 环境中的 Pi 读取/搜索、DSH 写入、审批、文件操作、MCP、聊天保存恢复及默认配置启动。
- 用户通过应用菜单正常退出旧版本后，完整备份 `%APPDATA%/DreamEdge`，71 个文件逐一核对 SHA-256；四个 SQLite 数据库完整性检查通过。备份保存在同一用户的 `%APPDATA%/DreamEdge-backups/` 下。
- 旧包保留为 `release/DreamEdge-win32-x64-before-fix-20261028-015926`，修复版移至原路径。启动后主窗口正常响应；两份配置文件（含凭据）的校验值以及四个数据库的全部表记录与替换前一致。
- 应用归档 SHA-256：`d7b96f1b8e539763f4356a12eb4feebd33df21202118cefb6c53a005bd0822dc`。
- 本机证据：`repackage.log`、`packaged-compat-final.log`、`package-verification.json`、`backup-summary.json`、`deployment.json`、`launch-verification.json`、`profile-before.json`、`profile-after.json`，均位于上述忽略的测试结果目录；不保存或输出凭据正文。

## 平台依据

- [Microsoft：Windows 文件、路径和命名空间规则](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)：分隔符、设备名、备用流、盘符相对路径及尾随字符处理。
- [Node.js：文件系统的 Windows 权限限制](https://nodejs.org/download/release/v18.20.8/docs/api/fs.html)：`mode`/`chmod` 无法表达 POSIX 的组和其他用户权限区分。
- [Node.js：子进程和 Windows 环境变量](https://nodejs.org/download/release/v14.17.3/docs/api/child_process.html)：Windows 环境变量名称不区分大小写，进程组处理与 POSIX 不同。
