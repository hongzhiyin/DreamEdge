# DreamEdge

DreamEdge 是业务软件开发框架与起点，目标是让用户在 DreamEdge 内创建独立业务项目，通过 AI 开发、构建、预览和保存，再生成可独立安装的 App。

当前阶段只开发 DreamEdge 自身。先完成可用、可发布的框架，再由用户创建业务软件，依据真实使用反馈迭代。默认界面仅显示 HelloWorld；AI 对话如何唤出、业务界面及功能入口暂不预设。

已有桌面运行时、SDK、存储隔离、构建工具和工程工作区底层接口，支持创建、打开、保存、恢复工程及受控源码读写。界面尚未提供工程操作入口；AI 修改、候选构建和版本闭环尚未完成，当前不作为可用开发平台发布。

## 本地运行

需要 Node.js 22.13 或更新版本。

```bash
npm ci
npm start
```

验证：`npm test`、`npm run build`、`npm run test:desktop`。`npm run test:framework` 使用两个临时 HelloWorld 工程验证框架依赖与数据隔离，不需要业务仓库。手机原型使用 `npm run ios:sync` 和 `npm run ios:open`，需要完整 Xcode，最低支持 iOS 16。

`npm run framework:pack` 可生成版本化框架包，供内部验证构建链路；框架包尚未发布到 npm。命令行生成项目只是已有底层能力，不能代替在 DreamEdge 内开发业务项目的最终目标。

工程管理通过框架主界面的内部接口执行，不向内容页开放。源码与 `.dreamedge/project.json` 保存在独立工程目录，数据、构建及预留的版本/会话目录按工程身份存放在用户数据区。具体接口和当前限制见飞书架构说明。

## 文档与后续开发

- [DreamEdge 飞书目录](https://my.feishu.cn/wiki/E13MwneaoiwJLDkvCJccEoarnYe)
- [开发计划：当前进度、待办及验收标准](https://my.feishu.cn/wiki/JyfmwFZ2SiwLcnk9rsCcro7fnaf)
- [开发日志：按日期归档的历史记录](https://my.feishu.cn/wiki/KvHPw9jIKi0NBkkA45GcWfVGnmd)

后续 Agent 先读开发计划，工作范围限定为 DreamEdge。用 HelloWorld 和通用框架测试验证能力；完成后更新计划与日志。业务软件由用户在框架可用后自行尝试创建，当前不推进业务样例。

详细说明统一维护在飞书。源码仓库为 [hongzhiyin/DreamEdge](https://github.com/hongzhiyin/DreamEdge)。
