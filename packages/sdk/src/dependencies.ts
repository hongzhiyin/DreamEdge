export interface LockedPackage {
  name: string; version: string; tarball: string; integrity: string;
  dependencies: Record<string, string>; peers: Record<string, string>;
}
export interface DependencyLock {
  schemaVersion: 1; registry: 'https://registry.npmjs.org';
  dependencies: Record<string, string>; packages: Record<string, LockedPackage>;
}
