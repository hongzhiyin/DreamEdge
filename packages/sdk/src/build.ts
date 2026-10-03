export interface BuildLog { level: 'info' | 'warning' | 'error'; message: string; path?: string; line?: number; column?: number }
export interface CandidateReference { sessionId: string; turnId: string }
export interface CandidateBuild {
  schemaVersion: 3; id: string; projectId: string; candidate: CandidateReference | null;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string; finishedAt: string | null; definitionHash: string;
  dependencies: Record<string, string>; candidateDefinitionHash: string; phase: 'resolving' | 'installing' | 'compiling' | 'complete';
  sourceHashes: Record<string, string>; candidateHashes: Record<string, string>; outputHashes: Record<string, string>;
  logs: BuildLog[]; previewUrl: string | null;
  projectChanges?: import('./development.js').CandidateFile[];
  projectContextHashes?: Record<string, string>;
}
export type CandidateBuildRequest =
  | { operation: 'start'; projectId: string; candidate?: CandidateReference; dependencies?: Record<string, string> }
  | { operation: 'clearDependencyCache'; projectId: string }
  | { operation: 'get'; projectId: string; buildId: string }
  | { operation: 'cancel'; projectId: string; buildId: string }
  | { operation: 'openPreview'; projectId: string; buildId: string };
export type CandidateBuildResult = CandidateBuild | { buildId: string; url: string } | { cleared: true };
