import type { ProjectDefinition } from '../shared/contracts';

export async function definitionRevision(definition: ProjectDefinition) {
  const bytes = new TextEncoder().encode(JSON.stringify(definition));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
