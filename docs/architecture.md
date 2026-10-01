# 第一阶段架构

目前采用 Electron + React + TypeScript + Vite，数据库使用 Electron 内置的 `node:sqlite`。依赖版本固定在 `package-lock.json`，开发环境要求 Node.js 22.13 或更新版本。第一阶段使用随应用提供的手工样例，不接入模型。

## 目录与加载

| 目录 | 职责 |
| --- | --- |
| `desktop/` | 窗口、资源加载、IPC 校验和 SQLite 存储 |
| `shell/` | 工具导航、展示区域与 AI 面板入口 |
| `shared/` | 公共数据类型与通信协议 |
| `tool-sdk/` | 工具可调用的存储客户端 |
| `tools/reading-log/` | 独立阅读工具：manifest、界面、业务校验 |
| `scripts/` | 受控构建脚本 |
| `tests/` | 存储与业务测试、真实 Electron 验收 |

宿主加载 `ideadock://shell/index.html`，工具在不同来源的 sandbox iframe 中加载 `ideadock://reading-log/index.html`。每个工具有独立 Vite 构建产物。仅修改阅读工具时执行 `npm run typecheck && npm run build:tool -- reading-log`，然后点击宿主顶部的重新加载按钮即可使用新产物。

当前 catalog 明确登记一个随应用提供的工具。工具安装、动态发现和候选版本切换尚未实现。新增工具时需要同步登记 catalog、构建目标和加载策略；第四阶段再实现模板创建与安装流程。

工具页面不开启 Node.js，没有 Electron IPC 或本地文件接口。宿主和工具遵循 Electron 的 [安全建议](https://www.electronjs.org/docs/latest/tutorial/security)：context isolation、renderer sandbox、发送方校验、限制导航及窗口创建、CSP、本地自定义协议。

这是第一阶段的受控工具边界。开放 AI 生成代码、依赖安装或任意脚本之前，还需评估构建执行隔离、网络能力和资源配额。

## 公共存储接口

工具只导入 `tool-sdk/storage.ts`，无需传入工具 ID：

```ts
const records = await storage.list('entries');
await storage.put('entries', recordId, { content: '阅读内容', minutes: 30 });
await storage.remove('entries', recordId);
```

`list` 返回 `{ id, value }[]`。`put` 按 ID 插入或更新有效 JSON；`remove` 删除对应记录。集合名称、ID 限定为 1–80 位字母、数字、下划线或连字符；单条值最大 64 KB，JSON 嵌套最大 20 层。不接受 SQL、文件路径或任意 IPC channel。

工具通过 `postMessage` 发送请求。宿主核对 iframe 的窗口引用与来源，再绑定 catalog 中的工具 ID，忽略页面自行声明的工具 ID。主进程只接受宿主主 frame 发出的固定 IPC，核对工具登记与 storage 能力，并校验请求参数。

数据库以 `(tool_id, collection, id)` 为主键。每次写入直接提交 SQLite；界面收到成功回应后才显示保存成功。请求超时会提醒重新加载核对记录，避免把未知结果展示为成功。

## 数据位置与恢复

数据保存在 Electron `app.getPath('userData')/data/ideadock.sqlite`，与源码、构建产物分开。macOS 默认路径为 `~/Library/Application Support/IdeaDock/data/ideadock.sqlite`。首次启动自动创建，关闭后重开仍使用该数据库。

开发和测试可通过 `IDEADOCK_DATA_DIR` 指定绝对的数据目录。端到端测试总是使用临时目录，不写入个人记录。数据库采用 WAL 与 FULL synchronous；备份时请先关闭应用，再复制数据目录，避免遗漏 WAL 中的数据。

阅读记录使用 `entries` 集合，保存 `id`、`date`（本地日历日期）、`content`、`minutes`、`createdAt`。有效日期、非空内容、1–1440 整数分钟在业务层校验。读取到不兼容的数据会报错、保留原始数据并禁用新增，防止静默忽略旧记录。

当前 SQLite schema 为版本 1。候选代码版本、数据迁移和自动备份留待第二、三阶段；重新构建不会清除数据库。

## AI 面板

按钮与 `⌘K`（Windows/Linux 为 `Ctrl+K`）打开面板，`Esc` 关闭。面板展示当前工具和阶段状态。输入与发送按钮禁用，明确说明尚未接入模型。没有密钥、模型调用、假响应或代码修改行为。

第二阶段从这些接口边界继续：先确定模型协议和凭据存储，再实现当前工具上下文、候选副本、受控文件操作、构建日志、预览和保存。业务数据默认不发送给模型。
