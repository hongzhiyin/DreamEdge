import { previewPaths } from '../files/preview.js';
import { containsPath } from '../files/scope-paths.js';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, freezeDeep } from './json.js';
import type { FileBatchPlan } from './batch-types.js';
import type { PreparedTool } from '../runtime/tool-preparation.js';

export function batchDigest(plan: Omit<FileBatchPlan, 'digest'>): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex');
}
export function fileBatchPlan(prepared: readonly PreparedTool[]): FileBatchPlan {
  if (!prepared.length || prepared.length > 64) throw new Error('Invalid batch size');
  const first = prepared[0]!.call;
  const members = prepared.map(({ call, inspection }) => {
    const p = call.preview;
    if (!p || !inspection || inspection.decision === 'deny' || call.sessionId !== first.sessionId
      || call.runId !== first.runId || call.turnId !== first.turnId) throw new Error('Invalid batch member');
    return { toolCallId: call.toolCallId, toolName: call.toolName, toolVersion: call.toolVersion, argsDigest: call.argsDigest,
      path: p.path, paths: previewPaths(p), file: { planId: p.planId, planDigest: p.planDigest, policyVersion: p.policyVersion }, inspection };
  });
  for (let i = 0; i < members.length; i++) for (const other of members.slice(i + 1)) {
    if (members[i]!.paths.some(a => other.paths.some(b => containsPath(a, b) || containsPath(b, a)))) throw new Error('Overlapping batch targets');
  }
  if (prepared.reduce((n, p) => n + Buffer.byteLength(JSON.stringify(p.call.preview)), 0) > 512 * 1024
    || prepared.reduce((n, p) => n + Buffer.byteLength(canonicalJson(p.call.args)), 0) > 512 * 1024) throw new Error('Batch exceeds preview budget');
  const base = { batchId: randomUUID(), sessionId: first.sessionId, runId: first.runId, turnId: first.turnId, members };
  return freezeDeep({ ...base, digest: batchDigest(base) });
}
