export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ToolManifest {
  id: string; name: string; description: string; version: string; entry: string; capabilities: string[];
}
export interface AppManifest extends ToolManifest {
  appId: string;
  renderer: string;
  services?: Record<string, { entry: string; methods: string[] }>;
}
export interface StoredRecord { id: string; value: Json }
export type StorageRequest =
  | { operation: 'list'; collection: string }
  | { operation: 'put'; collection: string; id: string; value: Json }
  | { operation: 'remove'; collection: string; id: string };
export type BridgeRequest =
  | { kind: 'storage'; payload: StorageRequest }
  | { kind: 'service'; service: string; method: string; input: Json };
export interface HostApi {
  info(): Promise<AppManifest>;
  tools(): Promise<ToolManifest[]>;
  storage(toolId: string, request: StorageRequest): Promise<StoredRecord[] | void>;
  service(toolId: string, service: string, method: string, input: Json): Promise<Json>;
}
export const SHELL_URL = 'dreamedge://shell/index.html';
export const SHELL_ORIGIN = 'dreamedge://shell';
export const TOOL_CHANNEL = 'dreamedge:bridge';
