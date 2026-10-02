# DreamEdge

DreamEdge 是面向业务 App 的开发框架与基础设施，目标是让独立业务项目复用运行环境、公共 SDK 和 AI 修改能力，并分别打包为可独立安装、启动和升级的 App。

每个派生 App 拥有独立源码、依赖、身份和数据，可在同一设备上分别使用。桌面运行时、SDK、脚手架和打包工具已拆为可独立分发的包；AI 修改、候选构建与版本保存仍待接通。

当前版本提供 Electron 桌面宿主、Capacitor iPhone 宿主和阅读记录样例，支持添加、统计、删除及本地持久化。AI 面板已提供，模型调用与自动代码修改尚未接入。

## 本地运行

需要 Node.js 22.13 或更新版本。

```bash
npm ci
npm start
```

验证：`npm test`、`npm run build`、`npm run test:desktop`。iPhone 工程使用 `npm run ios:sync` 和 `npm run ios:open`，需要完整 Xcode，最低支持 iOS 16；真机运行需配置自己的签名团队。

`npm run framework:pack` 生成 `@dreamedge/desktop`、`@dreamedge/sdk`、`@dreamedge/cli` 的版本化 tarball。CLI 支持创建独立业务项目、构建及生成独立安装包；Codex 用量查询业务项目位于独立的 [CodexUsage 仓库](https://github.com/hongzhiyin/CodexUsage)。当前框架包尚未发布到 npm。

## 文档与后续开发

- [DreamEdge 飞书目录](https://my.feishu.cn/wiki/E13MwneaoiwJLDkvCJccEoarnYe)
- [开发计划：当前进度、待办、验收标准与详细文档](https://my.feishu.cn/wiki/JyfmwFZ2SiwLcnk9rsCcro7fnaf)
- [开发日志：按日期归档的开发与验证记录](https://my.feishu.cn/wiki/KvHPw9jIKi0NBkkA45GcWfVGnmd)

后续 Agent 开始开发前先读取开发计划，再按任务查阅架构、运行说明和近期日志；完成后更新计划及开发日志。可使用飞书技能，或通过 `lark-cli docs +fetch --as user --doc https://my.feishu.cn/wiki/JyfmwFZ2SiwLcnk9rsCcro7fnaf` 读取计划。

详细需求、架构与发布说明统一维护在飞书。源码仓库为 [hongzhiyin/DreamEdge](https://github.com/hongzhiyin/DreamEdge)。项目更名不保留旧名称兼容逻辑，也不迁移旧数据。
