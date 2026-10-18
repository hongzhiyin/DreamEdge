import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ToolExecutionContext } from '../tools/types.js';
import type { FileScopeService } from './scope-service.js';
import type { OperationName, OperationPreview } from './operation-types.js';
import { treeManifest } from './tree-manifest.js';
import { containsPath, fileIdentity } from './scope-paths.js';
import { NoFileEffectError } from './mutation-types.js';
import { argumentsDigest, freezeDeep } from '../tools/json.js';
import { mutationDigest } from './mutation-digest.js';

async function noFinalLink(scopes: FileScopeService, ctx: ToolExecutionContext, input: string) {
  const roots = scopes.roots(ctx.sessionId); const base = roots[0]?.device?.baseDirectory ?? roots[0]?.path;
  if (!base) throw new NoFileEffectError('没有可用的文件访问策略。');
  const expanded = input === '~' || input.startsWith('~/') ? resolve(base, input.slice(2) || '.') : input;
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
  try { if ((await lstat(path)).isSymbolicLink()) throw new NoFileEffectError('结构变更不跟随符号链接，请指定真实路径。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function previewOperation(scopes: FileScopeService, name: OperationName, args: JsonObject,
  context: ToolExecutionContext): Promise<OperationPreview> {
  if (typeof args.path !== 'string') throw new NoFileEffectError('文件路径无效。');
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]);
  await noFinalLink(scopes, context, args.path);
  const binding = name === 'copy' ? await scopes.bindRead(context, args.path) : await scopes.bindWrite(context, args.path);
  if (binding.path === parse(binding.path).root || binding.path === resolve(homedir())) throw new NoFileEffectError('不能对文件系统根目录或账户主目录执行结构变更。');
  const target = await scopes.verify(binding); const parentIdentity = fileIdentity(await lstat(dirname(binding.path), { bigint: true }));
  if (name === 'mkdir' ? Boolean(target.stat) : !target.stat) throw new NoFileEffectError(name === 'mkdir' ? '创建目录不能覆盖已有对象。' : '操作对象不存在。');
  const tree = name === 'mkdir' ? undefined : await treeManifest(scopes, binding, signal);
  let destination: OperationPreview['destination'];
  if (name === 'move' || name === 'copy') {
    if (typeof args.destination !== 'string') throw new NoFileEffectError('缺少目标路径。');
    await noFinalLink(scopes, context, args.destination);
    const next = await scopes.bindWrite(context, args.destination);
    if (containsPath(binding.path, next.path) || containsPath(next.path, binding.path) || (await scopes.verify(next)).stat) {
      throw new NoFileEffectError('源与目标不能重叠，目标必须不存在。');
    }
    destination = { binding: next, parentIdentity: fileIdentity(await lstat(dirname(next.path), { bigint: true })) };
  }
  signal.throwIfAborted();
  const base = { kind: 'file_operation' as const, planId: randomUUID(), binding, parentIdentity, path: binding.path,
    argsDigest: argumentsDigest(args), policyVersion: binding.policyVersion, createdAt: Date.now(),
    operation: name === 'delete' ? args.permanent === true ? 'delete' as const : 'trash' as const : name,
    ...(tree ? { tree } : {}), ...(destination ? { destination } : {}) };
  return freezeDeep({ ...base, planDigest: mutationDigest(base) });
}
