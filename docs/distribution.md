# 桌面构建与发布

GitHub Actions 工作流为 `.github/workflows/desktop.yml`，生成三个目标：macOS arm64、macOS x64 与 Windows x64。当前没有自动更新客户端，也没有开发者证书签名或 Apple 公证。

## 日常开发

推送 `main` 或创建针对 `main` 的 PR 后，自动安装锁定依赖、运行核心测试并构建源码。此过程不会创建 Release。

在 [Actions](https://github.com/hongzhiyin/IdeaDock/actions/workflows/desktop.yml) 中点击 **Run workflow**，可以手动构建三平台安装包并下载 Artifacts，产物保留 14 天。失败时保留测试诊断截图 7 天。

## 版本发布

1. 更新 `package.json` 与 `package-lock.json` 的版本号，并更新 `docs/release-notes.md`。
2. 提交、推送，确认日常构建通过。
3. 推送与 package 版本一致的标签，例如 `v0.1.1`。
4. 自动构建三平台包，分别运行源码桌面测试与打包应用测试；全部成功后，生成含安装包与 SHA256 校验文件的 Release **草稿**。
5. 在 GitHub 检查草稿与安装包，再点击 **Publish release**。

例如在版本号已更新为 `0.1.1` 后执行：

```bash
git tag v0.1.1
git push origin v0.1.1
```

标签与 package 版本不一致时构建失败。任一平台失败时不创建 Release。重跑成功后可更新同标签草稿，但不会覆盖已经正式发布的版本。源代码校验只需读权限，草稿发布 job 单独获得仓库写权限；使用 GitHub 自动提供的 `GITHUB_TOKEN`，不用把个人 token 写入项目。

仓库为私有，下载需要有仓库访问权限。Actions 使用账号对应的执行分钟额度。正式公开分发、签名、公证及自动更新可在后续补充。

## 本地打包

先安装依赖，再在对应平台运行：

```bash
npm ci
npm run package -- --mac --arm64  # 在 Apple Silicon Mac 上
npm run package -- --mac --x64    # 在 Intel Mac 上
npm run package -- --win --x64    # 在 Windows x64 上
npm run test:packaged            # 验收本机对应的已打包应用
```

产物位于 `release/`，该目录不提交到源码仓库。Mac 包包含 DMG 和 ZIP，Windows 包为 EXE 安装程序。打包时只收录构建代码、package 元数据与运行依赖，数据库保存在用户数据目录，不嵌入安装包。

Mac 包使用 ad-hoc 临时签名，未进行开发者认证与 Apple 公证；Windows 包未签名。系统可能提示无法验证开发者或未知发布者。打包测试覆盖应用主体的启动、存储、重新加载、跨进程重启、删除、快捷键与基础布局；Windows 安装向导仍需人工验收。

配置参考：[electron-builder](https://www.electron.build/)、[GitHub runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[Electron 签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)。
