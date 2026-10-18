import type { ModelConnectionConfig } from './types.js';

/** Non-secret identity of the recipient of conversation data. */
export interface ModelDestination { connectionId: string; protocol: string; baseUrl: string; model: string }
export function modelDestination(config: ModelConnectionConfig): ModelDestination {
  return { connectionId: config.id, protocol: config.protocol, baseUrl: new URL(config.baseUrl).href, model: config.model };
}
