import { automaticApplicationAccess } from '../src/launch/application-policy.js';
import { launchContext } from './launch-context.js';
import { openDesktopUi } from './ui.js';
import { LaunchStore } from '../src/launch/store.js';
import { LaunchController } from '../src/launch/controller.js';
import { controlDirectory, startControl } from '../src/launch/socket.js';
import { desktopMcp } from './mcp.js';
import { createWebAccess } from './web-host.js';
import { fileOperationTools } from '../src/files/operation-tools.js';
import { isMutationName } from '../src/files/managed-tools.js';
import { app, dialog, shell } from 'electron';
import { mkdirSync, rmSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConversationService, PiRuntime, SqliteSessionStore, builtInTools, scopedReadTools, readToolNames, scopedMutationTools, mutationToolNames } from '../src/index.js';
import { ChatHub } from '../src/chat/hub.js';
import { desktopConfig } from './config.js';
import { accountFileAccess } from '../src/files/account-access.js';
import { inspectFileMutation } from '../src/files/mutation-policy.js';

app.setName('DreamEdge');
if (process.env.DREAMEDGE_DATA_DIR) {
  mkdirSync(process.env.DREAMEDGE_DATA_DIR, { recursive: true, mode: 0o700 });
  app.setPath('userData', process.env.DREAMEDGE_DATA_DIR);
}
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
else void start().catch(error => {
  if (process.env.DREAMEDGE_LAUNCH_DIAGNOSTICS === '1') {
    try { writeFileSync(join(app.getPath('userData'), 'launch-diagnostics.log'), String(error?.stack ?? error)); } catch { }
  }
  if (process.env.DREAMEDGE_NO_DIALOGS !== '1') dialog.showErrorBox('DreamEdge 无法启动', '请检查模型配置和数据目录。');
  process.stderr.write('DreamEdge 初始化失败。\n'); app.exit(1);
});

async function start(): Promise<void> {
  await app.whenReady();
  const { config, credentials } = await desktopConfig(app.getAppPath(), { userData: app.getPath('userData'), packaged: app.isPackaged });
  const launchStore = new LaunchStore(join(app.getPath('userData'), 'launch.sqlite'));
  const registry = builtInTools();
  const accountAccess = await accountFileAccess(undefined, [app.getAppPath(), app.getPath('userData')]);
  const mcp = desktopMcp(app.getPath('userData'), credentials, registry, () => service, config);
  const context = launchContext(app.getPath('userData'), launchStore, credentials, () => service, config, mcp.prepareTools);
  const service = new ConversationService({ store: new SqliteSessionStore(join(app.getPath('userData'), 'sessions.sqlite')),
    deviceAccess: () => accountAccess, guardModelContext: (id, connection) => { context.guard(id); mcp.guardHistory(id, connection); }, prepareTools: context.prepare, connection: () => config, tools: (connection, sessionId) => !(sessionId && (service.getSnapshot(sessionId).session.toolsDisabled || service.getSnapshot(sessionId).session.externalTools)) && connection.toolCalling?.supported
      ? registry.snapshots().filter(tool => sessionId && mcp.control.mode(sessionId) !== 'local' ? ['clock', 'calculator'].some(r => tool.resources.includes(r)) : true).filter(tool => isMutationName(tool.name)
        ? Boolean(sessionId && service.fileScopes.roots(sessionId, connection).some(root => root.mode === 'read-write'))
        : !readToolNames.includes(tool.name as never) || Boolean(sessionId && service.fileScopes.roots(sessionId, connection).length)) : [],
    runtime: connection => new PiRuntime(connection, credentials, { registry }) });
  const fileCache = join(app.getPath('userData'), 'file-snapshots');
  try { if (lstatSync(fileCache).isSymbolicLink()) throw new Error('Unsafe file cache'); rmSync(fileCache, { recursive: true, force: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  mkdirSync(fileCache, { recursive: true, mode: 0o700 });
  for (const tool of await scopedReadTools(service.fileScopes, {}, fileCache, 'account')) registry.register(tool);
  for (const tool of await scopedMutationTools(service.fileScopes, {}, inspectFileMutation)) registry.register(tool);
  for (const tool of fileOperationTools(service.fileScopes, { trash: path => shell.trashItem(path) })) registry.register(tool);
  registry.seal();
  const hub = new ChatHub(service, config);
  let quitting = false;
  let exiting = false;
  const web = createWebAccess(hub, fileURLToPath(new URL('../renderer', import.meta.url)), { mcp: mcp.handler });
  let ui: Awaited<ReturnType<typeof openDesktopUi>> | undefined;
  let opening: Promise<void> | undefined;
  const show = () => {
    if (exiting || quitting) return;
    if (ui) { ui.show(); return; }
    if (!opening) opening = (async () => {
      await app.dock?.show();
      ui = await openDesktopUi(hub, service, mcp.control, web, () => quitting, () => exiting);
    })().catch(() => { process.stderr.write('主窗口打开失败。\n'); }).finally(() => { opening = undefined; });
  };
  const second = (_event: unknown, argv: string[]) => { if (!argv.includes('--background')) show(); };
  app.on('activate', show); app.on('second-instance', second);
  const launch = new LaunchController(launchStore, service, config, () => web.ensure(), async (source, _destination, offer) => {
    const response = await dialog.showMessageBox({ type: 'question', title: '外部应用会话',
      message: `允许 ${source.name} 打开 AI 会话？`,
      detail: `应用标识：${source.id}\n资料区：${source.profile}\n模型：${config.model}\n服务：${config.baseUrl}\n\n允许创建和恢复该应用的文字对话。输入的消息会发送到上述模型。${offer ? `读取范围：${offer.scope}\n只读工具：${offer.readTools.join('、')}\n普通交互：${(offer.interactionTools ?? []).join('、') || '无'}\n启动入口：${offer.transport.command}\n参数：${JSON.stringify(offer.transport.args)}\n允许这些工具按需读取并发送到上述模型，仅包含列出的读取和普通交互，不包含删除、覆盖或本机文件权限。` : '此次不授予文件或 MCP 权限。'}应用名称由本机调用方声明；控制接口仅限当前系统账户。`,
      buttons: ['允许并记住', '取消'], defaultId: 1, cancelId: 1 });
    return response.response === 0;
  }, context.mcp, request => automaticApplicationAccess(join(app.getPath('userData'), 'application-policies.json'), request, config));
  const control = await startControl(controlDirectory(app.getPath('userData')), value => launch.request(value));
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (exiting) return;
    exiting = true;
    void service.dispose().then(async () => {
      await control.close(); await web.close(); await mcp.close(); await context.close(); launchStore.close();
      app.removeListener('activate', show); app.removeListener('second-instance', second);
      ui?.dispose(); hub.dispose(); quitting = true; app.quit();
    }).catch(() => {
      exiting = false; show();
      if (process.env.DREAMEDGE_NO_DIALOGS !== '1') {
        void dialog.showMessageBox({ type: 'error', message: '还有未保存的对话。',
          detail: '请重试保存，然后再次退出。', buttons: ['返回对话'] });
      }
    });
  });
  if (process.argv.includes('--background')) app.dock?.hide(); else show();
}
