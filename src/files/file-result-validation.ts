import { isFileTool, isMutationName } from './managed-tools.js';
import { operationVersion } from './operation-types.js';
import { accountMutationVersion } from './mutation-policy.js';
import { mutationVersion } from './mutation-types.js';
import type { ToolCallRecord } from '../tools/types.js';
import type { ModelConnectionConfig } from '../model/types.js';
import type { JsonObject } from '@earendil-works/pi-ai';
import { isAbsolute, normalize } from 'node:path';
import { containsPath } from './scope-paths.js';
import { fileDestination } from './scope-types.js';
import { sameDestination } from './scope-validation.js';
import { readToolNames } from './read-limits.js';

export function validateFileResult(call: ToolCallRecord, config: ModelConnectionConfig): void {
  if (call.status !== 'succeeded' || !isFileTool(call.toolVersion)) return;
  if (!readToolNames.includes(call.toolName as never) && !isMutationName(call.toolName)) throw new Error('Unknown scoped file tool');
  const access = (call.result.details as JsonObject)?.fileAccess as JsonObject | undefined;
  if (!access || access.format !== 'dreamedge-file-result/v1' || typeof access.grantId !== 'string'
    || !access.grantId || typeof access.rootId !== 'string' || !access.rootId || !Number.isSafeInteger(access.policyVersion) || Number(access.policyVersion) < 0
    || typeof access.path !== 'string' || !isAbsolute(access.path) || normalize(access.path) !== access.path
    || !sameDestination(access.destination as unknown as ReturnType<typeof fileDestination>, fileDestination(config))
    || !['entries', 'bytes', 'skipped'].every(key => Number.isSafeInteger(access[key]) && Number(access[key]) >= 0)
    || !Array.isArray(access.files) || access.files.length > 1024) throw new Error('Invalid file provenance');
  if ([mutationVersion, accountMutationVersion].includes(call.toolVersion)) {
    const receipt = (call.result.details as JsonObject).fileMutation as JsonObject;
    if (!call.preview || receipt?.commit !== 'confirmed' || receipt.planId !== call.preview.planId
      || receipt.planDigest !== call.preview.planDigest || typeof receipt.verified !== 'boolean') throw new Error('Invalid mutation receipt');
  }
  if (call.toolVersion === operationVersion) {
    const receipt = (call.result.details as JsonObject).fileOperation as JsonObject;
    if (call.preview?.kind !== 'file_operation' || receipt?.commit !== 'confirmed' || receipt.planId !== call.preview.planId
      || receipt.planDigest !== call.preview.planDigest || receipt.operation !== call.preview.operation || receipt.path !== call.preview.path
      || receipt.destination !== call.preview.destination?.binding.path) throw new Error('Invalid operation receipt');
  }
  for (const source of access.files) {
    const file = source as JsonObject; const version = file.version as JsonObject;
    if (typeof file.path !== 'string' || !containsPath(access.path, file.path) || typeof file.complete !== 'boolean'
      || !version || !['device', 'inode', 'size', 'modifiedNs', 'changedNs'].every(key => typeof version[key] === 'string' && /^\d+$/.test(String(version[key])))
      || typeof version.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(version.sha256)) throw new Error('Invalid file version');
  }
}
