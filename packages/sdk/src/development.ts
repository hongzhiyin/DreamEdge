import type { ProjectDefinition, WorkspaceFile } from './workspace.js';

export interface ModelConnection { provider: string; available: boolean; detail: string }
export interface ProjectContext { definition: ProjectDefinition; files: WorkspaceFile[] }
/** content=null deletes an existing file captured in the request context. */
export interface ProposedFile { path: string; content: string | null }
export interface ModelProposal { summary: string; files: ProposedFile[]; dependencies?: Record<string, string> }
export interface CandidateFile extends ProposedFile { expectedHash: string | null }
export interface AgentActivity {
  id: string; tool: 'list_files' | 'read_file' | 'search_files' | 'resolve_dependency' | 'set_dependencies';
  status: 'running' | 'completed' | 'failed' | 'cancelled'; detail: string;
}
export interface DevelopmentEvent {
  id: string; kind: 'model' | 'thinking' | 'message' | 'tool' | 'build' | 'apply' | 'commit';
  label: string; status: 'running' | 'completed' | 'failed' | 'cancelled';
  tool?: string; detail?: string; content?: string; input?: string; output?: string;
  startedAt?: string; finishedAt?: string;
}
export interface DevelopmentTurn {
  id: string; prompt: string; startedAt: string; finishedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  summary: string | null; error: string | null;
  context: { path: string; hash: string }[];
  changes: CandidateFile[]; dependencies?: Record<string, string>;
  activity?: AgentActivity[]; events?: DevelopmentEvent[];
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
  files: { path: string; before: string | null; after: string | null }[];
  dependencies?: { before: Record<string, string>; after: Record<string, string> };
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
