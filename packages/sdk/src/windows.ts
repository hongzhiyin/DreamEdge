export interface WindowBounds { x: number; y: number; width: number; height: number }
export interface ProjectWindow {
  id: string; project: { id: string; name: string; rootDirectory: string } | null;
  recoveryError: string | null;
}
export type WindowRequest =
  | { operation: 'current' }
  | { operation: 'list' }
  | { operation: 'new' }
  | { operation: 'createProject'; directory: string; name: string }
  | { operation: 'openProject'; directory: string }
  | { operation: 'focus'; windowId: string };
export type WindowResult = ProjectWindow | ProjectWindow[];
export type ProjectAction = 'createProject' | 'openProject' | 'new' | 'revealProject';
