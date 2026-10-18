import type { RuntimeFailure } from './types.js';

export class ModelAdapterError extends Error {
  constructor(readonly code: RuntimeFailure['code'], message: string) {
    super(message);
    this.name = 'ModelAdapterError';
  }
}

export function failure(error: unknown, secret?: string): RuntimeFailure {
  const code = error instanceof ModelAdapterError ? error.code : 'REQUEST_FAILED';
  let message = error instanceof Error ? error.message : '模型请求失败。';
  if (secret) message = message.split(secret).join('[REDACTED]');
  message = message.replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]');
  return { code, message };
}

export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
