import type { ModelConnection, ModelSettingsRequest, ModelSettingsResult, ModelSettingsState } from '../../shared/contracts';
import { ModelFailure, type ModelAccess, type ModelInput, type ModelProvider } from '../development/model';
import { ResponsesModel } from '../development/responses';
import { normalizeConfiguration, type ConnectionConfiguration } from './configuration';
import { EMPTY_REVISION, ProjectConnectionFile } from './file';

export class ModelSettings implements ModelProvider {
  private configuration: ConnectionConfiguration = {};
  private revision = EMPTY_REVISION;
  private warning: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<AbortController>();
  private closed = false;
  readonly ready: Promise<void>;
  constructor(private readonly file: ProjectConnectionFile, private readonly projectId: string, private readonly changed: () => void = () => {}, private readonly transport?: typeof fetch) {
    this.ready = this.refresh();
  }
  private async refresh(): Promise<void> {
    try {
      const current = await this.file.load(); this.configuration = current.configuration; this.revision = current.revision; this.warning = current.warning;
      if (this.configuration.apiKey && !this.warning) {
        try { normalizeConfiguration(this.configuration); }
        catch (error) { this.warning = error instanceof ModelFailure ? error.message : '工程模型配置无效。'; }
      }
    } catch (error) {
      this.configuration = {}; this.revision = EMPTY_REVISION;
      this.warning = error instanceof ModelFailure ? error.message : '无法读取工程模型配置。';
    }
  }
  private state(): ModelSettingsState {
    const key = this.configuration.apiKey;
    const publicValue = (value: string) => key && value.includes(key) ? '' : value;
    return { provider: 'responses', model: publicValue(this.configuration.model ?? ''),
      baseUrl: publicValue(this.configuration.baseUrl ?? 'https://api.openai.com/v1'), hasKey: !!key,
      projectId: this.projectId, configPath: this.file.path, revision: this.revision, warning: this.warning };
  }
  private async capture(expectedRevision?: string): Promise<ConnectionConfiguration> {
    await this.refresh(); if (expectedRevision !== undefined) this.assertRevision(expectedRevision);
    if (this.warning) throw new ModelFailure(this.warning);
    return { ...this.configuration };
  }
  async execute(input: unknown): Promise<ModelSettingsResult> {
    await this.ready;
    if (this.closed) throw new Error('模型连接服务已关闭。');
    const request = structuredClone(input) as ModelSettingsRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('模型配置请求无效。');
    if (request.projectId !== this.projectId) throw new Error('模型配置请求不属于当前工程。');
    if (request.operation === 'test') {
      const captured = this.queue.then(() => this.capture(request.expectedRevision)); this.queue = captured.catch(() => {});
      return this.test(await captured);
    }
    const result = this.queue.then(async () => {
      if (this.closed) throw new Error('模型连接服务已关闭。');
      await this.refresh();
      if (request.operation === 'get') return this.state();
      this.assertRevision(request.expectedRevision);
      if (request.operation === 'save') {
        if (request.apiKey !== undefined && typeof request.apiKey !== 'string') throw new Error('模型配置格式无效。');
        const configuration = normalizeConfiguration({ model: request.model, baseUrl: request.baseUrl,
          apiKey: request.apiKey?.trim() || this.configuration.apiKey });
        if (!request.apiKey?.trim() && this.configuration.apiKey && configuration.baseUrl !== this.configuration.baseUrl) throw new Error('服务地址变更时，请重新填写 API Key。');
        await this.file.save(configuration, this.revision);
      } else if (request.operation === 'clear') {
        await this.file.clear(this.revision); for (const controller of this.active) controller.abort('cleared');
      } else throw new Error('不支持的模型配置操作。');
      await this.refresh(); this.changed(); return this.state();
    });
    this.queue = result.catch(() => {}); return result;
  }
  private assertRevision(value: unknown): void {
    if (typeof value !== 'string' || value !== this.revision) throw new Error('配置文件已被修改，请重新读取后再保存或测试。');
  }
  async connection(): Promise<ModelConnection> {
    await this.ready; await this.queue; await this.refresh();
    if (this.warning) return { provider: 'responses', available: false, detail: this.warning };
    return new ResponsesModel(this.configuration, this.transport).connection();
  }
  async assertSafeInput(input: ModelInput): Promise<void> {
    await this.ready; await this.queue; await this.refresh();
    if (this.configuration.apiKey && JSON.stringify(input).includes(this.configuration.apiKey)) throw new ModelFailure('工程源码或需求中包含模型连接凭据，请移除后重试。');
  }
  async generate(input: ModelInput, signal: AbortSignal, access?: ModelAccess): Promise<unknown> {
    await this.ready;
    const captured = this.queue.then(() => this.capture()); this.queue = captured.catch(() => {});
    const configuration = normalizeConfiguration(await captured);
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
    const controller = new AbortController(); this.active.add(controller); const combined = AbortSignal.any([signal, controller.signal]);
    let aborted: (() => void) | undefined;
    try { combined.throwIfAborted(); return await Promise.race([run(combined), new Promise<never>((_, reject) => {
      aborted = () => reject(combined.reason); combined.addEventListener('abort', aborted, { once: true }); if (combined.aborted) aborted();
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
