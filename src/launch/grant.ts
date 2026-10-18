import type { McpConnectionIdentity } from '../mcp/types.js';
import type { OpenSession } from './protocol.js';
import { contextKey } from './protocol.js';
import { argumentsDigest } from '../tools/json.js';
export interface LaunchReadGrant {
  request: OpenSession; destination: string; identity: McpConnectionIdentity;
  toolSchemas: Record<string, string>; definitionsDigest: string; revoked: boolean;
}
export function readGrantDigest(grant: LaunchReadGrant): string {
  return argumentsDigest({ context: contextKey(grant.request), offer: grant.request.mcp!, identity: grant.identity,
    destination: grant.destination, definitionsDigest: grant.definitionsDigest, toolSchemas: grant.toolSchemas });
}
