import { dialog } from 'electron';
import { homedir } from 'node:os';
import { parse } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ConversationService } from '../src/conversation/service.js';
import type { ModelConnectionConfig } from '../src/model/types.js';
import { FileScopeError } from '../src/files/scope-types.js';
import type { DeviceAccessPolicy } from '../src/files/scope-types.js';
import { inspectRoot } from '../src/files/scope-paths.js';
import { DeviceAccessSettings } from './device-access-settings.js';

export class DesktopDeviceAccess {
  private changing = false;
  private constructor(private readonly config: ModelConnectionConfig, private readonly settings: DeviceAccessSettings,
    private readonly policy: DeviceAccessPolicy) {}
  static async create(path: string, config: ModelConnectionConfig) {
    const baseDirectory = await realpath(homedir());
    const candidates = process.platform === 'win32' ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
      : [parse(baseDirectory).root];
    const inspected = await Promise.allSettled(candidates.map(root => inspectRoot(root)));
    const roots = inspected.flatMap(item => item.status === 'fulfilled' ? [item.value] : []);
    if (!roots.length) throw new FileScopeError('FILE_SCOPE_INVALID', '无法确定本机文件系统根目录。');
    return new DesktopDeviceAccess(config, new DeviceAccessSettings(path), { roots, baseDirectory });
  }
  access = (config: ModelConnectionConfig) => this.settings.enabled(config) ? this.policy : undefined;
  async set(service: ConversationService, enabled: boolean): Promise<boolean> {
    if (this.changing) throw new FileScopeError('FILE_SCOPE_STALE', '文件访问模式正在切换。');
    this.changing = true; const previous = this.settings.enabled(this.config);
    try {
      if (previous === enabled) return enabled;
      if (enabled) {
        const reply = await dialog.showMessageBox({ type: 'warning', title: '开启整机文件访问',
          message: '允许此模型服务在所有对话中访问本机普通文件？',
          detail: `文件内容会按任务需要发送到 ${this.config.model}（${new URL(this.config.baseUrl).href}），并保存在聊天记录中。无需逐个选择目录；系统权限、敏感文件排除与每次变更确认仍生效。切换模式会停止正在运行的对话。`,
          buttons: ['取消', '开启整机访问'], defaultId: 0, cancelId: 0 });
        if (reply.response !== 1) return previous;
      }
      for (const session of service.listSessions()) {
        const snapshot = service.getSnapshot(session.sessionId);
        if (enabled && ['failed', 'pending'].includes(snapshot.saveState.status)) throw new FileScopeError('FILE_SCOPE_SAVE_FAILED', '请先重试保存，再开启整机访问。');
      }
      for (const session of service.listSessions()) {
        const snapshot = service.getSnapshot(session.sessionId); if (snapshot.activeRunId) service.stop(session.sessionId, snapshot.activeRunId);
      }
      this.settings.set(this.config, enabled);
      try { service.refreshDeviceAccess(enabled); }
      catch (error) {
        this.settings.set(this.config, previous); try { service.refreshDeviceAccess(); } catch { /* Failed sessions stay blocked by persistence. */ }
        throw error;
      }
      return enabled;
    } finally { this.changing = false; }
  }
}
