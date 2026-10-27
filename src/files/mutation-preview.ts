import type { AgentTool } from '@earendil-works/pi-agent-core';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ToolExecutionContext } from '../tools/types.js';
import type { FileScopeService } from './scope-service.js';
import { readScopedFile } from './scoped-read.js';
import { fileIdentity } from './scope-paths.js';
import { argumentsDigest, freezeDeep } from '../tools/json.js';
import { contentHash, mutationDigest } from './mutation-digest.js';
import { dshFileBackend } from './dsh-backend.js';
import { NoFileEffectError } from './mutation-types.js';
import type { MutationName, MutationPlan, MutationPreview } from './mutation-types.js';

export async function previewMutation(scopes: FileScopeService, name: MutationName, args: JsonObject,
  context: ToolExecutionContext): Promise<MutationPlan> {
  context.signal.throwIfAborted();
  if (typeof args.path !== 'string') throw new NoFileEffectError('文件路径无效。');
  const binding = await scopes.bindWrite(context, args.path); const target = await scopes.verify(binding);
  const parentIdentity = fileIdentity(await lstat(dirname(binding.path), { bigint: true }));
  let original: Buffer = Buffer.alloc(0); let before: MutationPreview['before'] = { kind: 'absent' };
  if (target.stat) {
    const captured = await readScopedFile(scopes, { ...binding, mode: 'read' }, context.signal, 4 * 1024 * 1024, false);
    original = captured.data;
    if (!scopes.wasObserved(context.sessionId, binding.path, captured.observation.version, name === 'write')) {
      throw new NoFileEffectError(name === 'write' ? '覆盖文件前必须完整读取当前版本。' : '编辑前必须读取当前文件版本。');
    }
    const backend = dshFileBackend();
    try {
      const info = await backend.filesystem.stat(await backend.filesystem.resolve(binding.path));
      if (!info?.version) throw new NoFileEffectError('文件版本已变化，请重新读取。');
      before = { kind: 'present', version: captured.observation.version, dshVersion: info.version };
    } finally { await backend.dispose(); }
  } else if (name === 'edit') throw new NoFileEffectError('编辑目标不存在。');
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(original); if (decoded.includes('\0')) throw 0; }
  catch { throw new NoFileEffectError('变更仅支持有效 UTF-8 文本。'); }
  const pi = await import('@earendil-works/pi-coding-agent'); let content: string | undefined; let patch = '';
  const virtualPath = join(binding.root, '__dreamedge_preview__', randomUUID(), 'target');
  const pathOnly = (path: string) => { if (path !== virtualPath) throw new NoFileEffectError('Pi 变更路径绑定不匹配。'); };
  const capture = async (path: string, value: string) => {
    pathOnly(path); if (value.includes('\0') || Buffer.byteLength(value) > 4 * 1024 * 1024) throw new NoFileEffectError('变更内容超过限制或含有二进制内容。');
    content = value;
  };
  try {
    const tool: AgentTool = name === 'write' ? pi.createWriteTool(binding.root, { operations: { writeFile: capture,
      mkdir: async path => { if (path !== dirname(virtualPath)) throw new NoFileEffectError('变更不能创建未授权父目录。'); } } })
      : pi.createEditTool(binding.root, { operations: { access: async path => pathOnly(path),
        readFile: async path => { pathOnly(path); return Buffer.from(original); }, writeFile: capture } });
    const result = await tool.execute(context.toolCallId, { ...args, path: virtualPath }, context.signal);
    if (content === undefined) throw 0;
    patch = name === 'edit' ? String((result.details as { patch?: string })?.patch ?? '').split(virtualPath).join(binding.path)
      : pi.generateUnifiedPatch(binding.path, decoded, content);
  } catch (error) { if (error instanceof NoFileEffectError) throw error; throw new NoFileEffectError('Pi 变更匹配失败；未修改文件。', 'TOOL_FAILED'); }
  if (Buffer.byteLength(patch) > 128 * 1024) throw new NoFileEffectError('变更差异超过预览上限，请缩小修改范围。');
  await scopes.verify(binding); context.signal.throwIfAborted();
  const base: Omit<MutationPreview, 'planDigest'> = { kind: 'file_mutation', planId: randomUUID(), binding,
    policyVersion: binding.policyVersion, path: binding.path, argsDigest: argumentsDigest(args), parentIdentity, before,
    operation: name === 'edit' ? 'edit' : before.kind === 'absent' ? 'create' : 'overwrite',
    afterSha256: contentHash(content!), afterBytes: Buffer.byteLength(content!), patch, createdAt: Date.now() };
  return { preview: freezeDeep({ ...base, planDigest: mutationDigest(base) }), content: content!, original,
    args: structuredClone(args), claimed: false };
}
