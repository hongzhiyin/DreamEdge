# 旧阅读器适配迁移

`legacy.ts` 只读取旧 reading.local.json 绑定、识别旧 reader-bridge/v1 历史和检查原模型目的地。它不启动程序、不注册旧工具，也不把旧批准转换成 MCP 批准。

适配器由 `src/adapters/installed.ts` 显式组合，宿主只依赖 HostAdapter 接口。移除适配器不会移除通用的旧外部历史目的地检查。原协议及服务代码保留在 src/reading，用于兼容验证，不接入新的桌面或网页调用入口。

新的调用通过应用提供的标准 MCP：在“外部连接”登记程序绝对路径，启动参数填写 `["mcp"]`，核对配置后批准，再选择“用于本会话”。示例位于 `config/adapters/recollection-garden.example.json`，默认停用且不会自动导入；替换为实际安装路径后使用。

已核对提供方本机 README 和 bridge/mcp.mjs：桌面 CLI 提供 mcp 命令，源码模式为 Node 启动 bridge/mcp.mjs。窗口、书籍、笔记及请求标识都由其 MCP schema 和描述定义，DreamEdge 核心不解释或替填这些参数。不转移原 selectedNotes 权限，不自动选择第一个窗口。

本阶段使用通用测试 MCP 验证新调用链，没有执行真实阅读器操作。实际服务 schema 兼容性和跨应用联调在下一阶段验收；不兼容工具仍显示为不可调用，不删约束绕过校验。
