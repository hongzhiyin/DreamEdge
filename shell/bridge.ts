import { useEffect, type RefObject } from 'react';
import type { HostApi, BridgeRequest, ToolManifest } from '../shared/contracts';
import { TOOL_CHANNEL } from '../shared/contracts';

declare global {
  interface Window { dreamEdge: HostApi }
}

export function useToolBridge(frame: RefObject<HTMLIFrameElement | null>, tool: ToolManifest | undefined, toggleAssistant: () => void): void {
  useEffect(() => {
    if (!tool) return;
    const origin = `dreamedge://${tool.id}`;
    const pending = new Set<string>();
    async function receive(event: MessageEvent): Promise<void> {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      const data = event.data;
      if (!data || data.channel !== TOOL_CHANNEL) return;
      if (data.type === 'toggle-assistant') { toggleAssistant(); return; }
      if (data.type !== 'request') return;
      if (typeof data.requestId !== 'string' || data.requestId.length > 80) return;
      if (pending.has(data.requestId) || pending.size >= 100) return;
      pending.add(data.requestId);
      const source = event.source as Window;
      const reply = { channel: TOOL_CHANNEL, type: 'response', requestId: data.requestId };
      try {
        const request = data.request as BridgeRequest;
        if (!request || !['storage', 'service'].includes(request.kind)) throw new Error('无效的应用请求。');
        const result = request.kind === 'storage'
          ? await window.dreamEdge.storage(tool!.id, request.payload)
          : await window.dreamEdge.service(tool!.id, request.service, request.method, request.input);
        source.postMessage({ ...reply, result }, origin);
      } catch (error) {
        source.postMessage({ ...reply, error: error instanceof Error ? error.message : '存储失败。' }, origin);
      } finally {
        pending.delete(data.requestId);
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [frame, tool, toggleAssistant]);
}
