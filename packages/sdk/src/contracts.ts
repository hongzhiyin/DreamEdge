export type * from './model-settings.js';
export type * from './dependencies.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
import type { WorkspaceRequest, WorkspaceResult } from './workspace.js';
import type { DevelopmentRequest, DevelopmentResult } from './development.js';
import type { CandidateBuildRequest, CandidateBuildResult } from './build.js';
import type { VersionRequest, VersionResult } from './versions.js';
import type { ProjectAction, ProjectWindow, WindowRequest, WindowResult } from './windows.js';
export type * from './windows.js';
export type * from './versions.js';
export type * from './build.js';
export type * from './development.js';
export type { ProjectDefinition, WorkspaceProject, WorkspaceStatus, WorkspaceFile, WorkspaceRequest, WorkspaceResult } from './workspace.js';
export interface ToolManifest {
  id: string; name: string; description: string; version: string; entry: string; capabilities: string[];
  contextId?: string;
}
export interface AppManifest extends ToolManifest {
  appId: string;
  renderer: string;
  services?: Record<string, { entry: string; methods: string[] }>;
}
export interface StoredRecord { id: string; value: Json }
export interface StorageClient {
  list(collection: string): Promise<StoredRecord[]>;
  put(collection: string, id: string, value: Json): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
}
export type StorageRequest =
  | { operation: 'list'; collection: string }
  | { operation: 'put'; collection: string; id: string; value: Json }
  | { operation: 'remove'; collection: string; id: string };
export type BridgeRequest =
  | { kind: 'storage'; payload: StorageRequest }
  | { kind: 'service'; service: string; method: string; input: Json };
import type { ModelSettingsRequest, ModelSettingsResult } from './model-settings.js';
export interface HostApi {
  modelSettings(request: ModelSettingsRequest): Promise<ModelSettingsResult>;
  onModelSettingsChanged(listener: () => void): () => void;
  projectAction(action: ProjectAction): Promise<ProjectWindow | null>;
  windows(request: WindowRequest): Promise<WindowResult>;
  onContextChanged(listener: () => void): () => void;
  versions(request: VersionRequest): Promise<VersionResult>;
  build(request: CandidateBuildRequest): Promise<CandidateBuildResult>;
  development(request: DevelopmentRequest): Promise<DevelopmentResult>;
  workspace(request: WorkspaceRequest): Promise<WorkspaceResult>;
  info(): Promise<AppManifest>;
  tools(): Promise<ToolManifest[]>;
  storage(toolId: string, request: StorageRequest, contextId?: string): Promise<StoredRecord[] | void>;
  service(toolId: string, service: string, method: string, input: Json, contextId?: string): Promise<Json>;
}
export const SHELL_URL = 'dreamedge://shell/index.html';
export const SHELL_ORIGIN = 'dreamedge://shell';
export const TOOL_CHANNEL = 'dreamedge:bridge';
