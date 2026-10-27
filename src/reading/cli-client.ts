import { spawn } from 'node:child_process';
import type { ReaderClient, ReaderInput, ReaderReply } from './protocol.js';
import { failure } from './protocol.js';
const operations = new Set(['sessions.list', 'context.get', 'page.read', 'citations.list', 'citation.create', 'citation.locate',
  'reader.navigate', 'reader.return', 'notes.create', 'notes.list', 'notes.get', 'notes.update', 'requests.get']);
/** Fixed executable and operation whitelist; no shell, token reads or provider credentials in argv. */
export class ReaderCli implements ReaderClient {
  constructor(private readonly executable: string | undefined, private readonly prefixArgs: readonly string[] = []) {}
  call(operation: string, input: ReaderInput, signal: AbortSignal): Promise<ReaderReply> {
    if (!this.executable || !operations.has(operation)) return Promise.resolve(failure('UNAVAILABLE', '阅读器程序未配置或操作未开放。'));
    if (signal.aborted) return Promise.resolve(failure('CANCELLED', '阅读器请求已停止。'));
    return new Promise(resolve => {
      const env = { ...process.env }; delete env.RG_BRIDGE_CONFIG;
      if (process.env.DREAMEDGE_READER_CONFIG) env.RG_BRIDGE_CONFIG = process.env.DREAMEDGE_READER_CONFIG;
      const child = spawn(this.executable!, [...this.prefixArgs, 'call', operation, '--input', '-'], { stdio: ['pipe', 'pipe', 'ignore'], env, windowsHide: true });
      let result = '', ended = false;
      const finish = (reply: ReaderReply) => { if (ended) return; ended = true; clearTimeout(timer);
        signal.removeEventListener('abort', cancel); resolve(reply); };
      const cancel = () => { child.kill('SIGTERM'); finish(failure('CANCELLED', '阅读器请求已停止，写入结果需核对。')); };
      const timer = setTimeout(() => { child.kill('SIGTERM'); finish(failure('TIMEOUT', '阅读器请求超时，写入结果需核对。')); }, 25_000);
      child.on('error', () => finish(failure('UNAVAILABLE', '无法启动阅读器能力接口。')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { result += chunk;
        if (Buffer.byteLength(result) > 512 * 1024) { child.kill('SIGTERM'); finish(failure('INVALID_RESULT', '阅读器返回内容超过限制。')); } });
      child.stdin.on('error', () => {});
      child.on('close', () => {
        try { const reply = JSON.parse(result) as ReaderReply;
          if (!reply || (reply.ok !== true && reply.ok !== false)) throw 0;
          if (!reply.ok && (!reply.error || typeof reply.error.code !== 'string' || typeof reply.error.message !== 'string')) throw 0;
          finish(reply);
        } catch { finish(failure('INVALID_RESULT', '阅读器未返回有效结果。')); }
      });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel(); else child.stdin.end(JSON.stringify(input));
    });
  }
}
