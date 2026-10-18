import type { ModelConnectionConfig } from '../model/types.js';
import type { ToolCallIdentity } from '../tools/types.js';

export interface FileIdentity { device: string; inode: string }
export interface FileDestination { connectionId: string; protocol: string; baseUrl: string; model: string }
export interface FileScopeGrant {
  grantId: string; sessionId: string; rootId: string; path: string; identity: FileIdentity;
  mode: 'read' | 'read-write'; excludes: string[]; destination: FileDestination;
  remember: boolean; createdAt: number; expiresAt?: number; revokedAt?: number;
  device?: { baseDirectory: string };
}
export interface DeviceAccessPolicy { mode?: 'account'; protectedWritePaths?: readonly string[]; roots: readonly { path: string; identity: FileIdentity }[]; baseDirectory: string }
export interface FileVersion extends FileIdentity { size: string; modifiedNs: string; changedNs: string; sha256: string }
export interface FileObservation {
  observationId: string; grantId: string; rootId: string; policyVersion: number; path: string;
  destination: FileDestination; version: FileVersion; observedAt: number;
  source: ToolCallIdentity; complete: boolean;
}
export interface FileScopeState { policyVersion: number; grants: FileScopeGrant[]; observations: FileObservation[] }
/** Renderer overview omits filesystem identities and observation history. */
export interface FileScopeOverview {
  policyVersion: number; destination: FileDestination;
  grants: Omit<FileScopeGrant, 'identity' | 'rootId'>[];
  device?: { available: boolean; enabled: boolean; baseDirectory?: string; mode?: 'account' };
}
export interface FileGrantOptions {
  mode: 'read' | 'read-write'; remember: boolean; excludes?: string[]; expiresAt?: number;
}
export interface FileAccessBinding extends ToolCallIdentity {
  grantId: string; rootId: string; policyVersion: number; root: string; path: string;
  mode: 'read' | 'write'; destination: FileDestination; rootIdentity: FileIdentity;
}
/** Only the trusted host supplies this callback. Paths are not accepted from the renderer/model. */
export type DirectoryPicker = (sessionId: string, options: FileGrantOptions) => Promise<string | undefined>;
export class FileScopeError extends Error {
  constructor(readonly code: 'FILE_SCOPE_DENIED' | 'FILE_SCOPE_STALE' | 'FILE_SCOPE_INVALID'
    | 'FILE_SCOPE_SAVE_FAILED' | 'FILE_CHANGED' | 'FILE_TOO_LARGE' | 'FILE_IO_FAILED', message: string) {
    super(message); this.name = 'FileScopeError';
  }
}
export const emptyFileScope = (): FileScopeState => ({ policyVersion: 0, grants: [], observations: [] });
export function fileDestination(config: ModelConnectionConfig): FileDestination {
  return { connectionId: config.id, protocol: config.protocol, baseUrl: new URL(config.baseUrl).href, model: config.model };
}
