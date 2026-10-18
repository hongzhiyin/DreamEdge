# 上游许可证

`Pi-1.1.0-LICENSE.txt` 保存 Pi 1.1.0 的 MIT 许可证正文，适用于本应用固定的 `@earendil-works/pi-*` 和同仓库依赖。发布的 Pi npm 包没有包含正文，DreamEdge 显式将此文件放入应用归档。

来源：https://raw.githubusercontent.com/earendil-works/pi/v1.1.0/LICENSE

DSH、Cordis、ripgrep 等依赖已有的许可证正文保留在各自包目录中。打包检查验证 Pi 许可证正文与本地副本一致，并验证已接入 DSH 与 Cordis 包的许可证文件存在。

通用 MCP 契约固定使用 `@earendil-works/pi-mcp` 1.1.0，适用上述 Pi MIT 许可证。该 npm 包附带的第三方 MIT 声明另存为 `Pi-MCP-1.1.0-MCP-SDK-NOTICE.txt`，内容与包内 `LICENSES/modelcontextprotocol-typescript-sdk.txt` 一致；两份声明均由既有 `licenses/` 打包规则保留。
