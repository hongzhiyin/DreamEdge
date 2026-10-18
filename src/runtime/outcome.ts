import type { AssistantMessage } from '@earendil-works/pi-ai';
import { failure, ModelAdapterError } from '../model/errors.js';
import type { RuntimeRequest, RuntimeResult, ThinkingLevel } from '../model/types.js';

export function settleResult(
  request: RuntimeRequest, message: AssistantMessage | undefined,
  signal: AbortSignal, error?: unknown, secret?: string, thinkingLevel?: ThinkingLevel,
): RuntimeResult {
  const native = message ? structuredClone(message) : undefined;
  if (native?.errorMessage) native.errorMessage = failure(new Error(native.errorMessage), secret).message;
  const result: RuntimeResult = {
    sessionId: request.sessionId, runId: request.runId, status: 'failed',
    text: native?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? '',
    ...(native ? { message: native, stopReason: native.stopReason } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
  if (error instanceof ModelAdapterError && error.code === 'EVENT_DELIVERY_FAILED') {
    result.error = failure(error, secret);
    return result;
  }
  if (signal.aborted) {
    if (signal.reason instanceof ModelAdapterError) result.error = failure(signal.reason, secret);
    else result.status = 'cancelled';
    return result;
  }
  if (error) { result.error = failure(error, secret); return result; }
  if (native?.stopReason === 'stop') result.status = 'completed';
  else if (native?.stopReason === 'aborted') result.status = 'cancelled';
  else if (native?.stopReason === 'length') {
    result.error = { code: 'OUTPUT_LIMIT', message: '模型输出达到长度上限，回复未完整结束。' };
  } else if (native?.stopReason === 'error') {
    result.error = failure(new Error(native.errorMessage ?? '模型请求失败。'), secret);
  } else {
    result.error = { code: 'UNEXPECTED_RESPONSE', message: '模型没有返回正常的文字回复结束状态。' };
  }
  return result;
}
