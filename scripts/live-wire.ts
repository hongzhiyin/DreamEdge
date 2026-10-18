/** Live probe telemetry: never stores headers, keys, prompts or response bodies. */
export interface WireRequest {
  model: string; effort?: string; thinking?: string; toolChoice?: string; tools: string[];
  messages: { role: string; reasoningCharacters: number; calls: string[]; toolCallId?: string }[];
  injectedFailure: boolean;
}

export function observeWire(baseUrl: string) {
  const original = globalThis.fetch;
  const requests: WireRequest[] = [];
  let injectNextToolResult = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${baseUrl.replace(/\/$/, '')}/`) && typeof init?.body === 'string') {
      const body = JSON.parse(init.body);
      const messages = body.messages ?? [];
      const injectedFailure = injectNextToolResult && messages.at(-1)?.role === 'tool';
      if (injectedFailure) injectNextToolResult = false;
      requests.push({ model: body.model, effort: body.reasoning_effort, thinking: body.thinking?.type,
        toolChoice: body.tool_choice, tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
        messages: messages.map((message: { role: string; reasoning_content?: string; tool_call_id?: string;
          tool_calls?: { function: { name: string } }[] }) => ({ role: message.role,
          reasoningCharacters: message.reasoning_content?.length ?? 0,
          calls: (message.tool_calls ?? []).map(call => call.function.name),
          ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}) })), injectedFailure });
      if (injectedFailure) return new Response('{"error":{"message":"isolated injected continuation failure"}}', {
        status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    return original(input, init);
  };
  return { requests, injectFailure: () => { injectNextToolResult = true; }, restore: () => { globalThis.fetch = original; } };
}
