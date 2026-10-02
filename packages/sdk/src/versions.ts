import type { ProjectDefinition } from './workspace.js';

export interface ProjectVersion {
  schemaVersion: 1; id: string; projectId: string; operationId: string; label: string; createdAt: string;
  kind: 'checkpoint' | 'saved' | 'restored'; buildId: string | null; restoredFrom: string | null;
  definition: ProjectDefinition; sourceHashes: Record<string, string>;
}
export interface VersionStatus { stateHash: string; head: string | null; versions: ProjectVersion[] }
export interface VersionOperation {
  schemaVersion: 1; id: string; projectId: string; kind: 'confirm' | 'restore';
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string; finishedAt: string | null; versionId: string | null; checkpointId: string | null; error: string | null;
}
export type VersionRequest =
  | { operation: 'status'; projectId: string }
  | { operation: 'confirm'; projectId: string; buildId: string; label: string; version?: string }
  | { operation: 'restore'; projectId: string; versionId: string; expectedStateHash: string; label: string }
  | { operation: 'getOperation'; projectId: string; operationId: string }
  | { operation: 'cancel'; projectId: string; operationId: string };
export type VersionResult = VersionStatus | VersionOperation;
