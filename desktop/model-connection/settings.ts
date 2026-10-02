import type { ModelConnection, ModelSettingsRequest, ModelSettingsResult, ModelSettingsState } from '../../shared/contracts';
import { ModelFailure, type ModelAccess, type ModelInput, type ModelProvider } from '../development/model';
import { ResponsesModel, normalizeConfiguration } from '../development/responses';
import { ConnectionVault, type ConnectionConfiguration } from './vault';

export class ModelSettings implements ModelProvider {
  private configuration: ConnectionConfiguration = {};
  private persisted = false;
  private revision = 0;
  private warning: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<AbortController>();
  private closed = false;
  readonly ready: Promise<void>;
  constructor(private readonly vault: ConnectionVault, initial: ConnectionConfiguration = {},
    private readonly changed: () => void = () => {}, private readonly transport?: typeof fetch) {
    this.configuration = { ...initial }; this.ready = this.restore();
  }
  private async restore(): Promise<void> {
    try {
      const saved = await this.vault.load();
      if (saved) { this.configuration = normalizeConfiguration(saved.configuration); this.revision = saved.revision; this.persisted = true; }
      else if (this.configuration.apiKey) this.configuration = normalizeConfiguration(this.configuration);
    } catch (error) { this.configuration = {}; this.warning = error instanceof Error ? error.message : '本机模型配置无法恢复。'; }
  }
  private state(): ModelSettingsState {
    return { provider: 'responses', model: this.configuration.model ?? '', baseUrl: this.configuration.baseUrl ?? 'https://api.openai.com/v1',
      hasKey: !!this.configuration.apiKey, persisted: this.persisted, secureStorageSupported: this.vault.encryption.supported,
      revision: this.revision, warning: this.warning };
  }
  async execute(input: unknown): Promise<ModelSettingsResult> {
    await this.ready;
    if (this.closed) throw new Error('模型连接服务已关闭。');
    const request = structuredClone(input) as ModelSettingsRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('模型配置请求无效。');
    if (request.operation === 'get') return this.state();
    if (request.operation === 'test') {
      await this.queue; this.assertRevision(request.expectedRevision);
      const configuration = { ...this.configuration };
      return this.test(configuration);
    }
    const result = this.queue.then(async () => {
      if (this.closed) throw new Error('模型连接服务已关闭。');
      this.assertRevision(request.expectedRevision);
      if (request.operation === 'save') {
        if (typeof request.persist !== 'boolean' || request.apiKey !== undefined && typeof request.apiKey !== 'string') throw new Error('模型配置格式无效。');
        const configuration = normalizeConfiguration({ model: request.model, baseUrl: request.baseUrl,
          apiKey: request.apiKey?.trim() || this.configuration.apiKey });
        if (!request.apiKey?.trim() && this.configuration.apiKey && configuration.baseUrl !== this.configuration.baseUrl) throw new Error('服务地址变更时，请重新填写 API Key。');
        if (request.persist) await this.vault.save(configuration, this.revision + 1); else await this.vault.clear();
        this.configuration = configuration; this.persisted = request.persist;
      } else if (request.operation === 'clear') {
        await this.vault.clear(); this.configuration = {}; this.persisted = false;
        for (const controller of this.active) controller.abort('cleared');
      } else throw new Error('不支持的模型配置操作。');
      this.revision++; this.warning = null; this.changed(); return this.state();
    });
    this.queue = result.catch(() => {}); return result;
  }
  private assertRevision(value: unknown): void {
    if (!Number.isSafeInteger(value) || value !== this.revision) throw new Error('模型配置已被另一个窗口更新，请重新读取后操作。');
  }
  async connection(): Promise<ModelConnection> {
    await this.ready; return new ResponsesModel(this.configuration, this.transport).connection();
  }
  async assertSafeInput(input: ModelInput): Promise<void> {
    await this.ready; await this.queue;
    if (this.configuration.apiKey && JSON.stringify(input).includes(this.configuration.apiKey)) throw new ModelFailure('所选源码或需求中包含模型连接凭据，请移除后重试。');
  }
  async generate(input: ModelInput, signal: AbortSignal, access?: ModelAccess): Promise<unknown> {
    await this.ready; await this.queue;
    const configuration = normalizeConfiguration(this.configuration);
    if (JSON.stringify(input).includes(configuration.apiKey)) throw new ModelFailure('请求上下文包含模型连接凭据，已停止发送。');
    return this.request(signal, async activeSignal => {
      const result = await new ResponsesModel(configuration, this.transport).generate(input, activeSignal, access);
      if (JSON.stringify(result).includes(configuration.apiKey)) throw new ModelFailure('模型回复包含连接凭据，已拒绝保存，请检查模型服务。');
      return result;
    });
  }
  private async request<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new ModelFailure('模型连接服务已关闭。');
    if (this.active.size >= 4) throw new ModelFailure('当前最多同时运行 4 个模型请求，请稍后再试。');
    const controller = new AbortController(); this.active.add(controller);
    const combined = AbortSignal.any([signal, controller.signal]);
    let aborted: (() => void) | undefined;
    try { combined.throwIfAborted(); return await Promise.race([run(combined), new Promise<never>((_, reject) => {
      aborted = () => reject(combined.reason); combined.addEventListener('abort', aborted, { once: true });
      if (combined.aborted) aborted();
    })]); }
    catch (error) { if (controller.signal.aborted) throw new ModelFailure('模型连接已清除或关闭，请重新配置。'); throw error; }
    finally { if (aborted) combined.removeEventListener('abort', aborted); this.active.delete(controller); }
  }
  private async test(configuration: ConnectionConfiguration): Promise<ModelConnection> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
    try {
      await this.request(controller.signal, signal => new ResponsesModel(configuration, this.transport).probe(signal));
      return { provider: 'responses', available: true, detail: '连接测试成功，模型支持当前结构化响应。' };
    } catch (error) {
      return { provider: 'responses', available: false, detail: error instanceof ModelFailure ? error.message : '连接测试失败，请核对配置和网络。' };
    } finally { clearTimeout(timer); }
  }
  async dispose(): Promise<void> { this.closed = true; for (const controller of this.active) controller.abort('closed'); await this.queue; }
}
