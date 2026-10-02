import { rm } from 'node:fs/promises';
import { ensureDirectory, checkedPath, readText, writeText } from '../workspace/paths';

export interface SecretEncryption {
  supported: boolean;
  available(): boolean | Promise<boolean>;
  encrypt(value: string): Buffer | Promise<Buffer>;
  decrypt(value: Buffer): string | Promise<string>;
}
export interface ConnectionConfiguration { apiKey?: string; model?: string; baseUrl?: string }
export class ConnectionVault {
  constructor(private readonly profile: string, readonly encryption: SecretEncryption) {}
  private root(): Promise<string> { return ensureDirectory(this.profile, 'model-connection'); }
  async load(): Promise<{ configuration: ConnectionConfiguration; revision: number } | null> {
    const root = await this.root();
    let content: string;
    try { content = await readText(root, 'settings.json'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('无法读取本机模型配置，请重新配置。'); }
    try {
      const record = JSON.parse(content);
      if (record.schemaVersion !== 1 || typeof record.model !== 'string' || typeof record.baseUrl !== 'string'
        || !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.encryptedKey !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.encryptedKey) || record.encryptedKey.length > 16384) throw new Error();
      if (!await this.encryption.available()) throw new Error();
      return { configuration: { model: record.model, baseUrl: record.baseUrl,
        apiKey: await this.encryption.decrypt(Buffer.from(record.encryptedKey, 'base64')) }, revision: record.revision };
    } catch { throw new Error('本机模型配置无法解密或格式无效，请重新填写 API Key。'); }
  }
  async save(configuration: Required<ConnectionConfiguration>, revision: number): Promise<void> {
    if (!await this.encryption.available()) throw new Error('当前设备无法安全加密保存，请选择仅本次运行使用。');
    let encryptedKey: string;
    try { encryptedKey = (await this.encryption.encrypt(configuration.apiKey)).toString('base64'); }
    catch { throw new Error('系统加密失败，模型配置尚未保存。'); }
    await writeText(await this.root(), 'settings.json', JSON.stringify({ schemaVersion: 1,
      model: configuration.model, baseUrl: configuration.baseUrl, encryptedKey, revision }));
  }
  async clear(): Promise<void> {
    const root = await this.root(); const path = await checkedPath(root, 'settings.json');
    await rm(path, { force: true });
  }
}
