import { legacyReadingAdapter } from './recollection-garden/legacy.js';
import type { HostAdapter } from './types.js';
/** Explicit adapter composition. Domain integrations can be removed here without changing the AI host. */
export function installedAdapters(directory: string): readonly HostAdapter[] {
  return [legacyReadingAdapter(directory)];
}
