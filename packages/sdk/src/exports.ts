export interface ProjectExport {
  schemaVersion: 1; id: string; projectId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  phase: 'building' | 'packaging' | 'publishing' | 'complete';
  startedAt: string; finishedAt: string | null; logs: string[];
  directory: string; error: string | null;
}
export interface ExportStatus { supported: boolean; platform: string; arch: string; record: ProjectExport | null }
export type ExportRequest =
  | { operation: 'current'; projectId: string }
  | { operation: 'start'; projectId: string; directory?: string }
  | { operation: 'get' | 'cancel' | 'reveal'; projectId: string; exportId: string };
export type ExportResult = ProjectExport | ExportStatus | { revealed: true } | null;
