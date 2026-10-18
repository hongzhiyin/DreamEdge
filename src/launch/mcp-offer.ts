import { isAbsolute } from 'node:path';
import { argumentsDigest } from '../tools/json.js';
import { LaunchError } from './protocol.js';

export interface LaunchMcpOffer {
  transport: { type: 'stdio'; command: string; args: string[] };
  scope: string;
  readTools: string[];
  interactionTools?: string[];
}
export function parseMcpOffer(value: unknown): LaunchMcpOffer {
  const fail = (): never => { throw new LaunchError('INVALID_MCP_OFFER', '应用 MCP 交接配置无效。'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>, t = v.transport as Record<string, unknown>;
  if (Object.keys(v).some(k => !['transport', 'scope', 'readTools', 'interactionTools'].includes(k))
    || !t || typeof t !== 'object' || Array.isArray(t)
    || Object.keys(t).some(k => !['type', 'command', 'args'].includes(k)) || t.type !== 'stdio'
    || typeof t.command !== 'string' || !isAbsolute(t.command) || t.command.length > 4096 || /[\u0000-\u001f]/.test(t.command)
    || !Array.isArray(t.args) || t.args.length > 32 || t.args.some(a => typeof a !== 'string' || a.length > 4096 || /[\u0000-\u001f]/.test(a))
    || typeof v.scope !== 'string' || !v.scope.trim() || v.scope.length > 300 || /[\u0000-\u001f]/.test(v.scope)
    || !Array.isArray(v.readTools) || !v.readTools.length || v.readTools.length > 16
    || v.readTools.some(n => typeof n !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(n))
    || new Set(v.readTools).size !== v.readTools.length) return fail();
  const interactions = v.interactionTools ?? [];
  if (!Array.isArray(interactions) || interactions.length > 16
    || interactions.some(n => typeof n !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(n) || (v.readTools as string[]).includes(n))
    || new Set(interactions).size !== interactions.length) return fail();
  return { transport: { type: 'stdio', command: t.command, args: [...t.args] }, scope: v.scope, readTools: [...v.readTools].sort(),
    ...(interactions.length ? { interactionTools: [...interactions].sort() } : {}) };
}
export function launchTrustDestination(destination: string, offer?: LaunchMcpOffer): string {
  return offer ? JSON.stringify([destination, argumentsDigest(offer)]) : destination;
}
