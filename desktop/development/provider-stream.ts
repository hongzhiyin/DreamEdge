import { ModelFailure } from './model';

/** Preserve SSE chunks for pi; inspect bytes without implementing a provider event parser. */
export function guardedResponse(response: Response, apiKey: string, signal: AbortSignal): Response {
  const reader = response.body!.getReader(); const secret = Buffer.from(apiKey);
  let pending = Buffer.alloc(0); let bytes = 0;
  const release = () => { try { reader.releaseLock(); } catch {} };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted();
        if (next.done) { if (pending.length) controller.enqueue(pending); controller.close(); release(); return; }
        bytes += next.value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new ModelFailure('模型流式响应超过大小限制。');
        const buffer = Buffer.concat([pending, next.value]);
        if (buffer.includes(secret)) throw new ModelFailure('模型回复包含连接凭据，已拒绝使用。');
        // Hold the possible prefix of a secret spanning network chunks.
        let keep = Math.min(buffer.length, secret.length - 1);
        while (keep && !buffer.subarray(buffer.length - keep).equals(secret.subarray(0, keep))) keep--;
        const safe = buffer.length - keep;
        if (safe) controller.enqueue(buffer.subarray(0, safe));
        pending = buffer.subarray(safe);
      } catch (error) {
        await reader.cancel().catch(() => {}); release();
        controller.error(error instanceof ModelFailure ? error : new ModelFailure('模型流式响应已中断，请重试。'));
      }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}); release(); },
  });
  return new Response(body, { headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'text/event-stream' } });
}
