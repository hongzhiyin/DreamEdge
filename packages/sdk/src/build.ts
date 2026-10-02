export interface BuildLog { level: 'info' | 'warning' | 'error'; message: string; path?: string; line?: number; column?: number }
export interface CandidateReference { sessionId: string; turnId: string }
export interface CandidateBuild {
  schemaVersion: 1; id: string; projectId: string; candidate: CandidateReference | null;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string; finishedAt: string | null; definitionHash: string;
  sourceHashes: Record<string, string>; outputHashes: Record<string, string>;
  logs: BuildLog[]; previewUrl: string | null;
}
export type CandidateBuildRequest =
  | { operation: 'start'; projectId: string; candidate?: CandidateReference }
  | { operation: 'get'; projectId: string; buildId: string }
  | { operation: 'cancel'; projectId: string; buildId: string }
  | { operation: 'openPreview'; projectId: string; buildId: string };
export type CandidateBuildResult = CandidateBuild | { buildId: string; url: string };
