export async function installStructureModel(application, packages) {
  await application.evaluate((_electron, packages) => {
    const item = packages[0].item; const upgraded = packages[1].item;
    globalThis.structureMode = 'add';
    const metadata = item => ({ name: item.name, version: item.version, dependencies: {}, dist: { tarball: item.tarball, integrity: item.integrity } });
    let calls = 0;
    const emit = (name, args) => {
      const tool = { type: 'function_call', id: 'fc_structure', call_id: `${name}_${++calls}`, name, arguments: JSON.stringify(args) };
      const events = [
        { type: 'response.created', response: { id: 'resp_structure', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...tool, arguments: '' } },
        { type: 'response.output_item.done', output_index: 0, item: tool },
        { type: 'response.completed', response: { id: 'resp_structure', status: 'completed', output: [tool] } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    globalThis.fetch = async (url, options) => {
      if (options.redirect !== 'error') throw new Error('Unsafe request');
      if (String(url).startsWith('https://registry.npmjs.org/')) {
        if (new Headers(options.headers).has('Authorization')) throw new Error('Model credential sent to npm');
        for (const entry of packages) {
          if (String(url) === entry.item.tarball) return new Response(Buffer.from(entry.bytes, 'base64'));
          if (String(url) === `https://registry.npmjs.org/${entry.item.name}/${entry.item.version}`) return Response.json(metadata(entry.item));
        }
        if (String(url) === `https://registry.npmjs.org/${item.name}`) return Response.json({ versions: Object.fromEntries(packages.map(entry => [entry.item.version, metadata(entry.item)])) });
        throw new Error('Unexpected npm URL');
      }
      if (String(url) !== 'https://api.deepseek.com/responses') throw new Error('Unexpected model URL');
      if (new Headers(options.headers).get('Authorization') !== 'Bearer fixture-structure-key') throw new Error('Missing credential');
      const body = JSON.parse(options.body); const calls = body.input.filter(item => item.type === 'function_call'); const last = calls.at(-1);
      if (!last) return emit('read_file', { path: 'main.ts' });
      if (globalThis.structureMode === 'add') {
        if (last.name === 'read_file' && JSON.parse(last.arguments).path === 'main.ts') return emit('read_file', { path: 'unused.ts' });
        if (last.name === 'read_file') return emit('resolve_dependency', { name: item.name, range: item.version });
        if (last.name === 'resolve_dependency') return emit('set_dependencies', { packages: [{ name: item.name, version: item.version }] });
        return emit('propose_changes', { summary: '已引入依赖并删除 unused.ts。', files: [
          { path: 'main.ts', content: `import { greeting } from '${item.name}';document.getElementById('root').textContent=greeting;` },
          { path: 'unused.ts', content: null },
        ] });
      }
      if (last.name === 'read_file') return emit('set_dependencies', { packages: globalThis.structureMode === 'upgrade' ? [{ name: item.name, version: upgraded.version }] : [] });
      return emit('propose_changes', { summary: globalThis.structureMode === 'upgrade' ? '已升级依赖，源码保持不变。' : '已移除依赖。', files: globalThis.structureMode !== 'remove' ? [] : [
        { path: 'main.ts', content: "document.getElementById('root').textContent='Hello Without Dependencies';" },
      ] });
    };
  }, packages);
}
