import { readFileSync } from 'node:fs';
import { canonicalJson } from '../tools/json.js';
import { modelDestination } from '../model/destination.js';
import type { ModelConnectionConfig } from '../model/types.js';
import type { OpenSession } from './protocol.js';

/** User-owned local policy, not a claim supplied in an application's launch request. */
export function automaticApplicationAccess(path: string, request: OpenSession, config: ModelConnectionConfig): boolean {
  try {
    const raw = readFileSync(path, 'utf8'); if (Buffer.byteLength(raw) > 64 * 1024 || !request.mcp) return false;
    const document = JSON.parse(raw);
    if (document.format !== 'ai-application-policies/v1' || !Array.isArray(document.applications)) return false;
    return document.applications.some((rule: any) => {
      if (rule.applicationId !== request.application.id || rule.profile !== request.application.profile
        || rule.command !== request.mcp!.transport.command || !Array.isArray(rule.args)
        || canonicalJson(rule.destination) !== canonicalJson(modelDestination(config))) return false;
      const args = rule.args.map((arg: unknown) => {
        if (typeof arg === 'string') return arg;
        if (arg && typeof arg === 'object' && Object.keys(arg).length === 1 && 'context' in arg
          && (arg.context === 'window' || arg.context === 'resource')) return request.context[arg.context];
        throw new Error('Invalid policy argument');
      });
      return canonicalJson(args) === canonicalJson(request.mcp!.transport.args)
        && Array.isArray(rule.readTools) && Array.isArray(rule.interactionTools)
        && request.mcp!.readTools.every(name => rule.readTools.includes(name))
        && (request.mcp!.interactionTools ?? []).every(name => rule.interactionTools.includes(name));
    });
  } catch { return false; }
}
