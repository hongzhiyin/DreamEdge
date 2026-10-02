import { compile } from './compiler';
import { BuildFailure, type BuildInput } from './types';
import { stop } from 'esbuild';

async function main() {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 56 * 1024 * 1024) throw new Error('构建输入过大。');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BuildInput;
  const result = await compile(input);
  process.stdout.write(JSON.stringify({ ok: true, result }));
}
void main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, logs: error instanceof BuildFailure ? error.logs : [{ level: 'error', message: '构建进程输入无效。' }] }));
}).finally(() => stop());
