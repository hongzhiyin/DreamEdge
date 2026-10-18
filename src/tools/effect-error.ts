import type { ToolFailure } from './types.js';

/** Only a host check before dispatch can assert that an external operation did not start. */
export class ToolNoEffectError extends Error {
  constructor(readonly code: ToolFailure['code'], message: string) { super(message); this.name = 'ToolNoEffectError'; }
}
