import type { AppManifest, ProjectDefinition } from '../../shared/contracts';
export interface ExportInput { root: string; manifest: AppManifest }
export type ExportEngine = (input: ExportInput, signal: AbortSignal, progress: (message: string) => Promise<void>) => Promise<void>;
export interface ExportResources { runtime: string; bundles: string; frameworkVersion: string; frameworkAppId: string; tooling?: string }
export interface ExportSnapshot { files: Record<string, string>; outputs: Record<string, string>; definition: ProjectDefinition; archives?: Record<string, Buffer> }
