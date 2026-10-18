import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function launchDataDirectory(platform = process.platform, environment = process.env): string {
  if (environment.DREAMEDGE_DATA_DIR) return resolve(environment.DREAMEDGE_DATA_DIR);
  if (platform === 'darwin') return join(homedir(), 'Library/Application Support/DreamEdge');
  if (platform === 'win32') return join(environment.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'DreamEdge');
  return join(environment.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'DreamEdge');
}
