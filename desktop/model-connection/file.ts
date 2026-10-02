import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { checkedPath, ensureDirectory, hash, readText, writeText } from '../workspace/paths';
import { ModelFailure } from '../development/model';
import type { ConnectionConfiguration } from './configuration';

export const MODEL_FILE = '.dreamedge/model.json';
export const EMPTY_REVISION = hash('');
export interface ConfigurationFile { revision: string; configuration: ConnectionConfiguration; warning: string | null }
export class ProjectConnectionFile {
  readonly path: string;
  constructor(private readonly root: string) { this.path = join(root, MODEL_FILE); }
  async load(): Promise<ConfigurationFile> {
    let content: string;
    try { content = await readText(this.root, MODEL_FILE); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: EMPTY_REVISION, configuration: {}, warning: null };
      throw new ModelFailure('无法读取工程模型配置，请检查 .dreamedge/model.json 是否是普通文本文件。');
    }
    const revision = hash(content);
    try {
      const value = JSON.parse(content);
      if (!value || value.schemaVersion !== 1 || typeof value.apiKey !== 'string' || typeof value.model !== 'string' || typeof value.baseUrl !== 'string'
        || value.apiKey.length > 4096 || value.model.length > 120 || value.baseUrl.length > 2048) throw new Error();
      return { revision, configuration: { apiKey: value.apiKey, model: value.model, baseUrl: value.baseUrl }, warning: null };
    } catch { return { revision, configuration: {}, warning: '工程模型配置格式无效，请检查 .dreamedge/model.json 的 schemaVersion、apiKey、model 和 baseUrl。' }; }
  }
  async save(configuration: Required<ConnectionConfiguration>, revision: string): Promise<void> {
    await this.assertRevision(revision); await ensureDirectory(this.root, '.dreamedge');
    await this.ignoreFile(); await this.assertRevision(revision);
    await writeText(this.root, MODEL_FILE, JSON.stringify({ schemaVersion: 1, ...configuration }, null, 2) + '\n');
  }
  async clear(revision: string): Promise<void> {
    await this.assertRevision(revision); await rm(await checkedPath(this.root, MODEL_FILE), { force: true });
  }
  private async assertRevision(revision: string): Promise<void> {
    if ((await this.load()).revision !== revision) throw new ModelFailure('配置文件已被修改，请重新读取后再保存或测试。');
  }
  private async ignoreFile(): Promise<void> {
    let content = '';
    try { content = await readText(this.root, '.gitignore'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ModelFailure('无法更新工程 .gitignore，模型配置尚未保存。'); }
    if (!content.split(/\r?\n/).includes('/' + MODEL_FILE)) await writeText(this.root, '.gitignore', content + (content && !content.endsWith('\n') ? '\n' : '') + '/' + MODEL_FILE + '\n');
  }
}
