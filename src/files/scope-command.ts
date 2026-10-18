import { FileScopeError } from './scope-types.js';
import type { FileGrantOptions } from './scope-types.js';
import { exclusion } from './scope-validation.js';

export type FileScopeCommand = { type: 'snapshot'; sessionId: string }
  | { type: 'choose'; sessionId: string; options: FileGrantOptions }
  | { type: 'revoke'; sessionId: string; grantId: string }
  | { type: 'device'; sessionId: string; enabled: boolean };
const invalid = (): never => { throw new FileScopeError('FILE_SCOPE_INVALID', '目录授权命令无效。'); };
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 256 && !v.includes('\0');
function object(v: unknown, fields: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))) return invalid();
  return v as Record<string, unknown>;
}
export function fileScopeCommand(value: unknown): FileScopeCommand {
  const command = object(value, ['type', 'sessionId', 'grantId', 'options', 'enabled']);
  if (!text(command.sessionId)) invalid();
  if (command.type === 'snapshot') object(value, ['type', 'sessionId']);
  else if (command.type === 'device') { object(value, ['type', 'sessionId', 'enabled']); if (typeof command.enabled !== 'boolean') invalid(); }
  else if (command.type === 'revoke') { object(value, ['type', 'sessionId', 'grantId']); if (!text(command.grantId)) invalid(); }
  else if (command.type === 'choose') {
    object(value, ['type', 'sessionId', 'options']);
    const o = object(command.options, ['mode', 'remember', 'excludes', 'expiresAt']);
    if (!['read', 'read-write'].includes(String(o.mode)) || typeof o.remember !== 'boolean'
      || (o.expiresAt !== undefined && !Number.isFinite(o.expiresAt))
      || (o.excludes !== undefined && (!Array.isArray(o.excludes) || o.excludes.length > 128 || !o.excludes.every(exclusion)))) invalid();
  } else invalid();
  return structuredClone(command) as unknown as FileScopeCommand;
}
