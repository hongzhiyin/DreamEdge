import type { ModelConnection } from './development.js';

export interface ModelSettingsState {
  provider: 'responses'; model: string; baseUrl: string; hasKey: boolean;
  persisted: boolean; secureStorageSupported: boolean; revision: number; warning: string | null;
}
export type ModelSettingsRequest =
  | { operation: 'get' }
  | { operation: 'save'; model: string; baseUrl: string; apiKey?: string; persist: boolean; expectedRevision: number }
  | { operation: 'clear'; expectedRevision: number }
  | { operation: 'test'; expectedRevision: number };
export type ModelSettingsResult = ModelSettingsState | ModelConnection;
