import { readFileSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ModelConnectionConfig } from '../src/model/types.js';
import { fileDestination, FileScopeError } from '../src/files/scope-types.js';
import type { FileDestination } from '../src/files/scope-types.js';
import { sameDestination } from '../src/files/scope-validation.js';

interface Setting { format: 'dreamedge-device-access/v1'; enabled: boolean; destination: FileDestination }
/** Host-only preference: authority is bound to an exact model destination, never read from renderer paths. */
export class DeviceAccessSettings {
  private setting: Setting | undefined;
  constructor(private readonly path: string) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('Unsafe preference');
      const value = JSON.parse(readFileSync(path, 'utf8')) as Setting;
      if (value.format !== 'dreamedge-device-access/v1' || typeof value.enabled !== 'boolean'
        || !value.destination || !['connectionId', 'protocol', 'model', 'baseUrl'].every(key =>
          typeof value.destination[key as keyof FileDestination] === 'string')) throw new Error('Invalid preference');
      const url = new URL(value.destination.baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid destination');
      this.setting = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new FileScopeError('FILE_SCOPE_INVALID', '整机访问配置无效，未启用访问。');
    }
  }
  enabled(config: ModelConnectionConfig) { return Boolean(this.setting?.enabled && sameDestination(this.setting.destination, fileDestination(config))); }
  set(config: ModelConnectionConfig, enabled: boolean) {
    const setting: Setting = { format: 'dreamedge-device-access/v1', enabled, destination: fileDestination(config) };
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(setting), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path); this.setting = setting;
    } catch { throw new FileScopeError('FILE_SCOPE_SAVE_FAILED', '整机访问设置保存失败。'); }
    finally { try { unlinkSync(temporary); } catch { /* Temporary file was published or never created. */ } }
  }
}
