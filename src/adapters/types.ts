import type { RunRecord } from '../conversation/types.js';
import type { ModelConnectionConfig } from '../model/types.js';
export interface HostAdapter {
  readonly id: string;
  notice(sessionId: string, runs: readonly RunRecord[]): string | undefined;
  guardHistory(runs: readonly RunRecord[], destination: ModelConnectionConfig): void;
}
