# Windows 与流光忆庭配套测试

完整解压 DreamEdge Windows 包；不要单独移动 DreamEdge.exe 或 dreamedge-cli.exe。首次运行 DreamEdge.exe 配置自己的模型连接，配置和会话保存在 `%APPDATA%\DreamEdge`，测试包不包含任何个人 API 密钥。

在配套的流光忆庭 Windows 版打开 PDF，点击 AI 区的“设置”→“更多连接操作”→“配置 AI”，选择 DreamEdge 包旁的 `ai-entry.json`，核对启动程序后确认。再点击“连接”。首次会显示 DreamEdge 的应用 / MCP 授权说明；确认当前书籍范围后，AI 界面嵌入阅读器，可以询问当前页或让它翻页。

`ai-entry.json` 的相对启动器名由阅读器按入口文件目录解析并保存为绝对路径。移动 DreamEdge 文件夹后请重新导入入口；也可运行 `export-ai-entry.cmd` 导出带绝对路径的配置。

启动器只交接窗口和书籍标识，不自动读取或发送整本书。内容工具在用户提问后按需读取；切换窗口、切书、撤销授权或内容版本过期会拒绝旧范围访问。连接取消会停止等待和丢弃过期结果，不删除已保存会话。

x64 会使用两端实际包在 Windows runner 上验证嵌入、MCP 上下文读取、原文读取和翻页；模型端使用本地协议夹具，不等同真实服务商或 Windows ARM64 人工验收。
