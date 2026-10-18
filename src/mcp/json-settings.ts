import { accessSync, constants, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { previewPiMcpConfig } from './pi-config-import.js';
import { jsonCopy } from '../tools/json.js';
import type { McpConnectionRegistry } from './registry.js';
import type { McpServerConfig } from './types.js';

export class McpSettingsError extends Error {}
export function standardMcpConfig(configs: readonly McpServerConfig[]) {
  return { mcpServers: Object.fromEntries(configs.map(c => [c.serverId, c.transport.type === 'stdio'
    ? { command: c.transport.command, args: c.transport.args, ...(c.transport.cwd ? { cwd: c.transport.cwd } : {}),
      ...(Object.keys(c.transport.envRefs).length ? { env: Object.fromEntries(Object.entries(c.transport.envRefs).map(([k, v]) => {
        if (!v.startsWith('env:')) throw new McpSettingsError('此旧配置使用本机凭据文件引用，请保留高级配置。');
        return [k, '${' + v.slice(4) + '}']; })) } : {}), enabled: c.enabled }
    : { url: c.transport.url, type: 'http', enabled: c.enabled,
      ...(c.transport.auth.type === 'bearer' && c.transport.auth.credentialRef.startsWith('env:')
        ? { headers: { Authorization: 'Bearer ${' + c.transport.auth.credentialRef.slice(4) + '}' } } : {}),
      ...(c.transport.auth.type !== 'none' && (c.transport.auth.type !== 'bearer' || !c.transport.auth.credentialRef.startsWith('env:'))
        ? { unsupportedAuthentication: true } : {}) }])) };
}
/** A user-editable mcp.json; the SQLite registry remains a validated execution cache. */
export class McpJsonSettings {
  private loaded: string | undefined;
  private observed: string | undefined;
  private ids: string[] = [];
  private issue: string | undefined;
  constructor(readonly path: string, private readonly registry: McpConnectionRegistry,
    private readonly environment: NodeJS.ProcessEnv = process.env) { this.reload(); }
  private parse(text: string) {
    if (Buffer.byteLength(text) > 256 * 1024) throw new McpSettingsError('MCP JSON 文件过大。');
    let source: unknown; try { source = JSON.parse(text); } catch { throw new McpSettingsError('JSON 格式无效，请粘贴完整的 mcpServers 配置。'); }
    const value = jsonCopy(source) as { mcpServers?: Record<string, { command?: unknown }> };
    for (const entry of Object.values(value?.mcpServers ?? {})) {
      if (entry && typeof entry.command === 'string' && !isAbsolute(entry.command)) {
        const name = entry.command;
        if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new McpSettingsError('启动命令必须是程序名或绝对路径，不能填写 shell 命令。');
        const extensions = process.platform === 'win32' ? (this.environment.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
        const paths = (this.environment.PATH ?? '').split(delimiter).filter(p => p && isAbsolute(p));
        const found = paths.flatMap(p => extensions.map(ext => join(p, name + ext))).find(path => {
          try { accessSync(path, constants.X_OK); return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink(); } catch { return false; }
        });
        if (!found) throw new McpSettingsError(`找不到程序 ${name}，请安装该程序或使用提供方给出的绝对路径。`);
        entry.command = found;
      }
    }
    const preview = previewPiMcpConfig(value);
    if (preview.diagnostics.length) throw new McpSettingsError(`MCP 配置不受支持：第 ${preview.diagnostics[0]!.index + 1} 项的 ${preview.diagnostics[0]!.field}。环境变量使用 \${ENV_NAME} 引用。`);
    return preview.configs;
  }
  reload(): void {
    try {
      let text: string;
      try {
        const stat = lstatSync(this.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new McpSettingsError('MCP 配置文件无效。');
        text = readFileSync(this.path, 'utf8');
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (this.loaded !== undefined) this.registry.applyConfiguration([]);
          this.loaded = undefined; this.observed = undefined; this.ids = []; this.issue = undefined; return; } throw error; }
      this.observed = text;
      if (text === this.loaded && !this.issue) return;
      const configs = this.parse(text); this.registry.applyConfiguration(configs);
      this.ids = configs.map(c => c.serverId); this.loaded = text; this.issue = undefined;
    } catch (error) { this.issue = error instanceof McpSettingsError ? error.message : 'MCP 配置未能保存到运行登记，请检查文件后重试。'; }
  }
  save(text: string): void {
    const configs = this.parse(text), temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(JSON.parse(text), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.path);
      this.registry.applyConfiguration(configs, true);
      this.loaded = readFileSync(this.path, 'utf8'); this.observed = this.loaded; this.ids = configs.map(c => c.serverId); this.issue = undefined;
    } catch (error) { this.issue = '配置已保存但尚未应用，请重新保存后连接。'; throw error; }
    finally { try { unlinkSync(temporary); } catch { /* Renamed or never created. */ } }
  }
  setEnabled(serverId: string, enabled: boolean): void {
    const source = JSON.parse(this.snapshot().text);
    if (!source.mcpServers?.[serverId]) throw new McpSettingsError('配置中没有此服务。');
    source.mcpServers[serverId].enabled = enabled; this.save(JSON.stringify(source));
  }
  snapshot() {
    this.reload();
    let text = this.observed ?? this.loaded ?? '{"mcpServers":{}}';
    if (this.loaded === undefined && this.observed === undefined) {
      try { text = JSON.stringify(standardMcpConfig(this.registry.snapshot().servers.filter(s => !s.revoked).map(s => s.config)), null, 2); } catch { /* Legacy advanced auth stays in its original registry. */ }
    }
    return { text, path: this.path, serverIds: [...this.ids], ...(this.issue ? { error: this.issue } : {}) };
  }
}
