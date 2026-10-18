import { Context } from '@deepseek-ai/cordis';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
/** A dedicated Cordis file service; no Harness agent, tools, credentials or global config. */
export function dshFileBackend() {
  const context = new Context();
  const filesystem = new LocalFileSystem(context, { cwd: '/', diffBasisMaxBytes: 4 * 1024 * 1024 });
  return { filesystem, dispose: () => context.fiber.dispose() };
}
