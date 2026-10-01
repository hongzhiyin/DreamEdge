# IdeaDock 桌面预览版

包含桌面宿主、独立阅读记录工具和 AI 面板入口。阅读记录支持添加、查看、统计与确认删除，重启后保留本地数据。AI 模型尚未接入。

下载与你的电脑匹配的文件：

| 电脑 | 安装包 |
| --- | --- |
| Apple Silicon Mac（M 系列） | `IdeaDock-版本-mac-arm64.dmg`，或对应 `.zip` |
| Intel Mac | `IdeaDock-版本-mac-x64.dmg`，或对应 `.zip` |
| Windows x64 | `IdeaDock-版本-win-x64.exe` |

Mac：打开 DMG，将 IdeaDock 拖入“应用程序”。Windows：打开 EXE，按安装向导完成安装。无需安装 Node.js 或下载源码。

这些包尚无开发者证书签名：Mac 使用临时签名，未进行 Apple 公证；Windows 未签名，首次打开可能被系统提示。请确认下载来源为此私有仓库。`SHA256SUMS.txt` 提供文件校验值。

记录保存在各自电脑的用户数据目录，不随应用包覆盖，也不会在设备间自动同步。数据库位置见 README 与架构文档。本版本尚无自动更新；新版本需重新下载安装。
