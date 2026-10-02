export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
import type { WorkspaceRequest, WorkspaceResult } from './workspace.js';
import type { DevelopmentRequest, DevelopmentResult } from './development.js';
export type * from './development.js';
export type { ProjectDefinition, WorkspaceProject, WorkspaceStatus, WorkspaceFile, WorkspaceRequest, WorkspaceResult } from './workspace.js';
export interface ToolManifest {
  id: string; name: string; description: string; version: string; entry: string; capabilities: string[];
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
export interface HostApi {
  development(request: DevelopmentRequest): Promise<DevelopmentResult>;
  workspace(request: WorkspaceRequest): Promise<WorkspaceResult>;
  info(): Promise<AppManifest>;
  tools(): Promise<ToolManifest[]>;
  storage(toolId: string, request: StorageRequest): Promise<StoredRecord[] | void>;
  service(toolId: string, service: string, method: string, input: Json): Promise<Json>;
}
export const SHELL_URL = 'dreamedge://shell/index.html';
export const SHELL_ORIGIN = 'dreamedge://shell';
export const TOOL_CHANNEL = 'dreamedge:bridge';
