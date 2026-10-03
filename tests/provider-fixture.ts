/** Wire-level SSE fixtures exercise pi's actual provider parser, not a custom model mock. */
export function providerResponse(output: any[], truncated = false): Response {
  const items = output.map((item, index) => ({ ...item, id: item.id ?? `${item.type === 'function_call' ? 'fc' : 'msg'}_fixture_${index}` }));
  const events: unknown[] = [{ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } }];
  items.forEach((item, output_index) => {
    events.push({ type: 'response.output_item.added', output_index, item: { ...item, arguments: item.type === 'function_call' ? '' : undefined, content: item.type === 'message' ? [] : item.content } });
    events.push({ type: 'response.output_item.done', output_index, item });
  });
  events.push({ type: truncated ? 'response.incomplete' : 'response.completed', response: { id: 'resp_fixture',
    status: truncated ? 'incomplete' : 'completed', incomplete_details: truncated ? { reason: 'max_output_tokens' } : undefined, output: items } });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
