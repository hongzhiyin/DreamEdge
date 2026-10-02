# DreamEdge

DreamEdge 是一个面向小工具的本地运行框架，目标是让用户通过内置 AI 对话创建和持续修改工具。

当前版本提供 Electron 桌面宿主、Capacitor iPhone 宿主和阅读记录样例，支持添加、统计、删除及本地持久化。AI 面板已提供，模型调用与自动代码修改尚未接入。

## 本地运行

需要 Node.js 22.13 或更新版本。

```bash
npm ci
npm start
```

验证：`npm test`、`npm run build`、`npm run test:desktop`。iPhone 工程使用 `npm run ios:sync` 和 `npm run ios:open`，需要完整 Xcode，最低支持 iOS 16；真机运行需配置自己的签名团队。

## 文档与后续开发

- [DreamEdge 飞书目录](https://my.feishu.cn/wiki/E13MwneaoiwJLDkvCJccEoarnYe)
- [开发计划：当前进度、待办、验收标准与详细文档](https://my.feishu.cn/wiki/JyfmwFZ2SiwLcnk9rsCcro7fnaf)
- [开发日志：按日期归档的开发与验证记录](https://my.feishu.cn/wiki/KvHPw9jIKi0NBkkA45GcWfVGnmd)

后续 Agent 开始开发前先读取开发计划，再按任务查阅架构、运行说明和近期日志；完成后更新计划及开发日志。可使用飞书技能，或通过 `lark-cli docs +fetch --as user --doc https://my.feishu.cn/wiki/JyfmwFZ2SiwLcnk9rsCcro7fnaf` 读取计划。

详细需求、架构与发布说明统一维护在飞书。源码仓库为 [hongzhiyin/DreamEdge](https://github.com/hongzhiyin/DreamEdge)。项目更名不保留旧名称兼容逻辑，也不迁移旧数据。
