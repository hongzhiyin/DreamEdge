import type { ModelConnection } from './development.js';

export interface ModelSettingsState {
  provider: 'responses'; model: string; baseUrl: string; hasKey: boolean;
  projectId: string; configPath: string; revision: string; warning: string | null;
}
export type ModelSettingsRequest =
  | { operation: 'get'; projectId: string }
  | { operation: 'save'; projectId: string; model: string; baseUrl: string; apiKey?: string; expectedRevision: string }
  | { operation: 'clear'; projectId: string; expectedRevision: string }
  | { operation: 'test'; projectId: string; expectedRevision: string };
export type ModelSettingsResult = ModelSettingsState | ModelConnection;
