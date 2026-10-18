import { mcpConnectionIdentity } from './config.js';
import type { McpAppContext, McpAssociation, McpCandidate, McpRegistration, McpRegistryState, McpResolution } from './registry-types.js';
import { McpRegistryError, parseMcpAppContext, parseMcpRegistry, sameMcpIdentity } from './registry-validation.js';
import { freezeDeep } from '../tools/json.js';

export function registrationBlock(entry: McpRegistration): 'disabled' | 'revoked' | 'denied' | undefined {
  if (entry.revoked) return 'revoked';
  if (!entry.config.enabled) return 'disabled';
  if (entry.config.policy.connect === 'deny') return 'denied';
  return undefined;
}
function candidate(entry: McpRegistration): McpCandidate {
  return { identity: mcpConnectionIdentity(entry.config), displayName: entry.config.displayName,
    connectionPermission: entry.approval ? 'approved' : 'approval-required' };
}
const applies = (rule: McpAssociation, context: McpAppContext) => rule.appId === context.appId
  && (rule.profileRef === undefined || rule.profileRef === context.profileRef);

/** Pure matching only: does not discover endpoints, inspect windows, start a client or grant permission. */
export function resolveMcpContext(value: McpRegistryState, input: {
  sessionId?: string; context?: unknown; now?: number; maxAgeMs?: number;
}): McpResolution {
  const state = parseMcpRegistry(value); const now = input.now ?? Date.now(), maxAge = input.maxAgeMs ?? 60_000;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAge) || maxAge < 1) throw new McpRegistryError('INVALID_REGISTRY');
  const context = input.context === undefined ? undefined : parseMcpAppContext(input.context);
  const blocked = (reason: Extract<McpResolution, { kind: 'blocked' }>['reason']): McpResolution => ({ kind: 'blocked', reason });
  if (context?.source === 'untrusted') return blocked('untrusted-context');
  if (context && (context.capturedAt > now || now - context.capturedAt > maxAge)) return blocked('stale-context');
  const select = (entry: McpRegistration | undefined, via: 'session' | 'reference' | 'application'): McpResolution => {
    if (!entry) return blocked('missing-server'); const reason = registrationBlock(entry); if (reason) return blocked(reason);
    return freezeDeep({ kind: 'selected', via, candidate: candidate(entry), ...(context ? { context } : {}) });
  };
  const pinned = state.bindings.find(b => b.sessionId === input.sessionId);
  if (pinned) {
    const entry = state.servers.find(s => s.config.serverId === pinned.identity.serverId);
    if (!entry || !sameMcpIdentity(pinned.identity, mcpConnectionIdentity(entry.config))) return blocked('stale-binding');
    if (pinned.scope) {
      if (!context) return blocked('context-required');
      if (pinned.scope.appId !== context.appId || (pinned.scope.profileRef !== undefined && pinned.scope.profileRef !== context.profileRef)) return blocked('context-changed');
    } else if (context) return blocked('context-changed'); // A service-only pin does not bind arbitrary foreground context.
    return select(entry, 'session');
  }
  if (!context) return blocked('context-required');
  const rules = state.associations.filter(rule => applies(rule, context));
  if (context.connectionRef) {
    const entry = state.servers.find(s => s.config.serverId === context.connectionRef);
    if (!entry) return blocked('missing-server');
    if (context.source !== 'user-selection' && !rules.some(r => r.serverId === context.connectionRef)) return blocked('unassociated-reference');
    return select(entry, 'reference');
  }
  if (!rules.length) {
    if (context.profileRef === undefined && state.associations.some(r => r.appId === context.appId && r.profileRef !== undefined)) return blocked('context-required');
    return { kind: 'unmatched' };
  }
  const ids = new Set(rules.map(r => r.serverId));
  const entries = state.servers.filter(s => ids.has(s.config.serverId) && !registrationBlock(s))
    .sort((a, b) => a.config.serverId.localeCompare(b.config.serverId));
  if (!entries.length) return blocked('unavailable');
  if (entries.length === 1) return select(entries[0], 'application');
  return freezeDeep({ kind: 'choice', candidates: entries.map(candidate) });
}
