# DreamEdge

Electron + React 桌面文字对话工具，接入 Pi Agent Core / Pi AI 1.1.0，使用 SQLite 保存历史。开发环境为 Node.js 22.19 及以上。

## 启动桌面窗口

```sh
npm ci --ignore-scripts
npm start
```

窗口使用 `config/deepseek.example.json` 中的模型连接及 `config/credentials.local.json` 中的凭据。默认思考强度为高，可以在输入区为当前提问选择支持的强度。模型配置界面不属于当前功能。

左侧创建和切换会话，输入区支持 Enter 发送、Shift + Enter 换行。回复逐步显示，支持停止、失败重试和保存重试；思考内容可以展开查看。Markdown 不执行 HTML 或加载远端图片。

全应用采用极光玻璃浅色主题，覆盖对话、工具结果、文件权限、MCP 设置与网页配对。嵌入模式移除重复标题栏并适配 300–440px 宽度；已有操作与权限流程保留。主题实现和验证记录见 [极光玻璃主题](docs/implementation/aurora-theme.json)，2026-10-18 已更新原位置应用包，现有配置和聊天记录经完整性核对保持不变。

关闭按钮隐藏窗口，生成任务继续；点击 Dock 图标或“窗口 → 显示聊天窗口”恢复。退出菜单取消运行、等待结算并保存。输入草稿和阅读位置保留在当前窗口会话中，包括页面重载；应用重启后从 SQLite 恢复已保存的对话。

| 可选环境变量 | 用途 |
| --- | --- |
| `DREAMEDGE_CONFIG_FILE` | 模型连接配置文件 |
| `DREAMEDGE_CREDENTIALS_FILE` | 本机凭据文件 |
| `DREAMEDGE_DATA_DIR` | 绝对路径的数据目录；默认使用 Electron 的 userData 目录 |

数据库为数据目录下的 `sessions.sqlite`。环境变量用于宿主启动配置，不暴露给聊天页面。

## 本机应用包

```sh
npm run package:app
npm run test:packaged
npm run start:packaged
```

当前 macOS arm64 产物为 `release/DreamEdge-darwin-arm64/DreamEdge.app`。`start:packaged` 沿用仓库中的连接和本机凭据文件，密钥不复制进应用包。独立打开应用时，连接和空凭据模板位于 userData 下的 `connection.local.json`、`credentials.local.json`；现有文件不会被覆盖。

打包只包含编译后的运行代码、页面、生产依赖和公开配置模板。开发文件、本地配置、聊天数据和实际密钥经过排除与归档检查。本机运行和恢复已验证，Developer ID 签名及公证未执行。

## 模型连接检查

1. 安装依赖：`npm ci --ignore-scripts`。
2. 在 `config/credentials.local.json` 的 `deepseek` 字段中填写 API Key。
3. 执行 `npm run model:check`。

```json
{
  "deepseek": "填写本机 DeepSeek API Key"
}
```

本地凭据文件已加入 Git 忽略规则。仓库中的 `credentials.example.json` 只保存空模板。

默认模型连接由 `config/deepseek.example.json` 定义：

| 字段 | 值或含义 |
| --- | --- |
| 地址 | `https://api.deepseek.com` |
| 模型 | `deepseek-flash` |
| 思考强度 | `high` |
| 思考协议 | `thinking.type=enabled`，`reasoning_effort=high` |
| 凭据引用 | `file:deepseek`，读取本地凭据文件中的对应字段 |
| 输出上限 | `maxOutputTokens`，包含服务统计的输出内容；到达上限返回 `OUTPUT_LIMIT` |
| 超时 | `timeoutMs`，默认配置为 120 秒 |

