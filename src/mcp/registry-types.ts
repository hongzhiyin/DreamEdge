import type { McpConnectionIdentity, McpServerConfig } from './types.js';
export interface McpRegistration {
  config: McpServerConfig;
  revoked: boolean;
  /** Connection permission only; never authorizes resources or tools. */
  approval?: { identity: McpConnectionIdentity; approvedAt: number };
}
export interface McpAppScope { appId: string; profileRef?: string }
export interface McpAssociation extends McpAppScope { serverId: string }
export interface McpSessionBinding { sessionId: string; identity: McpConnectionIdentity; scope?: McpAppScope }
export interface McpRegistryState {
  format: 'dreamedge-mcp-registry/v1'; revision: number;
  servers: McpRegistration[]; associations: McpAssociation[]; bindings: McpSessionBinding[];
}
export interface McpRegistryStore {
  load(): McpRegistryState;
  save(state: McpRegistryState, expectedRevision: number): void;
  close(): void;
}
/** Provenance must be assigned by a trusted host integration, never accepted from page JSON. */
export interface McpAppContext extends McpAppScope {
  source: 'user-selection' | 'host-window' | 'provider' | 'untrusted';
  capturedAt: number;
  windowRef?: string; resourceRef?: string; contextRevision?: string; connectionRef?: string;
}
export interface McpCandidate {
  identity: McpConnectionIdentity; displayName: string;
  connectionPermission: 'approved' | 'approval-required';
}
export type McpResolution =
  | { kind: 'selected'; via: 'session' | 'reference' | 'application'; candidate: McpCandidate; context?: McpAppContext }
  | { kind: 'choice'; candidates: McpCandidate[] }
  | { kind: 'unmatched' }
  | { kind: 'blocked'; reason: 'context-required' | 'untrusted-context' | 'stale-context' | 'context-changed'
    | 'stale-binding' | 'missing-server' | 'disabled' | 'revoked' | 'denied' | 'unassociated-reference' | 'unavailable' };
