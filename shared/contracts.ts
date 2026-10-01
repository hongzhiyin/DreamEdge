export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ToolManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  entry: string;
  capabilities: string[];
}

export interface StoredRecord {
  id: string;
  value: Json;
}

export type StorageRequest =
  | { operation: 'list'; collection: string }
  | { operation: 'put'; collection: string; id: string; value: Json }
  | { operation: 'remove'; collection: string; id: string };

export interface HostApi {
  tools(): Promise<ToolManifest[]>;
  storage(toolId: string, request: StorageRequest): Promise<StoredRecord[] | void>;
}

export const SHELL_URL = 'ideadock://shell/index.html';
export const SHELL_ORIGIN = 'ideadock://shell';
export const TOOL_CHANNEL = 'ideadock:storage';
