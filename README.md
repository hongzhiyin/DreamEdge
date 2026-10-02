# DreamEdge

DreamEdge 是业务软件开发框架与起点，目标是让用户在 DreamEdge 内创建独立业务项目，通过 AI 开发、构建、预览和保存，再生成可独立安装的 App。

当前阶段只开发 DreamEdge 自身。先完成可用、可发布的框架，再由用户创建业务软件，依据真实使用反馈迭代。默认界面仅显示 HelloWorld；AI 对话如何唤出、业务界面及功能入口暂不预设。

已有桌面运行时、SDK、存储隔离、构建工具和工程工作区底层接口。一份桌面运行实例可同时打开多个工程窗口，各自绑定工作区、API Key 模型会话、候选构建/预览、确认保存与版本恢复；退出后恢复窗口、工程及位置。源码保存校验冲突并支持事务中断恢复，业务数据按工程隔离。界面尚未提供开发入口，依赖管理和发布就绪验收仍待完成，当前不作为可用开发平台发布。

## 本地运行

需要 Node.js 22.13 或更新版本。

```bash
npm ci
npm start
```

验证：`npm test`、`npm run build`、`npm run test:desktop`。`npm run test:framework` 使用两个临时 HelloWorld 工程验证框架依赖与数据隔离，不需要业务仓库。手机原型使用 `npm run ios:sync` 和 `npm run ios:open`，需要完整 Xcode，最低支持 iOS 16。

`npm run framework:pack` 可生成版本化框架包，供内部验证构建链路；框架包尚未发布到 npm。命令行生成项目只是已有底层能力，不能代替在 DreamEdge 内开发业务项目的最终目标。

工程、会话、构建和版本管理通过框架主界面的内部接口执行，不向内容页开放。源码与 `.dreamedge/project.json` 保存在独立工程目录，数据、构建、会话和版本快照按工程身份存放在用户数据区。保存/恢复期间的事务暂存位于工程的 `.dreamedge/transaction`，打开工程时检查并恢复未完成事务。具体接口和当前限制见飞书架构说明。

窗口管理内部接口支持新窗口、新工程、打开工程、查询和聚焦；同一工程只绑定一个开发窗口，重复打开会聚焦已有窗口。窗口拥有独立浏览器 Session，内容页按工程来源隔离；工程切换会撤销旧调用令牌并重建内容页，存储操作仅作用于当前工程。手动关闭窗口不影响其他窗口，整体退出则保留打开列表供下次恢复。

模型连接目前支持 Responses API 与结构化输出。启动桌面进程前配置 `DREAMEDGE_AI_API_KEY`、`DREAMEDGE_AI_MODEL`，可选 `DREAMEDGE_AI_BASE_URL`（默认 `https://api.openai.com/v1`）。凭据仅由主进程读取，不保存到工程或会话；选定的源码会发送给配置的模型服务。自动测试使用模拟响应，不需要真实密钥。

候选构建目前支持 HTML、工程内 JS/TS、CSS 和文本资源，暂不支持 npm 依赖安装。构建不执行工程脚本；预览无框架接口、Node.js 或网络权限，不改写原源码。内部接口、限制和验收步骤统一记录在飞书。

版本操作仅管理普通 UTF-8 源码及工程描述，恢复不回滚业务数据。准备阶段可以取消；源码切换开始后完成提交或回退。构建记录格式已更新，旧候选需重新构建，不提供迁移。

## 文档与后续开发

- [DreamEdge 飞书目录](https://my.feishu.cn/wiki/E13MwneaoiwJLDkvCJccEoarnYe)
- [开发计划：当前进度、待办及验收标准](https://my.feishu.cn/wiki/JyfmwFZ2SiwLcnk9rsCcro7fnaf)
- [开发日志：按日期归档的历史记录](https://my.feishu.cn/wiki/KvHPw9jIKi0NBkkA45GcWfVGnmd)

后续 Agent 先读开发计划，工作范围限定为 DreamEdge。用 HelloWorld 和通用框架测试验证能力；完成后更新计划与日志。业务软件由用户在框架可用后自行尝试创建，当前不推进业务样例。

详细说明统一维护在飞书。源码仓库为 [hongzhiyin/DreamEdge](https://github.com/hongzhiyin/DreamEdge)。
