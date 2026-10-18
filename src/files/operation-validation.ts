import { isAbsolute, normalize } from 'node:path';
import type { ToolCallRecord } from '../tools/types.js';
import type { OperationPreview } from './operation-types.js';
import { operationVersion } from './operation-types.js';
import { contentHash, mutationDigest } from './mutation-digest.js';
import { canonicalJson } from '../tools/json.js';

function invalid(): never { throw new Error('Invalid structural operation plan'); }
export function validateOperationPreview(call: ToolCallRecord, p: OperationPreview): void {
  const identity = (v: { device: string; inode: string }) => v && /^\d+$/.test(v.device) && /^\d+$/.test(v.inode);
  const expected = call.toolName === 'delete' ? call.args.permanent === true ? 'delete' : 'trash' : call.toolName;
  if (call.toolVersion !== operationVersion || call.effect !== 'write' || call.approval !== 'always'
    || !['trash', 'delete', 'copy', 'move', 'mkdir'].includes(p.operation) || p.operation !== expected
    || !p.planId || p.argsDigest !== call.argsDigest || !Number.isFinite(p.createdAt)
    || !p.binding || p.path !== p.binding.path || !isAbsolute(p.path) || normalize(p.path) !== p.path
    || !Number.isSafeInteger(p.policyVersion) || p.policyVersion < 0 || p.binding.policyVersion !== p.policyVersion
    || !identity(p.parentIdentity) || mutationDigest(p) !== p.planDigest) invalid();
  const bindings = [p.binding, ...(p.destination ? [p.destination.binding] : [])];
  if (bindings.some(b => !['sessionId', 'runId', 'turnId', 'toolCallId'].every(key => b[key as keyof typeof b] === call[key as keyof ToolCallRecord])
    || b.policyVersion !== p.policyVersion || !identity(b.rootIdentity) || !isAbsolute(b.path) || normalize(b.path) !== b.path)) invalid();
  if (p.binding.mode !== (p.operation === 'copy' ? 'read' : 'write')
    || Boolean(p.destination) !== ['copy', 'move'].includes(p.operation)
    || (p.destination && (p.destination.binding.mode !== 'write' || !identity(p.destination.parentIdentity)))) invalid();
  if (p.operation === 'mkdir') { if (p.tree) invalid(); return; }
  const tree = p.tree;
  if (!tree || !Array.isArray(tree.entries) || !tree.entries.length || tree.entries.length > 1024
    || tree.entries[0]!.relative !== '' || new Set(tree.entries.map(e => e.relative)).size !== tree.entries.length
    || !Number.isSafeInteger(tree.bytes) || tree.bytes < 0 || tree.bytes > 1024 * 1024 * 1024
    || contentHash(canonicalJson(tree.entries)) !== tree.digest) invalid();
  for (const entry of tree.entries) {
    if (typeof entry.relative !== 'string' || entry.relative.includes('\0') || entry.relative.includes('\\')
      || entry.relative.startsWith('/') || entry.relative.split('/').some((s: string) => s === '..' || s === '.')
      || !['file', 'directory'].includes(entry.kind) || !identity(entry)
      || !['size', 'modifiedNs', 'changedNs'].every(k => /^\d+$/.test(String(entry[k as keyof typeof entry])))
      || (entry.kind === 'file' && !/^[0-9a-f]{64}$/.test(entry.hash ?? ''))) invalid();
  }
  if (tree.bytes !== tree.entries.filter(e => e.kind === 'file').reduce((n, e) => n + Number(e.size), 0)) invalid();
}
