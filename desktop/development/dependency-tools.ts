import type { PackageRegistry } from '../dependencies/registry';
import { NpmRegistry } from '../dependencies/registry';
import { dependencies, packageName } from '../dependencies/policy';

export function dependencyList(input: unknown): Record<string, string> {
  if (!Array.isArray(input) || input.length > 20) throw new Error('最多支持 20 个直接依赖。');
  const result: Record<string, string> = Object.create(null);
  for (const item of input) {
    packageName(item?.name);
    if (Object.hasOwn(result, item.name)) throw new Error('依赖声明包含重复包名。');
    result[item.name] = item.version;
  }
  return dependencies(result);
}
export async function resolveDependency(args: Record<string, unknown>, signal: AbortSignal, registry: PackageRegistry = new NpmRegistry()) {
  packageName(args.name); dependencies({ [args.name]: args.range }, false);
  const item = await registry.resolve(args.name, args.range as string, signal);
  signal.throwIfAborted();
  return { name: item.name, version: item.version, dependencies: item.dependencies, peers: item.peers };
}
