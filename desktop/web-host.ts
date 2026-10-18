import { Menu, MenuItem, dialog, clipboard } from 'electron';
import type { BrowserWindow } from 'electron';
import type { ChatHub } from '../src/chat/hub.js';
import { startWebHost } from '../web/server.js';
import type { WebHostOptions } from '../web/server.js';

/** The existing desktop process remains the only conversation store writer. */
export function createWebAccess(hub: ChatHub, rendererDirectory: string, extensions: NonNullable<WebHostOptions['extensions']> = {}) {
  let host: Awaited<ReturnType<typeof startWebHost>> | undefined; let enabling: Promise<void> | undefined;
  async function enable() {
    if (host) return;
    if (enabling) return enabling;
    enabling = (async () => {
      const port = Number(process.env.DREAMEDGE_WEB_PORT ?? 0);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('网页端口配置无效。');
      host = await startWebHost({ hub, rendererDirectory, port, extensions });

    })().finally(() => { enabling = undefined; });
    return enabling;
  }
  async function close() { await enabling?.catch(() => {}); if (host) { const current = host; host = undefined; await current.close(); } }
  return { close, ensure: async () => { await enable(); return host!; }, current: () => host };
}
export type WebAccess = ReturnType<typeof createWebAccess>;
export function installWebMenu(window: BrowserWindow, access: WebAccess) {
  let pairingVisible = false;
  async function pair() {
    if (pairingVisible) return; pairingVisible = true;
    try {
      const host = await access.ensure(); const pairing = host.issuePairingCode(); const url = host.url;
      const response = await dialog.showMessageBox(window, { title: 'DreamEdge 本地网页版', type: 'info',
        message: '在浏览器或支持网页面板的应用中打开以下地址并配对',
        detail: `地址：${url}\n一次性配对码：${pairing.code}\n5 分钟内有效，仅可使用一次。配对后的网页可操作本机 DreamEdge 对话与工具，请只在可信页面输入。`,
        buttons: ['复制地址', '关闭'], defaultId: 0, cancelId: 1 });
      if (response.response === 0) clipboard.writeText(url);
    } catch { await dialog.showMessageBox(window, { type: 'error', message: '本地网页版未启动。请检查端口是否被占用。' }); }
    finally { pairingVisible = false; }
  }
  const menu = Menu.getApplicationMenu();
  menu?.append(new MenuItem({ label: '网页版', submenu: [
    { id: 'web-enable', label: '启用网页版并配对', click: () => { void pair(); } },
    { id: 'web-pair', label: '生成新配对码', click: () => { void pair(); } },
    { id: 'web-revoke', label: '断开全部网页客户端', click: () => access.current()?.revokeAll() },
    { id: 'web-close', label: '关闭网页版', click: () => { void access.close(); } },
  ] }));
  if (menu) Menu.setApplicationMenu(menu);

}
