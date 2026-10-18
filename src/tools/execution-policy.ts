export interface ToolInspection {
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly rule: string;
  readonly reason: string;
}

/** An invalid policy result is a failure, never an implicit allow. */
export function assertToolInspection(value: unknown): asserts value is ToolInspection {
  if (!value || typeof value !== 'object') throw new Error('Missing tool inspection');
  const result = value as ToolInspection;
  if (!['allow', 'ask', 'deny'].includes(result.decision)
    || typeof result.rule !== 'string' || !result.rule.trim() || result.rule.length > 200
    || typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > 2000) {
    throw new Error('Invalid tool inspection');
  }
}
