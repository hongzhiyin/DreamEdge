/** Deterministic model transport; no network or real credentials are used. */
export async function upgradeModel(application, greeting) {
  await application.evaluate((_electron, greeting) => {
    let requests = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url) !== 'https://model.example/v1/responses') throw new Error('Unexpected upgrade model request');
      if (new Headers(options.headers).get('Authorization') !== 'Bearer fixture-upgrade-key') throw new Error('Upgrade credential missing');
      const body = JSON.parse(options.body);
      if (JSON.stringify(body).includes('fixture-upgrade-key')) throw new Error('Credential leaked into model input');
      const path = JSON.stringify(body).includes('BUSINESS PROJECT ROOT') ? 'src/main.ts' : 'main.ts';
      const read = ++requests % 2 === 1;
      const item = { id: `fc_upgrade_${requests}`, type: 'function_call', call_id: `call_upgrade_${requests}`,
        name: read ? 'read_file' : 'propose_changes', arguments: JSON.stringify(read ? { path }
          : { summary: `已更新为 ${greeting}。`, files: [{ path, content: `document.getElementById('root')!.textContent='${greeting}';\n` }] }) };
      const events = [
        { type: 'response.created', response: { id: 'resp_upgrade', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_upgrade', status: 'completed', output: [item] } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, greeting);
}
