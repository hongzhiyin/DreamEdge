import type { FileAccessBinding, FileIdentity } from './scope-types.js';
import type { MutationReference } from './mutation-types.js';
export const operationVersion = 'dreamedge/file-operations-1';
export const operationNames = ['delete', 'move', 'copy', 'mkdir'] as const;
export type OperationName = typeof operationNames[number];
export interface TreeEntry {
  relative: string; kind: 'file' | 'directory'; device: string; inode: string;
  size: string; modifiedNs: string; changedNs: string; hash?: string;
}
export interface TreeManifest { entries: readonly TreeEntry[]; bytes: number; digest: string }
export interface OperationPreview extends MutationReference {
  kind: 'file_operation'; operation: 'trash' | 'delete' | 'move' | 'copy' | 'mkdir';
  path: string; binding: FileAccessBinding; parentIdentity: FileIdentity; argsDigest: string; createdAt: number;
  tree?: TreeManifest;
  destination?: { binding: FileAccessBinding; parentIdentity: FileIdentity };
}
export interface OperationHost {
  trash(path: string): Promise<void>;
  beforeCommit?(): Promise<void>;
  afterCommit?(): Promise<void>;
}
