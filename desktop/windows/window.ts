import { type BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { WindowBounds } from '../../shared/contracts';
import { serveAsset } from '../assets';
import { WindowContext } from './context';
import { DISPLAY_PREFIX } from '../display/store';
import { secureWindow } from './security';
export { restoredBounds } from './security';

export function createHostWindow(context: WindowContext, id: string, root: string, preload: string, resourceId: string, bounds: WindowBounds | null): BrowserWindow {
  return secureWindow(id, preload, bounds, () => context.tools()[0], request => {
    const tools = context.tools(); const aliases = new Map([[tools[0].id, resourceId]]);
    const url = new URL(request.url); const host = url.hostname;
    if (host === tools[0].id && url.pathname.startsWith(`/${DISPLAY_PREFIX}/`)) return context.serveProject(request.url);
    if (host === tools[0].id && tools[0].projectView) return Promise.resolve(new Response('工程显示地址已过期。', { status: 404 }));
    return serveAsset(join(root, 'dist'), request.url, tools, aliases, host === 'shell' ? 'dreamedge:' : undefined);
  });
}
