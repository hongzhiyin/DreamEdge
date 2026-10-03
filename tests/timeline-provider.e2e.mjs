export async function timelineProvider(application) {
  await application.evaluate(() => {
    let requests = 0;
    const encode = event => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    globalThis.fetch = async (url, options) => {
      if (options.redirect !== 'error') throw new Error('Redirect boundary missing');
      if (String(url).startsWith('https://registry.npmjs.org/')) {
        if (new Headers(options.headers).has('Authorization')) throw new Error('Model key sent to npm');
        return new Promise(resolve => { globalThis.releaseLookup = () => resolve(Response.json({ versions: { '1.0.0': { name: 'dreamedge-timeline', version: '1.0.0',
          dist: { tarball: 'https://registry.npmjs.org/dreamedge-timeline/-/dreamedge-timeline-1.0.0.tgz', integrity: 'sha512-' + 'A'.repeat(86) + '==' } } } })); });
      }
      const first = ++requests === 1;
      const args = first ? { name: 'dreamedge-timeline', range: '*' } : requests === 2 ? { path: 'main.ts' }
        : { summary: '页面修改完成。', files: [{ path: 'main.ts', content: "document.getElementById('root').textContent='Hello Timeline';" }] };
      const tool = { id: `fc_${requests}`, type: 'function_call', call_id: `call_${requests}`, name: first ? 'resolve_dependency' : requests === 2 ? 'read_file' : 'propose_changes', arguments: JSON.stringify(args) };
      return new Response(new ReadableStream({ async start(controller) {
        const output = [];
        controller.enqueue(encode({ type: 'response.created', response: { id: 'resp', status: 'in_progress' } }));
        if (first) {
          const reason = { id: 'reason', type: 'reasoning', summary: [{ type: 'summary_text', text: '先查询依赖信息，再读取当前页面并修改问候语。' }], encrypted_content: 'opaque-not-visible' };
          controller.enqueue(encode({ type: 'response.output_item.added', output_index: 0, item: reason }));
          controller.enqueue(encode({ type: 'response.output_item.done', output_index: 0, item: reason })); output.push(reason);
          await new Promise(resolve => { globalThis.releaseReply = resolve; });
        }
        const output_index = output.length; output.push(tool);
        controller.enqueue(encode({ type: 'response.output_item.added', output_index, item: { ...tool, arguments: '' } }));
        controller.enqueue(encode({ type: 'response.output_item.done', output_index, item: tool }));
        controller.enqueue(encode({ type: 'response.completed', response: { id: 'resp', status: 'completed', output } })); controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
}
