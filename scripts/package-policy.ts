/** Electron/ASAR APIs may return native separators; policy always compares portable paths. */
export function packageExcluded(raw: string): boolean {
  const path = raw.replaceAll('\\', '/');
  if (path === '') return false;
  if (/\.local\.json$|\/\.env(?:\.|$)|\/node_modules\/\.(?:bin|cache)(?:\/|$)/.test(path)) return true;
  if (path.startsWith('/node_modules/') || path === '/node_modules') return false;
  if (['/dist', '/config', '/package.json', '/licenses'].includes(path) || path.startsWith('/licenses/')) return false;
  if (/^\/dist\/(?:src|desktop|renderer|web|cli)(?:\/|$)/.test(path)) return false;
  return !['/config/deepseek.example.json', '/config/credentials.example.json'].includes(path);
}
export function packagePaths(paths: string[]): string[] { return paths.map(path => path.replaceAll('\\', '/')); }
