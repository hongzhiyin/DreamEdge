export interface SubmitKey { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }
export function isSubmitKey(key: SubmitKey, composing: boolean, endedAt: number, now: number): boolean {
  return key.key === 'Enter' && !key.shiftKey && !key.isComposing && !composing
    && key.keyCode !== 229 && now - endedAt >= 50;
}
