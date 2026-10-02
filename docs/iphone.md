# IdeaDock iPhone 宿主

Capacitor 是把网页技术接入原生手机 App 的运行框架：React 页面在 iOS 的 WKWebView 中运行，通过插件调用 Swift 实现的本地能力。它与 Electron 各自提供宿主，共享阅读工具的界面、校验、排序和统计代码。

目前支持 iOS 16 或更新版本。应用只运行随安装包提供的阅读工具，支持添加、查看、统计、删除和重启读取；AI 面板仍为入口，没有模型调用或动态代码修改。数据不在设备之间同步。

## 代码边界

| 部分 | 文件 |
| --- | --- |
| 手机宿主与触控样式 | `mobile/` |
| 复用工具界面与业务逻辑 | `tools/reading-log/src/` |
| 统一存储契约与校验 | `tool-sdk/storage-client.ts`、`shared/storage-validation.ts` |
| iPhone 原生插件与 SQLite | `ios/App/App/StoragePlugin.swift`、`RecordDatabase.swift` |
| 原生插件注册 | `AppBridgeViewController.swift` |
| 原生工程配置 | `capacitor.config.ts`、`ios/App/App.xcodeproj` |

阅读工具接收 `StorageClient`。桌面默认使用受控 iframe/IPC 接口，手机宿主注入绑定 `reading-log` 的存储实现。iOS 原生插件只接受已安装样例的命名空间、固定操作和有效标识，使用参数绑定访问系统 SQLite，不接受 SQL 或文件路径。

当前手机工具与宿主是同一安装包内的可信代码，不提供桌面那样的独立 iframe 执行环境。开放动态下载、AI 修改或第三方小工具前，需要另行设计执行边界与审核方式。

## 运行

```bash
npm ci
npm run ios:sync
npm run ios:open
```

`ios:sync` 构建手机网页、同步资源和 Capacitor Swift Package，再配置原生存储与测试 target。`ios:open` 用 Xcode 打开工程。需要完整 Xcode 26 或更新版本；仅安装 Command Line Tools 无法运行 iOS 模拟器。

在 Xcode 选择 App scheme 与 iPhone 模拟器即可运行。安装到自己的 iPhone 还需要在 Signing & Capabilities 中选择开发团队、连接设备并完成设备所需的开发者设置。TestFlight 或 App Store 分发另需开发者账号、签名与分发配置，当前未生成真机 IPA。

浏览器预览：

```bash
npm run build:mobile
npm run mobile:preview
```

浏览器版仅用于预览，用 IndexedDB 保留数据；iPhone 安装版使用系统 SQLite。二者不会互相共享记录。手机界面目前固定浅色外观，适配触控、安全区域和较大字体。

## 验证

`npm run test:mobile` 在 WebKit 中检查记录添加、重载、浏览器进程重启、删除、手机尺寸/横屏、大字体、浅色外观与助手面板。`tests/native-storage-smoke.swift` 检查与 iPhone 共用的原生数据库代码。

`.github/workflows/ios.yml` 在 GitHub Mac 环境中编译完整 iOS 工程，运行 iPhone 模拟器 UI 测试：通过 Capacitor 保存记录、退出应用、重新启动并读取原记录。成功后上传模拟器 App 与测试结果。模拟器 ZIP 只能用于模拟器，不能直接安装到真实 iPhone。

2026 年 10 月 2 日，[完整 iPhone 验收](https://github.com/hongzhiyin/IdeaDock/actions/runs/36970386995) 已通过：Xcode 原生编译、WebKit 手机交互、原生 SQLite 校验，以及 iPhone 模拟器 App 保存/退出/重启读取。测试还直接检查模拟器容器内的 SQLite 文件，确认记录由原生存储持久化。桌面版回归测试通过。

数据库位于 App 容器的 `Library/Application Support/IdeaDock/ideadock.sqlite`。覆盖网页资源不会覆盖业务数据；应用升级应保留容器数据。卸载 App 会删除其本地容器数据，应先做好备份。当前没有数据库迁移或跨设备同步。

参考：[Capacitor iOS](https://capacitorjs.com/docs/ios)、[原生插件](https://capacitorjs.com/docs/plugins/ios)、[Swift Package Manager](https://capacitorjs.com/docs/ios/spm)。
