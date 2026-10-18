import type { FileAccessBinding, FileIdentity, FileVersion } from './scope-types.js';
import type { JsonObject } from '@earendil-works/pi-ai';
export type MutationName = 'write' | 'edit';
export interface MutationReference { planId: string; planDigest: string; policyVersion: number }
export interface MutationPreview extends MutationReference {
  kind: 'file_mutation'; path: string; operation: 'create' | 'overwrite' | 'edit';
  binding: FileAccessBinding; argsDigest: string; parentIdentity: FileIdentity;
  before: { kind: 'absent' } | { kind: 'present'; version: FileVersion; dshVersion: string };
  afterSha256: string; afterBytes: number; patch: string; createdAt: number;
}
export interface MutationPlan { preview: MutationPreview; content: string; original: Buffer; args: JsonObject; claimed: boolean }
export class NoFileEffectError extends Error {
  constructor(message: string, readonly code: 'DENIED' | 'TOOL_FAILED' = 'DENIED') { super(message); this.name = 'NoFileEffectError'; }
}
export const mutationVersion = 'pi-1.1.0/scoped-mutation-1';
export const mutationToolNames = ['write', 'edit'] as const;