地址、模型名称和思考参数依据 [DeepSeek 官方接口文档](https://api-docs.deepseek.com/)。

```sh
npm run model:check -- --prompt "用一句话介绍自己"
npm run model:check -- --cancel-after-ms 1000
npm run model:check -- --config config/deepseek.example.json --credentials config/credentials.local.json
```

CLI 显示正文流式内容，结束后输出状态、结束原因、思考强度和可用的 token 计数。读取失败或空密钥返回明确错误，不发起模型请求。

## 模块与接口

| 模块 | 职责 |
| --- | --- |
| `src/model/config.ts` | 校验协议、地址、模型限制及思考能力声明 |
| `src/model/connection.ts` | 建立 Pi Provider 和模型，解析凭据并映射请求参数 |
| `src/model/credentials.ts` | 宿主侧本地文件或环境变量凭据解析 |
| `src/runtime/pi-runtime.ts` | 运行、流式事件、取消和结算 |
| `src/runtime/outcome.ts` | 结束状态映射与错误脱敏 |

`PiRuntime.start(request, observer)` 返回 `{ cancel, done }`。`done` 等待模型运行及事件处理结束，包括最终 `settled` 事件。

- 输入是已包含最后一次提问的原生消息上下文，运行时使用 `Agent.continue()`，不重复追加提问。
- 事件携带 `sessionId`、`runId` 和递增 `sequence`；正文和思考内容使用不同的 delta 通道。
- 正常结束映射为 `completed`；用户取消映射为 `cancelled`；长度上限、请求错误、超时和事件处理失败映射为 `failed`。
- 未声明思考能力的连接使用 `off` 并返回提示；显式请求不支持的强度时返回 `UNSUPPORTED_THINKING`。
- 原生回复字段保留用于持久化和续聊，失败及取消回复不得作为完整历史输入。
- 工具集合为空，意外工具调用中止运行；适配层没有会话数据库或界面状态。

模型能力由连接配置声明，不自动推断远端 API 支持的全部选项。四种协议为 `openai-completions`、`openai-responses`、`anthropic-messages` 和 `google-generative-ai`，通过 Pi 的原生适配器处理。

凭据也可引用 `env:DEEPSEEK_API_KEY`。其他凭据存储可实现 `CredentialResolver` 注入宿主。密钥不作为连接配置字段、运行事件或日志输出。自定义连接没有定价数据，原生消息中的 SDK 成本字段不作为账单依据。

## 工具与运行契约

工具调用六个开发阶段与自动验收已完成：契约、持久化与上下文、Pi 执行循环、授权与运行控制、聊天界面，以及真实 DeepSeek 和 macOS arm64 生产包验证。2026-10-14，用户已人工确认时间与加法工具可正常调用；其他人工验收场景尚未反馈。

`src/tools/*` 定义工具元数据、类型化处理函数、执行上下文、调用状态和授权记录。`toolSnapshot` 与 `toolSetSnapshot` 返回冻结的定义快照，排除处理函数和宿主字段；写操作必须声明 `approval: 'always'`。`validateToolArguments` 校验参数且不执行工具，`argumentsDigest` 生成不受对象键顺序影响的 SHA-256 摘要。

参数 Schema 支持对象、数组、字符串、数字、整数、布尔值、null、enum、const、anyOf、oneOf 及常用约束，接受 draft-07 声明和 default 注解。保留 additionalProperties 的原有语义：false 拒绝额外字段，true 或省略允许额外字段；不注入默认值。外部引用、JavaScript 类型与未支持的关键字仍被拒绝。TypeBox 1.3.27 的内部类型标记在序列化快照时剥离，不进入模型定义。

连接配置可声明 `toolCalling: { supported: true, supportedThinkingLevels: ['off', 'high'] }`，支持的思考强度必须属于连接本身的能力。省略该字段不会启用工具；没有启用工具时旧配置继续有效。DeepSeek 模板已启用工具，支持 `off`、`low` 与 `high`；宿主提供 `get_current_time` 和 `add_numbers`。原模型地址、思考默认值、输出上限与本地密钥保持不变。

`src/runtime/tool-contracts.ts` 定义多轮消息、扩展运行记录、工具事件与授权命令；`assertRunTranscript` 检查消息顺序、运行归属和调用/结果配对，未闭合调用仅允许用于明确指定的检查点。`RunRecord` 已接入工具快照、消息、调用和授权记录，SQLite v2 保存原生消息与结果。

状态校验和授权目标匹配是纯契约函数，不执行动作、不授予权限。`ToolApprovals` 消费宿主确认命令，持久化层提供可等待的提交屏障。

`ToolRegistry` 固定工具版本、参数定义与处理函数。`PiRuntime` 的第三个参数接受 `{ registry, maxModelTurns, maxToolCalls, approvalTtlMs }`；默认限制为 16 个模型轮次、64 次工具调用和 120 秒授权有效期，思考强度继续使用连接配置。`ConversationDependencies.tools` 声明启用集合，宿主通过 `RuntimeRequest.checkpoint` 提交有序消息和调用状态。

循环直接执行 `read` / `approval: 'never'` 工具；需要确认的工具必须接入持久化授权，写操作只能声明 `approval: 'always'`。Pi 串行执行工具，授权与执行意图落盘后才调用函数，结果落盘后才请求下一轮模型。工具声明随原生上下文持久化，首次请求和重试均携带正确的工具集合。参数、未知工具、超时与处理函数失败形成受控错误结果，不回传内部异常或凭据。

取消传到读取函数，后续调用与模型请求停止，晚到结果不会修改已结算记录。读取函数应响应 AbortSignal；循环提供超时与结果隔离，不终止任意宿主代码。相同调用复用进行中的任务或已完成结果，参数冲突拒绝；模型重复使用已记录标识时中止该运行。重试只使用当前宿主仍启用且版本一致的工具，不因历史定义重新获得已禁用工具。

`service.decideApproval(command)` 接收 `approve` / `reject`。命令绑定 `sessionId`、`runId`、`turnId`、`toolCallId`、`approvalId`、`toolName`、`toolVersion` 和 `argsDigest`，只放行一次调用。重复确认不重复执行；拒绝、过期、停止与旧运行的确认不能放行动作。聊天卡片展示操作对象、影响和参数，提供“允许这一次”和“拒绝”，由限定的 `approval` 命令交给宿主校验。

写工具启动后取消、超时或抛错，结果标记为 `outcome_unknown` 并停止后续动作；取消不保证撤销外部变更。默认 `retry(sessionId, runId, 'continue')` 复用结果继续回答，不启用工具；`'read_tools'` 允许模型重新发起无需授权的读取调用，保留之前的结果，排除写工具。`retrySave` 仅保存并释放原保存边界。同一提问存在未知写结果时禁止运行重试，核对实际结果后通过新提问发起新操作并重新授权。

## 账户权限访问与执行前检查

当前桌面入口使用启动账户的文件权限，无需选择目录或开启整机开关。根目录由宿主解析，相对路径与 `~/` 基于用户主目录；系统拒绝不会自动提权。旧 `file-access.local.json` 不再控制当前桌面入口，历史目录授权仍保留作来源记录。

Pi 1.1.0 的文件工厂、编辑算法和同文件执行队列继续复用。`Agent.beforeToolCall` 通过注册表中的宿主 `inspectExecution` 检查真实预览，返回 `allow`、`ask` 或 `deny`；检查异常、无效返回、超时或取消时阻止执行。检查最多等待 5 秒，工具自身期限更短时使用更短期限。

- 普通新建和局部编辑自动通过；自动决定作为 `approval.inspection.decision = allow` 保存，不记为用户确认。
- 整体覆盖、清空、系统或启动配置修改需要在聊天卡片确认。编辑后的字节数不足原文件一半、删除或替换至少 50 行，或至少 5 行且占原文件一半时，也需要确认。
- 自动与人工许可都绑定固定预览和参数摘要，保存成功后才执行。提交前继续核对真实路径、父目录、版本、内容摘要及许可期限。
- 已知凭据排除、模型历史目的地检查、搜索预算与文件大小限制继续生效。工具 Hook 不构成任意脚本或原生插件的系统隔离。

当前文件工具包括 read、ls、find、grep、write、edit、delete、move、copy、mkdir。Shell 未开放；同一轮连续的多文件变更支持下节的批量确认，单个变更保留单次确认。新策略的变更工具版本为 `pi-1.1.0/account-mutation-1`，旧版本记录仍可读取。此次验证针对源码和隔离 Electron 窗口，未更新生产运行包或执行真实 DeepSeek 联调。

## 会话内批量计划、停止与恢复

Pi 1.1.0 的原生多工具回复和串行执行循环保持不变。宿主在首个变更调用前准备同一轮连续的账户文件变更，生成明确的目标、参数摘要、文件版本、差异和批次摘要。最多 64 项，累计参数与累计差异分别不超过 512 KiB；规范路径重复时拒绝整批。同一目标的依赖修改需要分开准备。

常规操作组成的批次自动执行；含敏感操作时只显示一个“允许本批操作”。决定绑定会话、运行及完整批次摘要，再派生各项固定计划许可，不覆盖后续未知调用。所有许可原子保存后，未启动成员进入 `authorized`；实际执行前单独保存 `running`，继续复用 Pi 文件队列和 DSH 版本条件发布。每项独立提交，批次不是跨文件事务，失败不自动回滚已完成项。

停止或成员失败会阻止剩余项。取消结算先补齐未完成工具的结果，再追加 Pi 的终止消息，避免保存无法回放的消息顺序。重启区分已完成、未启动和执行结果未知；已完成项不重做，未知结果禁止自动恢复。

聊天中的“准备恢复未完成项”根据宿主记录合并历次恢复结果，启动新的受限运行。模型先读取当前版本并重新提出剩余操作，宿主只接受原计划中未完成项的原参数及真实目标，拒绝额外写入；重新预览和确认后才执行。普通对话里的“继续”不直接授予批次许可。

SQLite schema v6 增加批次授权语义、`authorized` 状态与恢复来源记录。v5 原有账户授权和会话保留；旧程序不能打开 v6。实现入口：`file-batches.ts`、`tool-approvals.ts`、`batch-recovery.ts`、`batch-validation.ts`。DSH 固定提交的 `allowed-once`、取消和审计语义用于适配设计，未把 Harness 审批插件直接加载到 Pi。

验证记录：`docs/validation/file-batch-2026-10-16.json`。当前覆盖已注册的文本和结构变更工具，批次成员必须已由模型明确提出；不能预先批准尚未给出目标和内容的未来操作。真实模型联调和生产包验收仍在后续阶段。

## 删除、移动、复制与目录创建

`fileOperationTools` 复用 Pi 执行循环、检查与批量审批，DSH 负责现有路径规范化。已安装 Pi 1.1.0 与 DSH fs-local 0.0.1-rc.1 没有公开的废纸篓、删除、复制和移动工具入口；宿主用 Electron `shell.trashItem` 与 Node 标准文件操作补齐该缺口，没有以 Shell 命令替代检查。

- `delete` 默认进入系统废纸篓；`permanent: true` 表示永久删除，两种模式都要求确认。废纸篓失败不回退到永久删除。
- `copy`／`move` 支持普通文件和目录，目标必须不存在，父目录必须已存在。目录内容使用标准 `fs.cp`，文件使用排他复制。移动先复制并核对，再移除原对象；不是原子重命名。
- `mkdir` 创建单层目录，拒绝覆盖。创建父目录和后续依赖操作分轮提出。
- 目录操作完整检查最多 1024 项、32 层、1 GiB，哈希流式计算。符号链接、受保护子文件和不完整扫描使操作失败，不静默跳过。永久删除只移除固定清单中的文件，目录使用 `rmdir`，新增内容不会被递归兜底删除。
- 预览与执行前复核内容、身份和父目录；源与目标都纳入批次冲突与恢复约束。Pi 共用队列串行化托管变更，防止本应用中父目录操作与子文件写入交错。外部进程竞争不等于内核隔离，部分执行失败记录结果未知，不自动回滚或重放。

所有生产工具注册后封闭目录；未注册的 Shell、PowerShell、MCP、代码执行工具不能调用。应用运行文件及 userData 只允许宿主自身修改，模型文件工具不能更改其代码、会话数据或权限配置。单次调用、批次、恢复及直接工具调用都保留执行检查与批准引用。

结构操作版本为 `dreamedge/file-operations-1`，SQLite schema v7 校验结构预览和双路径访问绑定，并兼容此前批次记录。验证摘要：`docs/validation/file-operations-2026-10-16.json`。废纸篓自动化使用隔离替身；实际系统废纸篓、真实模型及生产包验收属于后续阶段。

## Pi 文件工具适配

`src/files/pi-file-tools.ts` 通过公开 SDK 工厂适配 `read`、`ls`、`find`、`grep`、`write`、`edit`，保留 Pi 的读取、搜索、截断和编辑算法。Coding Agent 与配套 Pi 依赖固定为 1.1.0；`overrides` 防止上游范围依赖混入不兼容版本。SDK 延迟导入，普通聊天启动不加载 Coding Agent。

`loadPiFileTools(host)` 返回冻结的工具定义。宿主必须提供 `authorize(name, args, context)` 与 `prepare(name, args, context)`；后者返回本次调用绑定的原生 Pi 工具、可选路径转换参数和清理函数。适配层校验工具名与 Schema，宿主只能转换 `path`，不能改写调用内容。执行沿用现有工具生命周期，转交调用标识、取消信号与可等待的更新；写入和编辑声明一次性授权。

六个文件工具已接入；桌面通过账户策略建立访问绑定，写入依照上节的执行前检查。兼容的指定目录宿主仍可使用逐次人工确认。写入通过下述预览及 DSH 原子后端执行。Pi 的 `cwd` 不是目录权限边界，默认 `write` 也不具备原子提交语义。

2026-10-15 验证：新增适配测试 17 项、核心回归 149 项、界面回归 32 项通过。独立验证包从自己的 `app.asar` 导入固定版本 SDK 并执行真实 Pi 读取。证据见 `docs/validation/pi-file-adapter-2026-10-15.json` 与 `docs/validation/pi-file-package-2026-10-15.json`。

```sh
npm run package:app -- --out release/pi-file-adapter-validation
node dist/scripts/pi-file-package-check.js
```

以上验证使用独立应用包、临时数据目录和空凭据，不请求模型。

## 目录授权与持久化（兼容接口）

`ConversationService.fileScopes` 管理会话目录权限。`chooseDirectory(sessionId, options)` 通过注入的可信 `DirectoryPicker` 获取路径，选项包含 `mode: 'read' | 'read-write'`、`remember`、可选相对路径排除前缀和 `expiresAt`。指定目录宿主可提供原生选择器；当前桌面入口不再提供该选择器。页面不能提交授权路径、目录身份或模型服务。`snapshot` 返回副本，`revoke` 撤销目录并提升策略版本。

`bind(source, grantId, path, mode)` 绑定当前运行、目录身份、策略版本和模型目的地；`verify(binding)` 在实际 I/O 时再次检查。权限过期、撤销、策略或模型变化、保存失败、越界、链接与硬链接均拒绝。`readScopedFile` 从检查过的 descriptor 有界读取，保存 SHA-256、大小、时间戳及来源，不把正文写入权限记录。路径检查不是针对恶意本机进程的内核沙箱；Pi 工具通过下述私有快照访问受控内容。

SQLite v3 引入目录范围与读取观察，v4 保存预览与批准引用，schema v5 标记整机授权来源，v6 增加批次授权与恢复语义，v7 增加结构变更预览，v8 增加 MCP 工具来源快照校验，当前 v9 增加 MCP 资源回执和历史来源校验。数据库迁移保留旧聊天和工具记录；当前桌面在启动及创建会话时由宿主账户策略建立访问绑定。临时权限重启撤销；记住的目录仍检查身份、有效期与模型目的地。读取观察只是历史证据，不恢复一次性写授权；`retrySave` 只重试保存。旧程序不能打开高于自身支持版本的数据库。

本阶段核对了 [DSH 目录策略](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/fs/fs-sandbox/README.md)与[读取观察策略](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/fs/fs-observation-policy/README.md)。沿用其策略与 I/O 分层，补充 Pi 缺少的会话授权及持久化；没有直接加载依赖 Harness 生命周期的插件。

验证：新增核心测试 20 项、全部核心回归 169 项、界面回归 33 项、独立应用包授权恢复场景 1 项通过。证据位于 `docs/validation/file-scopes-2026-10-15.json`；验证包为 `release/file-scope-validation/DreamEdge-darwin-arm64/DreamEdge.app`，未覆盖日常使用包。

## 读取、列表与搜索

`scopedReadTools(fileScopes, limits?, cacheRoot?, accessMode?)` 复用 Pi 的 `read`、`ls`、`find`、`grep`，版本为 `pi-1.1.0/scoped-read-1`。连接支持工具调用且存在宿主访问绑定时，四个工具进入请求。当前桌面自动提供账户绑定；标题栏“文件范围”显示账户模式、模型目的地和操作规则。

宿主检查真实文件与目录身份，建立私有快照后交给 Pi；operations 只访问快照。读取窗口、图片输出和截断沿用 Pi；文件发现采用打包 rg 与 Node `matchesGlob`，正则搜索采用 Pi grep。`@vscode/ripgrep` 固定为 1.18.0，并解包其平台二进制以便独立 `.app` 执行。搜索关闭宿主配置、父目录和全局忽略配置；快照内的忽略规则有效，目录权限排除不能被 glob 覆盖。

默认预算为每文件 4 MiB、总输入 32 MiB、扫描 1024 项、深度 32、工具时限 20 秒。超限失败；Pi 输出截断和结果上限继续显示。工具进程不继承宿主环境或模型凭据，取消会终止拥有的进程组；注册表的宿主规则 `awaitCancellation` 等待资源清理后结算。生产缓存位于 `userData/file-snapshots`，调用完成清理，重启清理自身遗留缓存；操作系统文件 I/O 采用协作取消。

结果保存原路径、目录授权、策略版本、模型目的地及读取版本，部分窗口和截断结果不标记为完整视图。存储检查来源与原生结果及目录授权的一致性。新提问和每次模型请求前检查历史文件内容的目的地，包括据此产生的历史回答；模型服务变化时阻止发送，需恢复原连接或新建空对话。撤销阻止新读取，历史仍可在原服务中续聊。

验证：本阶段新增核心测试 16 项，全部核心回归 185 项、界面回归 34 项、独立应用包场景 2 项通过。证据为 `docs/validation/read-search-2026-10-15.json`，验证包为 `release/read-search-validation/DreamEdge-darwin-arm64/DreamEdge.app`。未使用真实模型或用户文件进行验收。

## 变更预览与一次性授权

`scopedMutationTools(fileScopes)` 复用 Pi 的 `write`／`edit` 虚拟 operations 生成固定计划。预览不修改目标文件，包含实际路径、新建／覆盖／编辑类型、原版本、目录策略、参数与生成内容摘要及完整差异。已有目标需先成功读取当前版本，覆盖需完整视图；UTF-8 内容最多 4 MiB、差异最多 128 KiB，父目录必须存在。

沿用既有授权与持久化屏障，批准命令增加 `planDigest` 和 `policyVersion`，只允许执行对应计划一次。卡片默认展开差异，辅助参数收起；拒绝、过期、缺少或篡改计划引用不会修改文件。计划内容仅在运行内存中保留，SQLite 保存元数据和差异，重启不恢复暂存内容或重放写操作。

提交复用 `@deepseek-ai/dsh-fs-local` **0.0.1-rc.1** 的公开 `LocalFileSystem.writeText`，使用 `createIfAbsent`／`replaceIfVersion`。Pi 的同文件队列包住整个提交与清理，DSH 独立 Cordis 文件服务在结算后释放；没有另一套 Agent。通过固定版本的 `internals.inspectTemp` 扩展点在原子发布前重检范围、父目录、版本、内容摘要和授权有效期。版本检查与原子替换不是通用的跨进程 compare-and-swap。

DSH 的自动 peer 安装会引入未发布的 `dsh-type-meta`；`.npmrc` 使用 `legacy-peer-deps`，实际运行依赖已直接列出并固定：`dsh-fs-local`、`dsh-fs`、`dsh-llm`、`dsh-timeout` 0.0.1-rc.1 与 `cordis` 4.0.1-rc.1。只通过已发布入口接入，许可证随依赖保留。

确定无目标文件效果的失败使用 `NoFileEffectError`，提交结果无法确认时记录 `outcome_unknown` 并阻止自动重试。取消等待后台 I/O 与清理，不提前释放同文件占用；提交已经成功则保留已知成功凭据。源码中的 `effectState` 是宿主凭据，传输副本不包含该字段。

验证：变更预览阶段新增核心测试 17 项，全部核心回归 202 项、界面回归 35 项、独立包场景 3 项通过。证据为 `docs/validation/mutation-approval-2026-10-15.json`，验证包为 `release/mutation-validation/DreamEdge-darwin-arm64/DreamEdge.app`；未使用真实模型或用户文件验收。

## 文件范围与结果界面（原指定目录版本）

聊天标题栏的“文件范围”展示当前会话与模型服务，使用系统目录选择器创建授权。默认只读、不跨应用重启保留；可选择读写、1 小时或 24 小时期限、重启保留及相对路径排除前缀。修改已有权限通过撤销后重新选择目录完成。读写授权不替代每次变更确认。授权中、未保存、已撤销、已过期与模型服务变化分别显示；保存失败时暂停新增目录，保留撤销与保存重试入口。

`FileScopeService.overview(sessionId)` 返回当前目的地、策略版本与目录授权摘要，省略文件身份和读取观察历史。`ChatView.fileScope` 与聊天快照共同发布，沿用事件序列与恢复机制，避免单独轮询和会话切换时的过期更新。原生选择请求始终绑定发起会话；取消选择不增加授权。撤销阻止后续访问，已进入聊天的文件内容仍保留在历史中。

文件卡片直接展示路径、请求读取窗口、输入字节数、扫描项和排除数。Pi 原生结果、图片与截断／结果上限信息保留；部分读取明确标注。界面默认显示长文本的前 20,000 字符，可以展开完整工具返回内容，界面裁剪不修改模型上下文。变更仍展示完整差异和逐次确认，回执区分已发布与后续版本核对结果，未知结果保留人工核对提示。参数与原始详情作为折叠信息保留。

验证：文件界面阶段核心回归 206 / 206、界面回归 43 / 43、独立应用包新增场景 8 / 8，类型检查、构建及打包私有文件检查通过。记录：`docs/validation/file-ui-2026-10-15.json`；独立验证包：`release/file-ui-validation/DreamEdge-darwin-arm64/DreamEdge.app`。最终验收记录见下节。

## 文件真实联调与应用包验收（2026-10-15 历史版本）

`npm run files:integration` 通过 Playwright 驱动指定的生产应用包，沿用本机 DeepSeek 配置和凭据，高强度思考。使用临时文件目录与独立 SQLite，实际读取、搜索、新建和编辑文件；检查确认前无写入、批准后内容一致、拒绝、停止、撤销、重载及重启恢复。目录选择使用原生选择器测试替身，人工选择器交互仍需人工验收。

```sh
npm run package:app -- --out release/file-release-validation
npm run test:packaged -- --app-root release/file-release-validation
npm run files:integration
npm run files:integration -- --cancel-only
```

`files:integration` 支持 `--executable`、`--config`、`--credentials` 和 `--report`；取消专项使用 `--cancel-only`。该命令会产生真实 API 用量，报告仅保存状态、检查项、工具名和请求结构摘要，不保存密钥或完整对话正文。完整场景报告为 `docs/validation/file-deepseek-2026-10-15.json`，取消专项为 `file-cancel-2026-10-15.json`。

文件操作应用包位于 `release/file-release-validation/DreamEdge-darwin-arm64/DreamEdge.app`。人工试用可执行 `npm run start:packaged -- --app-root release/file-release-validation`，沿用原有 DeepSeek 配置。该启动命令默认使用日常 userData；联调脚本始终使用临时目录，结束后清理测试进程与数据。自动结果不作为用户人工验收记录。

2026-10-15 自动验证：核心回归 206 / 206、最终生产包界面回归 35 / 35、真实 DeepSeek 文件场景 10 / 10与取消专项 1 / 1通过；共 20 次真实请求，高强度思考及原生工具上下文正常。生产包回归排除开发计数器宿主的 8 项测试。汇总为 `docs/validation/file-release-2026-10-15.json`。类型、构建与打包检查通过；文件操作人工验收未记录。

Pi npm 包未附许可证正文，`licenses/Pi-1.1.0-LICENSE.txt` 保存官方固定标签原文并随应用分发，打包检查逐字节校验；DSH 与 Cordis 包的许可证保留。补充许可证后重打包，92 个编译应用文件与已验证版本的入口及 SHA-256 一致，记录为 `docs/validation/file-package-license-2026-10-15.json`。

## 整机文件访问模式（2026-10-15 历史版本）

“文件范围”中的“开启整机访问”经一次原生确认后，为当前模型服务的所有对话启用整机模式，无需逐个选择目录。普通 `read`／`ls`／`find`／`grep` 可访问系统账户权限允许的普通文件；`write`／`edit` 始终保留固定预览和一次性确认。删除和 shell 工具未开放。关闭模式会停止正在运行的对话并恢复指定目录授权。

偏好保存在 userData 的 `file-access.local.json`，绑定连接、协议、地址和模型；目的地变化不会继承授权。根目录与相对路径基准由宿主确定，相对路径和 `~/` 基于用户主目录。DSH `LocalFileSystem.resolve` 将普通别名规范化为真实目标，实际读取和发布仍通过原有身份、策略、保存与取消检查；Pi 文件工具及编辑算法保持不变。搜索仍有输入和输出上限，不会自动读取或扫描整个设备。

默认排除 `.git`、`.ssh`、`.codex`、`.env` 及其变体、`credentials*` 和 `file-access.local.json`；整机模式额外排除 `.aws`、`.azure`、`.kube`、`.gnupg`、`Keychains`、`.npmrc`、`.pypirc`。显示路径和解析后的目标都检查排除项。SQLite v5 记录整机授权来源，旧数据迁移不创建整机授权；模型历史的目的地检查仍保留。文件工具不能修改自身权限配置。

当前验证包为 `release/device-access-validation/DreamEdge-darwin-arm64/DreamEdge.app`；运行命令：`npm run start:packaged -- --app-root release/device-access-validation`。验证记录位于 `docs/validation/device-access-2026-10-15.json`。指定目录文件访问已获人工反馈；整机模式与写入控制人工验收未记录。

验证：核心 214 / 214、界面 47 / 47、生产包界面 39 / 39，类型、构建、许可证及私有文件检查通过。聊天保存失败仍可关闭整机权限，保存恢复不会重新开启；关闭后历史内容仍保留。当前运行窗口已切换至新包，既有聊天保留并迁移到 v5。

## 会话管理

`ConversationService` 通过依赖注入获取模型连接并创建运行时。会话、用户消息和回复尝试分别保存为 `SessionRecord`、`MessageRecord` 和 `RunRecord`；助手回复由 Run 保存，重试不重复创建用户消息。

```ts
import { ConversationService, PiRuntime } from 'dreamedge';

// config 为解析后的模型连接，credentials 为宿主的凭据解析器。
const service = new ConversationService({
  connection: () => config,
  runtime: snapshot => new PiRuntime(snapshot, credentials),
});
const session = service.createSession({ connectionId: config.id });
const first = service.send({ sessionId: session.sessionId,
  clientMessageId: 'question-1', text: '记住暗号：琥珀。' });
await first.done;
const second = service.send({ sessionId: session.sessionId,
  clientMessageId: 'question-2', text: '暗号是什么？' });
await second.done;
```

| 接口 | 行为 |
| --- | --- |
| `createSession` / `listSessions` | 创建、列出独立会话；支持会话级系统提示 |
| `send` | 保存提问并开始运行；同一会话、同一 `clientMessageId` 的相同命令返回原句柄，内容或参数冲突时报错 |
| `stop` / `handle.cancel` | 发出取消请求；运行结算前会话仍被占用。界面停止命令绑定目标 `runId`，旧命令不会停止新运行 |
| `retry` | 仅重试最近一次失败或取消的提问；创建新 `runId`，复用用户消息和原模型参数快照。界面请求绑定原尝试的 `runId` |
| `getSnapshot` | 返回记录副本、会话版本和活动运行标识；修改副本不影响服务 |
| `retrySave` | 重试保存当前记录；提交成功后恢复尚未发出的模型请求，不重发已经结算的请求 |
| `dispose` | 取消所有活动运行、等待结算并保存；未保存内容会使关闭失败。失败后恢复命令入口，保存恢复前仍禁止新请求 |

同一会话只允许一个活动运行，不同会话可独立运行。上下文包含成功完成的历史轮次和当前提问；失败或取消的提问及部分回复仍保留在记录中，重试成功后才进入后续上下文。原生回复的思考签名、文本签名和供应商字段随完整回复保存与回放。

正文与思考流式片段更新同一 Run。事件通过会话、运行标识和递增序号校验；错误归属、重复、乱序与已结束运行的迟到事件不改变当前回复。最终状态以运行时 `done` 为依据，收到 `settled` 事件时不会提前释放会话。

注入 `SessionStore` 时记录写入数据库；省略存储依赖时使用内存模式。

## 窗口桥接与恢复

Renderer 通过 Preload 的 `ChatBridge` 发送限定的聊天命令。主进程校验发送者及参数，持有会话服务、模型连接和凭据；页面没有 Node、文件系统或通用 IPC 接口。界面视图不包含凭据引用、配置路径或原生供应商载荷。

`ChatHub` 合并界面通知，每个会话保存最多 32 条带序号的视图更新。窗口重新显示时从游标补发更新；游标过期、宿主改变或序号超出范围时返回完整快照。页面拒绝旧序号和过时的异步响应，恢复过程不请求模型。模型生命周期与界面订阅独立。

桥接契约、视图投影及恢复逻辑位于 `src/chat/*`；宿主和限定 IPC 位于 `desktop/*`；React 页面、输入与阅读状态位于 `renderer/*`。

工具过程通过 `ChatAttempt.timeline` 按模型轮次展示，流式片段与已封存消息按消息标识合并。卡片区分准备、等待确认、执行中和终态；参数、结果及安全图片格式可展开。失败后可继续回答或重新尝试无需授权的读取；未知写结果不显示运行重试。窗口重载与重启恢复已保存卡片，不重新执行动作。测试与截图记录于 `docs/validation/tool-chat-2026-10-14.*`。

## 异常与并发边界

- 消息提交以 `clientMessageId` 去重；停止与重试绑定目标运行，旧界面命令不会作用于新回复。
- 同一会话只有一个活动运行，停止后等待运行时结算。取消接口抛错被隔离，错误信息不泄露适配器内部细节。
- 重复、乱序和旧运行事件被丢弃；当前运行的事件序号缺口或格式异常触发停止，最终回复标记失败，不进入有效模型历史。
- 状态通知在命令与事务完成后的微任务中合并发送，订阅回调不会观察到尚未完成的提交过程。
- 退出期间拒绝新命令；保存失败会恢复服务入口，保留内容并等待保存重试。保存恢复后可以继续对话或再次退出。
- 渲染进程崩溃重载页面，主进程继续原运行；一分钟最多自动重载两次，防止崩溃循环。整进程重启将遗留运行标记为中断，不自动重发。

## 持久化与恢复

```ts
import { ConversationService, PiRuntime, SqliteSessionStore } from 'dreamedge';

const service = new ConversationService({
  store: new SqliteSessionStore('data/sessions.sqlite'),
  checkpointMs: 250,
  connection: () => config,
  runtime: snapshot => new PiRuntime(snapshot, credentials),
});
// 构造时恢复历史；listSessions() 返回已有会话，createSession() 创建新会话。
```

`SqliteSessionStore` 使用 Node.js 内置的 [node:sqlite 同步接口](https://github.com/nodejs/node/blob/v22.x/doc/api/sqlite.md)。核心验证环境为 Node.js 22.22.2 / SQLite 3.51.2；桌面运行验证为 Electron 44.7.0 / Node.js 24.21.0。安装包兼容性尚未验证。

- 会话、用户消息、回复运行分别写入关系表；JSON 字段保存完整原生回复、模型参数和去重参数。
- 提问与运行在模型调用前原子提交；最终内容与状态在运行结算后原子提交。事务失败回滚，不保留半条提问或运行记录。
- 流式片段默认每 250 毫秒合并写入检查点，停止和结算时立即提交。崩溃恢复到最后一次成功提交的内容。
- 启动时将遗留的 `running` / `cancelling` 运行标记为 `interrupted` 并保存，不自动重新请求模型。成功历史可继续对话；部分回复不进入模型上下文。
- 文件权限为 `0600`，数据库使用 WAL、外键约束及版本校验。旧版本的写入不会覆盖其他实例的新记录；损坏数据或未知数据库版本报错，不自动清空数据库。

SQLite schema v2 增加 `run_messages` 和 `tool_calls`，授权记录随调用保存。首次打开 v1 数据库时事务迁移旧完成回复，保留会话、用户消息、运行标识及原生元数据；失败回滚原记录、子表和版本。v2 数据库不能由旧 v1 二进制打开。生产包已在隔离数据目录验证工具历史重启恢复，验收未修改原用户数据库。

运行消息、调用状态和会话版本原子提交，已封存消息、终态及工具定义不可重写。`SessionPersistence.commit` 在调用前后等待目标版本落盘，失败等待保存重试或取消，不重复执行动作。

工具上下文保留原生调用、结果、声明和思考字段。重试模型续答时复用完整结果批次，不重复追加提问；后续提问仍保留先前尝试已经完成的工具结果。恢复将未执行调用标为中断、待确认授权标为取消；无法确认执行结果的写操作标为 `outcome_unknown`，为原有调用补充真实错误结果，不自动重发。

`getSnapshot().saveState` 独立于模型运行状态：`disabled` 表示内存模式，`saved` 表示已提交，`pending` 表示等待检查点，`failed` 表示保存失败。模型回复完成后仍可能未保存，不能仅凭 `RunRecord.status` 判断数据已落盘。

保存失败保留内存记录及错误提示，阻止下一轮。调用模型前的提交失败会暂停该运行；`retrySave(sessionId)` 成功提交后才发出原请求。生成期间或最终提交失败时，保存重试只写入最新内容，不再次调用模型。保存重试失败仍保持阻塞；版本冲突需重新加载当前数据库，不自动合并覆盖。服务关闭失败后仍可重试保存，再次执行 `dispose()`。

## 验证

```sh
npm run check
npm test
npm run test:ui
npm run test:packaged
```

测试使用本地 HTTP / SSE 服务及 Pi 的真实协议适配器，覆盖四种协议、DeepSeek 思考参数、流式输出、取消、长度上限、错误与密钥脱敏、事件结算、凭据解析和原生回复续聊。会话测试覆盖三轮 HTTP 上下文回放、跨会话隔离、重试与去重、取消结算、迟到事件、快照隔离及服务关闭。

持久化测试使用真实 SQLite 文件，覆盖重启续聊、原生字段与去重恢复、检查点合并、事务回滚、提交前及结算后保存失败、保存重试、版本冲突和损坏数据。独立子进程在生成中及取消中被 `SIGKILL` 终止，验证中断恢复且不自动重发。

界面测试通过 Playwright 启动真实 Electron 窗口，使用本地 HTTP / SSE 服务和临时数据库，覆盖多轮对话、思考参数、输入法事件、停止与重试、保存失败、草稿、阅读位置、隐藏恢复、页面重载和应用重启。合成输入法事件不替代系统输入法人工验收。验证摘要和截图位于 `docs/validation/chat-2026-10-12.*`。

真实 DeepSeek 联调通过 `npm run model:integration` 使用本机凭据执行两次请求：完整流式回复，以及收到第一段正文后取消。检查高强度思考、事件顺序、单次结算、取消延迟和部分正文保留。摘要保存到 `docs/validation/deepseek-latest.json`，不保存密钥或回复正文。可通过 `--report 路径` 指定摘要文件。该命令产生实际 API 用量。

当前已验证 macOS arm64 的 `.app` 运行包。完整自动化场景覆盖异常、并发、保存和恢复；系统输入法人工验收与签名公证未执行，其他平台未验证。

工具调用验收记录位于 `docs/validation/tool-release-2026-10-14.json`：核心测试 132 项、生产包回归 24 项、真实接口场景 6 项、生产包真实接口场景 5 项通过。独立计数器测试宿主不计入生产包回归数量。

`npm run tools:integration` 使用已有 DeepSeek 配置和凭据执行真实工具链、追问、受控失败后的续答、取消及文字回归。一次 503 由客户端注入，不是 DeepSeek 服务故障。`node dist/scripts/packaged-tool-integration.js` 在生产 `.app` 与隔离数据目录中执行真实界面验收。两者产生实际 API 用量，摘要不保存密钥、请求正文或响应正文。协议参考：[DeepSeek 思考模式与工具调用](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 本地网页版与外部应用

桌面菜单「网页版」提供本机配对入口，网页共用会话、通用 MCP 面板与 Pi 工具执行。旧专用阅读器流程已迁移，见 [通用界面与迁移](docs/mcp-ui-migration.md)；[旧连接记录](docs/reading-web.md)仅用于查阅原实现。

文件权限策略的真实验收：`node dist/scripts/operation-integration.js` 使用现有 DeepSeek 配置、高强度思考、独立打包应用和临时数据，验证结构操作、批量确认、拒绝、停止恢复和版本失效；产生实际 API 用量，并将一份测试文件移入系统废纸篓。2026-10-17 验收摘要见 `docs/validation/file-policy-release-2026-10-17.json`，人工验收单独记录。

## 通用 MCP 接入

已完成契约、连接登记与上下文解析、连接生命周期与能力目录，以及宿主会话中的运行快照、MCP 工具执行、按需资源读取和历史恢复。通过 `ConversationDependencies.prepareTools` 接入现有 Pi 循环、审批与保存屏障；全部外部工具需要确认，配置和目录变化使旧批准失效，未知写结果不重放。桌面与网页版已提供通用配置、批准和会话选择；旧业务入口已迁移，配置示例默认禁用。通用 MCP 已通过跨客户端、真实 DeepSeek 和 macOS arm64 打包自动验收；人工验收尚未记录。详见 [MCP 契约](docs/mcp-contract.md)、[连接登记](docs/mcp-registry.md)、[生命周期](docs/mcp-lifecycle.md)、[运行快照与执行](docs/mcp-execution.md) 和 [资源、历史与恢复](docs/mcp-resources-recovery.md)及[通用界面与迁移](docs/mcp-ui-migration.md)。

当前 MCP 验收包：`release/mcp-validation/DreamEdge-darwin-arm64/DreamEdge.app`。沿用原 DeepSeek 配置启动：`node dist/scripts/run-packaged.js --app-root release/mcp-validation`。详细证据见 [跨应用与打包验收](docs/mcp-release-validation.md)。

### 简单配置 MCP

打开标题栏 MCP，粘贴应用提供的 `mcpServers` JSON（也可选择 JSON 文件），点击“保存并连接”即可。新对话直接使用已配置服务，不需要逐项登记或绑定。也可直接编辑用户数据目录的 `mcp.json`。详见 [JSON 接入说明](docs/mcp-json-setup.md)。
