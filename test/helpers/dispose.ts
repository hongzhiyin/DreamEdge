/** Close auxiliary resources before a fixture's after-hook removes its directory. */
export function closeOnExit<T extends { close(): void }>(resource: T): T & Disposable {
  return Object.assign(resource, { [Symbol.dispose]: () => resource.close() });
}
