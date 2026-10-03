export interface GitCommit { id: string; message: string; createdAt: string; parents?: string[]; remoteState?: 'pushed' | 'local' | 'unknown' }
export interface GitRemote { name: string; url: string; branch: string; tracking: boolean; exists: boolean; ahead: number; behind: number }
export interface GitStatus {
  head: string | null; branch: string; changed: string[]; otherChanged: string[]; stateHash: string; commits: GitCommit[];
  remotes: { name: string; url: string }[]; remote: GitRemote | null; remoteCommits: GitCommit[]; fetchedAt: string | null;
}
export type GitRequest =
  | { operation: 'status'; projectId: string }
  | { operation: 'commit'; projectId: string; message: string; expectedStateHash: string }
  | { operation: 'restore'; projectId: string; commitId: string; expectedStateHash: string }
  | { operation: 'discard' | 'fetch' | 'pull' | 'push'; projectId: string; expectedStateHash: string }
  | { operation: 'applyBuild'; projectId: string; buildId: string };
export type GitResult = GitStatus | { applied: true; commitId?: string | null };
