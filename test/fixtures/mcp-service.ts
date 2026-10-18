import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin }); const mode = process.argv[2];
lines.on('line', line => {
  const request = JSON.parse(line) as { id?: number; method: string };
  if (request.id === undefined) { if (mode === 'exit' && request.method === 'notifications/initialized') setTimeout(() => process.exit(0), 20); return; }
  const result = request.method === 'initialize' ? { protocolVersion: '2025-11-25', serverInfo: { name: 'stdio-fixture', version: '1' },
    capabilities: { tools: {}, resources: {} }, instructions: `provided=${process.env.MCP_TEST_TOKEN === 'fixture-token'}; inherited=${Boolean(process.env.DREAMEDGE_TEST_PRIVATE)}` }
    : request.method === 'resources/list' ? { resources: [{ uri: 'fixture://document', name: 'Document' }] }
    : request.method === 'resources/templates/list' ? { resourceTemplates: [] }
    : request.method === 'resources/read' ? { contents: [{ uri: 'fixture://document', text: 'stdio resource text' }] }
    : request.method === 'tools/call' ? { content: [{ type: 'text', text: 'stdio tool executed' }] }
    : { tools: [{ name: 'fixture_action', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  if (mode === 'stall' && request.method === 'tools/list') { process.stderr.write('fixture-secret-in-stderr'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
lines.on('close', () => process.exit(0));
