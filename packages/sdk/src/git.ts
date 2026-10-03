export interface GitCommit { id: string; message: string; createdAt: string }
export interface GitStatus { head: string | null; branch: string; changed: string[]; stateHash: string; commits: GitCommit[] }
export type GitRequest =
  | { operation: 'status'; projectId: string }
  | { operation: 'commit'; projectId: string; message: string; expectedStateHash: string }
  | { operation: 'restore'; projectId: string; commitId: string; expectedStateHash: string }
  | { operation: 'applyBuild'; projectId: string; buildId: string };
export type GitResult = GitStatus | { applied: true; commitId?: string | null };
