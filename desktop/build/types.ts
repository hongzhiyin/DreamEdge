import type { BuildLog, DependencyLock } from '../../shared/contracts';
export interface BuildInput { files: Record<string, string>; dependencyFiles?: Record<string, string>; dependencyLock?: DependencyLock }
export interface BuildOutput { files: Record<string, string>; logs: BuildLog[] }
export type BuildEngine = (input: BuildInput, signal: AbortSignal) => Promise<BuildOutput>;
export class BuildFailure extends Error {
  constructor(readonly logs: BuildLog[]) { super('候选构建失败。'); }
}
