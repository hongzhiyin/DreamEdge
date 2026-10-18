import { spawn } from 'node:child_process';
import { readFile, stat, access, readdir } from 'node:fs/promises';
import { basename, relative, matchesGlob, resolve } from 'node:path';
import { createReadTool, createLsTool, createFindTool, createGrepTool, detectSupportedImageMimeTypeFromFile } from '@earendil-works/pi-coding-agent';
import { cleanToolResult } from '../tools/result.js';
import { piDetails } from './pi-json.js';
import type { ReadToolName } from './read-limits.js';
import type { JsonObject } from '@earendil-works/pi-ai';

async function glob(pattern: string, root: string, options: { ignore: string[]; limit: number }): Promise<string[]> {
  const args = ['--no-config', '--no-ignore-parent', '--no-ignore-global', '--no-require-git', '--files', '--hidden', '-0'];
  for (const ignore of options.ignore) args.push('--glob', `!${ignore}`);
  args.push('--', root);
  const child = spawn(process.env.DREAMEDGE_RG_BINARY!, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = Buffer.alloc(0); let failed = false;
  child.stdout.on('data', (chunk: Buffer) => { output = Buffer.concat([output, chunk]); if (output.length > 1024 * 1024) { failed = true; child.kill('SIGKILL'); } });
  child.stderr.resume();
  await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => {
    if (failed || (code !== 0 && code !== 1)) reject(new Error('搜索表达式无效或搜索进程失败。')); else resolve();
  }); });
  return output.toString('utf8').split('\0').filter(Boolean).filter(path =>
    matchesGlob(pattern.includes('/') ? relative(root, path) : basename(path), pattern)).slice(0, options.limit);
}
async function main() {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 32_768) throw new Error('输入超过限制'); }
  const command = JSON.parse(input) as { name: ReadToolName; args: JsonObject; root: string; target: string };
  const inSnapshot = (path: string) => {
    const value = resolve(path); const root = resolve(command.root);
    if (value !== root && !value.startsWith(`${root}/`)) throw new Error('搜索路径无效'); return value;
  };
  const factory = { read: () => createReadTool(command.root, { autoResizeImages: false, operations: {
      access: path => access(inSnapshot(path)), readFile: path => readFile(inSnapshot(path)),
      detectImageMimeType: path => detectSupportedImageMimeTypeFromFile(inSnapshot(path)) } }),
    ls: () => createLsTool(command.root, { operations: { exists: async path => { await access(inSnapshot(path)); return true; },
      stat: path => stat(inSnapshot(path)), readdir: path => readdir(inSnapshot(path)) } }), find: () => createFindTool(command.root, { operations: {
      exists: async path => { await access(inSnapshot(path)); return true; }, glob } }),
    grep: () => createGrepTool(command.root, { operations: { isDirectory: async path => (await stat(inSnapshot(path))).isDirectory(),
      readFile: path => readFile(inSnapshot(path), 'utf8') } }) };
  const tool = factory[command.name](); const result = await tool.execute('snapshot-call', { ...command.args, path: command.target });
  const clean = cleanToolResult({ content: result.content, details: piDetails(result.details) });
  if (result.isError || result.terminate) throw new Error('Pi 文件工具返回失败。');
  process.stdout.write(JSON.stringify({ ok: true, result: clean }));
}
void main().catch(() => { process.stdout.write(JSON.stringify({ ok: false, error: 'Pi 读取或搜索失败，请检查表达式及窗口参数。' })); process.exitCode = 1; });
