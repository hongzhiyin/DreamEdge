import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import type { JsonObject } from '@earendil-works/pi-ai';
import { assertToolInspection } from '../tools/execution-policy.js';

/** Policy work cannot hold a stopped run open or outlive its execution deadline. */
export async function inspectTool(callback: NonNullable<ToolDefinition['inspectExecution']>, args: JsonObject,
  context: ToolExecutionContext, timeoutMs: number) {
  context.signal.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new Error('Tool inspection timed out')), Math.min(timeoutMs, 5000));
  let cancel!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return callback(args, { ...context, signal }); });
    const result = await Promise.race([work, stopped]);
    assertToolInspection(result); signal.throwIfAborted();
    return Object.freeze({ ...result });
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
