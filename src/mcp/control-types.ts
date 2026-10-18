import type { McpConnectionIdentity } from './types.js';
import type { McpRegistration, McpAppContext, McpResolution, McpAssociation, McpSessionBinding } from './registry-types.js';
import type { McpConnectionView } from './connection-types.js';
import type { ModelDestination } from '../model/destination.js';
export interface McpControlView {
  settings?: { text: string; path: string; serverIds: string[]; error?: string };
  sessionId: string; revision: number; mode: 'local' | 'external' | 'migration';
  destination: ModelDestination; notices: string[];
  servers: (McpRegistration & { identity: McpConnectionIdentity; connection?: McpConnectionView })[];
  binding?: McpSessionBinding; associations: McpAssociation[];
  context?: McpAppContext; resolution?: McpResolution;
}
export interface McpControlBridge { request(command: unknown): Promise<McpControlView> }
