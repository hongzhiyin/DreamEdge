/** Isolated Electron host: production service, bridge and renderer with test-only tools. */
import { app } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Type } from 'typebox';
import { ConversationService, PiRuntime, SqliteSessionStore, builtInTools } from '../../src/index.js';
import { ChatHub } from '../../src/chat/hub.js';
import { desktopConfig } from '../../desktop/config.js';
import { registerChatIpc } from '../../desktop/ipc.js';
import { chatWindow } from '../../desktop/window.js';
import { recoverRenderer } from '../../desktop/renderer-recovery.js';

app.setPath('userData', process.env.DREAMEDGE_DATA_DIR!);
void start();
async function start() {
  await app.whenReady();
  const { config, credentials } = await desktopConfig(process.cwd(), { userData: app.getPath('userData'), packaged: false });
  const registry = builtInTools();
  const counters = globalThis as unknown as { fixtureWrites: number };
  counters.fixtureWrites = 0;
  for (const slow of [false, true]) registry.register({ name: slow ? 'slow_write' : 'fixture_write', version: '1',
    label: slow ? '慢速写入' : '测试写入', description: 'Writes only to a test process counter',
    parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
    effect: 'write', approval: 'always', resources: ['隔离测试计数器'], timeoutMs: 5000,
    async execute(args, context) {
      counters.fixtureWrites++;
      if (slow) await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { content: [{ type: 'text', text: `写入 ${args.value}` }], details: { writes: counters.fixtureWrites } };
    } });
  const service = new ConversationService({ store: new SqliteSessionStore(join(app.getPath('userData'), 'sessions.sqlite')),
    connection: () => config, tools: () => registry.snapshots(), runtime: config => new PiRuntime(config, credentials, { registry }) });
  const hub = new ChatHub(service, config);
  let quitting = false;
  const window = chatWindow(fileURLToPath(new URL('../../desktop/preload.cjs', import.meta.url)), () => quitting);
  const renderer = fileURLToPath(new URL('../../renderer/index.html', import.meta.url));
  registerChatIpc(window, pathToFileURL(renderer).href, hub);
  recoverRenderer(window, () => quitting);
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    void service.dispose().then(() => { hub.dispose(); quitting = true; app.quit(); });
  });
  await window.loadFile(renderer); window.show();
}
