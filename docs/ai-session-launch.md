# AI 会话启动接口

后续业务只读交接已实现，见 [业务上下文与 MCP 授权交接](business-context-handoff.md)。本文的纯文字限制适用于未提供 mcp 声明的启动请求；新增声明会进入独立的读取授权流程。

协议：`ai-session-launch/v1`。本阶段实现本机 CLI、后台启动和单会话网页交接。macOS arm64 已验证；Linux 的 Unix socket 路径已实现但未验收，Windows 未接入。

## 接口

AI 工具导出入口 JSON，业务应用只依赖协议与入口文件，不识别产品名称。打包产物旁的 `ai-entry.json` 可直接导入，移动应用后需重新导出入口。

```sh
"/path/to/DreamEdge.app/Contents/MacOS/dreamedge-cli" describe
"/path/to/DreamEdge.app/Contents/MacOS/dreamedge-cli" open-session < request.json
"/path/to/DreamEdge.app/Contents/MacOS/dreamedge-cli" status
```

`describe` 返回可直接导入的清单：`protocol`、`name`、`transport: {type: "stdio", command, args}` 和 `capabilities`。command 为绝对可执行路径；调用方直接执行参数数组，追加操作名称，不经 shell。其余操作返回 `{ok:true,data}` 或 `{ok:false,error:{code,message}}`；失败退出码为 1。日志仅走 stderr。

`open-session` 的 stdin 示例：

```json
{
  "protocol": "ai-session-launch/v1",
  "operation": "open-session",
  "requestId": "request-001",
  "application": {"id": "example.editor", "name": "Editor", "profile": "default"},
  "context": {"window": "window-001", "resource": "document-001", "revision": "optional-version"}
}
```

返回 `sessionId`、`resumed`、`url`、`expiresAt`、`contextStatus: "reference-only"`。请求不包含正文、模型密钥、MCP 配置或自动授权声明；未知字段和版本被拒绝。请求上限 64 KiB，标识最长 256 字符，应用名称最长 100 字符。

`status` 不启动后台，返回就绪状态；已启动时附 PID。`revoke` 从 stdin 接收相同协议与 application，撤销该应用及资料区的会话启动信任和网页凭据；不删除聊天，也不重放或停止已经提交的任务。

## 启动与恢复

- CLI 通过当前账户专用 Unix socket 联系后台；无实例时启动 Electron `--background`，沿用同一模型配置和数据库。
- 后台不创建主窗口；正常桌面启动或激活时才创建窗口。Electron 单实例锁确保数据库只有一个写入进程。
- 服务启动最多等待 30 秒；本地控制请求等待上限 120 秒。重复并发打开串行处理。
- 应用＋资料区＋窗口＋资源决定会话绑定；同一绑定恢复原会话，资源变化创建另一会话。同一 requestId 不能改指其他绑定。
- 页面入口 60 秒有效且只可兑换一次。短期票据放 URL fragment，兑换后立即移除；会话令牌保留在页面 sessionStorage，最长 8 小时。它只允许访问这一条会话；历史列表、发送、停止、重试、审批和事件均检查归属，全局扩展接口不开放。
- 页面刷新沿用会话；后台重启后由业务应用再次调用 open-session 获得新入口。关闭面板不取消已提交回复。

## 权限与能力边界

首次打开由 AI 宿主显示应用标识、资料区、模型和服务地址；批准后记住同一应用和模型目的地。更换模型目的地或撤销后再次确认。阅读器首次导入入口另行确认实际执行程序，这属于启动入口配置，不能代替 AI 侧数据授权。

控制目录 0700，socket 0600，仅限当前系统账户。这是同账户本机互操作，不是已签名应用身份认证；application 名称由本机调用方声明，不能防御同账户恶意进程冒充。

本阶段会话持久化 `toolsDisabled: true`，会话执行层跳过工具准备；不会继承全局 MCP 配置或本机文件权限。上下文仅作为不透明标识保存，不读取书籍或窗口内容，不进入模型上下文。页面显示“应用内容与工具尚未接入”。

## 阅读器接入

macOS 阅读器打开书籍 → 外部对话 → 首次选择 AI 工具导出的入口 JSON → 确认入口及 AI 侧授权 → 页面显示在右侧。后续点击自动启动或复用后台；“重连”重新请求会话入口，“配置 AI”更换提供方。静态网址模式仍保留。

阅读器使用自身窗口与书籍 ID 生成通用 context；AI 宿主只保存标识，不解释书籍字段。当前窗口 ID 存在 sessionStorage 中，支持窗口内刷新／重连；阅读器进程完全重启后的窗口身份恢复尚未接入，可能创建新会话。

当前不会在后台断线后自动重启 AI，需要点击重连或重新打开面板。自动服务恢复、可信 MCP 上下文交接、单次综合授权属于下一阶段。

## 复用与验证

继续复用固定 Pi 1.1.0 的 PiRuntime、Agent Core 与已有 ConversationService、SQLite、ChatHub、网页流式桥接。已核对 Pi coding-agent 的 `docs/rpc.md`：其 RPC 服务于 Pi 会话控制，没有 DreamEdge 网页票据与既有会话数据库交接入口，因此不另起第二套 Pi 会话存储。DSH Cordis 提供插件生命周期，不负责宿主应用启动或网页会话授权。

验证见 `docs/validation/ai-session-launch-2026-10-17.json`、`test/launch.test.ts`、`test/web-host.test.ts`、`test/ui/launch.test.ts`；阅读器原生启动器验证为 `scripts/external-launch-smoke.mjs`。自动测试使用本地协议模型夹具，本阶段未新增真实 DeepSeek 调用或人工验收。

回退时退出验收版并使用旧应用包；本阶段新增 launch.sqlite 和可选 session.toolsDisabled，未删除既有会话和 MCP 配置。不要把内部 launch.sqlite 当作可分发配置。
