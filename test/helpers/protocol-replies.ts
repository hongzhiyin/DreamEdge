import type { ServerResponse } from 'node:http';
import { beginSse, sse } from './server.js';

export function anthropicReply(response: ServerResponse): void {
  beginSse(response);
  const emit = (type: string, rest: Record<string, unknown> = {}) => sse(response, { type, ...rest }, type);
  emit('message_start', { message: { id: 'message-fixture', type: 'message', role: 'assistant',
    model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello world' } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
  emit('message_stop');
  response.end();
}

export function responsesReply(response: ServerResponse): void {
  beginSse(response);
  const item = { id: 'message-fixture', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Hello world', annotations: [] }] };
  const base = { id: 'response-fixture', object: 'response', model: 'fixture-model', status: 'in_progress',
    output: [], usage: null };
  let sequence = 0;
  const emit = (type: string, rest: Record<string, unknown>) =>
    sse(response, { type, sequence_number: sequence++, ...rest }, type);
  emit('response.created', { response: base });
  emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  emit('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] } });
  emit('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: 'Hello world' });
  emit('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text: 'Hello world' });
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: { ...base, status: 'completed', output: [item],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } });
  response.end();
}

export function googleReply(response: ServerResponse): void {
  beginSse(response);
  sse(response, { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello' }] } }] });
  sse(response, { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ' world' }] }, finishReason: 'STOP' }],
    modelVersion: 'fixture-model', usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } });
  response.end();
}
