import type { McpFetch, McpTransport, Tool, Resource, ResourceTemplate, Implementation, ServerCapabilities } from '@earendil-works/pi-mcp';
import type { OAuthClientProvider } from '@earendil-works/pi-mcp/oauth';
import type { CredentialResolver } from '../model/types.js';
import type { McpConnectionIdentity, McpServerConfig } from './types.js';
export interface McpCatalogTool {
  definition: Tool; schemaDigest: string;
  availability: 'compatible' | 'unsupported-schema' | 'denied';
}
export interface McpCapabilityCatalog {
  revision: number; digest: string; protocolVersion: string; serverInfo: Implementation;
  capabilities: ServerCapabilities; instructions?: string;
  tools: McpCatalogTool[]; resources: Resource[]; resourceTemplates: ResourceTemplate[];
  resourceDiscovery: 'available' | 'unsupported' | 'denied';
}
export type McpConnectionState = 'connecting' | 'discovering' | 'ready' | 'auth-required' | 'disconnected' | 'blocked' | 'failed' | 'closed';
export type McpConnectionErrorCode = 'APPROVAL_REQUIRED' | 'CONFIG_CHANGED' | 'UNAVAILABLE' | 'AUTH_REQUIRED' | 'TIMEOUT'
  | 'INVALID_CATALOG' | 'LIMIT_EXCEEDED' | 'TARGET_DENIED' | 'CANCELLED' | 'CLOSED';
export interface McpConnectionView {
  sessionId: string; identity: McpConnectionIdentity; generation: number; state: McpConnectionState;
  dirty: boolean; catalog?: McpCapabilityCatalog; error?: { code: McpConnectionErrorCode; message: string };
}
export interface McpOAuthProfile {
  provider: OAuthClientProvider;
  /** Host-approved issuer origins; discovery cannot add origins silently. */
  allowedOrigins: readonly string[];
}
export interface McpTransportContext { signal: AbortSignal; check(): void; checkToolRequest?(id: string | number): void }
export type McpHostTransportFactory = (config: McpServerConfig, context: McpTransportContext) => Promise<McpTransport>;
export interface McpConnectionOptions {
  credentials?: CredentialResolver;
  oauthProfile?: (profileId: string, serverUrl: string, signal: AbortSignal) => Promise<McpOAuthProfile | undefined>;
  fetch?: McpFetch;
  /** Trusted host/test injection only; never supplied by a renderer or model. */
  transportFactory?: McpHostTransportFactory;
  startupTimeoutMs?: number;
  onChange?: (view: McpConnectionView) => void;
}
