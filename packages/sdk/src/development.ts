import type { ProjectDefinition, WorkspaceFile } from './workspace.js';

export interface ModelConnection { provider: string; available: boolean; detail: string }
export interface ProjectContext { definition: ProjectDefinition; files: WorkspaceFile[] }
export interface ProposedFile { path: string; content: string }
export interface ModelProposal { summary: string; files: ProposedFile[] }
export interface CandidateFile extends ProposedFile { expectedHash: string | null }
export interface AgentActivity {
  id: string; tool: 'list_files' | 'read_file' | 'search_files';
  status: 'running' | 'completed' | 'failed' | 'cancelled'; detail: string;
}
export interface DevelopmentTurn {
  id: string; prompt: string; startedAt: string; finishedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  summary: string | null; error: string | null;
  context: { path: string; hash: string }[];
  changes: CandidateFile[];
  activity?: AgentActivity[];
  phase?: 'thinking' | 'building' | 'applying' | 'complete';
  applied?: boolean; buildId?: string; commitId?: string | null; warning?: string;
}
export interface DevelopmentSessionSummary { id: string; title: string; updatedAt: string; turnCount: number }
export interface DevelopmentSession {
  schemaVersion: 1; id: string; projectId: string; title: string;
  createdAt: string; updatedAt: string; turns: DevelopmentTurn[];
}
export interface CandidateInspection {
  reference: { sessionId: string; turnId: string }; summary: string; stale: boolean; reason: string | null;
  files: { path: string; before: string | null; after: string }[];
}
export type DevelopmentRequest =
  | { operation: 'connection' }
  | { operation: 'create'; projectId: string; title: string }
  | { operation: 'listSummaries'; projectId: string }
  | { operation: 'list'; projectId: string }
  | { operation: 'candidate'; projectId: string; sessionId: string; turnId: string }
  | { operation: 'get'; projectId: string; sessionId: string }
  | { operation: 'send'; projectId: string; sessionId: string; prompt: string; paths?: string[]; commit?: boolean }
  | { operation: 'cancel'; projectId: string; sessionId: string };
export type DevelopmentResult = CandidateInspection | ModelConnection | DevelopmentSession | DevelopmentSession[] | DevelopmentSessionSummary[];
