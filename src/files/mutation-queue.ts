import { parse } from 'node:path';
/** Directory operations overlap descendant writes: use Pi's queue for the shared host boundary. */
export async function managedMutationQueue<T>(operation: () => Promise<T>): Promise<T> {
  const pi = await import('@earendil-works/pi-coding-agent');
  return pi.withFileMutationQueue(parse(process.cwd()).root, operation);
}
