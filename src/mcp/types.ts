import type { SupportedProtocolVersion } from '@earendil-works/pi-mcp';

export type McpCredentialRef = `env:${string}` | `file:${string}`;
/** A requested policy is not an approval receipt. No remote annotation grants permission. */
export interface McpPermissionPolicy {
  readonly connect: 'ask' | 'deny';
  readonly tools: 'ask' | 'deny';
  readonly resources: 'ask' | 'deny';
}
export type McpHttpAuth = { readonly type: 'none' }
  | { readonly type: 'bearer'; readonly credentialRef: McpCredentialRef }
  | { readonly type: 'oauth'; readonly profileId: string };
export type McpTransportConfig = {
  readonly type: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Explicit references only; future transport construction must set inheritEnv: false. */
  readonly envRefs: Readonly<Record<string, McpCredentialRef>>;
} | {
  readonly type: 'streamable-http';
  readonly url: string;
  readonly auth: McpHttpAuth;
};
export interface McpServerConfig {
  readonly format: 'dreamedge-mcp-server/v1';
  readonly serverId: string;
  readonly displayName: string;
  readonly configRevision: number;
  readonly enabled: boolean;
  readonly protocolVersion: SupportedProtocolVersion;
  readonly requestTimeoutMs: number;
  readonly transport: McpTransportConfig;
  readonly policy: McpPermissionPolicy;
}
/** Serializable identity for future trust/permission records; contains no resolved credentials. */
export interface McpConnectionIdentity {
  readonly serverId: string;
  readonly configRevision: number;
  readonly configDigest: string;
}
