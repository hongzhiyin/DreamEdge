import type { DependencyLock } from './dependencies.js';
export interface ProjectDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  appName?: string;
  appId: string;
  version: string;
  source: 'src';
  dependencies: Record<string, string>;
  dependencyLock?: DependencyLock;
  build: { kind: 'web'; entry: 'index.html' };
  savedAt: string;
}
export interface WorkspaceProject {
  definition: ProjectDefinition;
  rootDirectory: string;
  sourceDirectory: string;
  dataDirectory: string;
  buildDirectory: string;
  sessionsDirectory: string;
}
export interface WorkspaceStatus {
  project: WorkspaceProject | null;
  recoveryError: string | null;
}
export interface WorkspaceFile { path: string; content: string; hash: string }
export type WorkspaceRequest =
  | { operation: 'current' }
  | { operation: 'create'; directory: string; name: string }
  | { operation: 'open'; directory: string }
  | { operation: 'close' }
  | { operation: 'save'; projectId: string; name?: string; appName?: string; appId?: string; version?: string; expectedDefinitionHash?: string }
  | { operation: 'listFiles'; projectId: string }
  | { operation: 'readFile'; projectId: string; path: string }
  | { operation: 'writeFile'; projectId: string; path: string; content: string; expectedHash: string | null };
export type WorkspaceResult = WorkspaceStatus | WorkspaceProject | WorkspaceFile | string[];
