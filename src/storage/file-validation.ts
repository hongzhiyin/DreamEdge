import { isFileTool } from '../files/managed-tools.js';
import type { StoredConversation } from './types.js';
import type { JsonObject } from '@earendil-works/pi-ai';
import { containsPath, excluded, sameIdentity } from '../files/scope-paths.js';
import { fileDestination } from '../files/scope-types.js';
import { sameDestination } from '../files/scope-validation.js';
import type { FileDestination } from '../files/scope-types.js';
import { SessionStoreError } from './types.js';

export function validateFileSources(snapshot: StoredConversation): void {
  for (const run of snapshot.runs) for (const call of run.toolCalls ?? []) {
    if (call.preview) {
      const p = call.preview;
      for (const binding of [p.binding, ...(p.kind === 'file_operation' && p.destination ? [p.destination.binding] : [])]) {
        const g = snapshot.session.fileScope?.grants.find(g => g.grantId === binding.grantId);
        if (!g || (binding.mode === 'write' && g.mode !== 'read-write') || g.rootId !== binding.rootId || g.path !== binding.root
          || !sameIdentity(g.identity, binding.rootIdentity) || !containsPath(g.path, binding.path) || excluded(g, binding.path)
          || p.policyVersion > snapshot.session.fileScope!.policyVersion || !sameDestination(g.destination, binding.destination)
          || !sameDestination(binding.destination, fileDestination(run.modelConfigSnapshot))) {
          throw new SessionStoreError('INVALID_DATA', '变更预览与访问绑定不一致。');
        }
      }
    }
    if (call.status !== 'succeeded' || !isFileTool(call.toolVersion)) continue;
    const access = (call.result.details as JsonObject).fileAccess as JsonObject;
    const grant = snapshot.session.fileScope?.grants.find(g => g.grantId === access.grantId);
    if (!grant || access.rootId !== grant.rootId || !containsPath(grant.path, String(access.path)) || excluded(grant, String(access.path))
      || Number(access.policyVersion) > snapshot.session.fileScope!.policyVersion
      || !sameDestination(grant.destination, access.destination as unknown as FileDestination)) {
      throw new SessionStoreError('INVALID_DATA', '文件工具来源与目录授权不一致。');
    }
  }
}
