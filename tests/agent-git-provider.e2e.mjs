export async function agentGitProvider(application, mode, greeting = '') {
  await application.evaluate((_electron, { mode, greeting }) => {
    let step = 0; let target;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body); const text = JSON.stringify(body);
      if (text.includes('fixture-git-agent-key')) throw new Error('Key in model data');
      const names = body.tools.map(tool => tool.name);
      if (!['git_status', 'git_log', 'git_diff'].every(name => names.includes(name))) throw new Error('Git reads missing');
      if (mode === 'readonly' && (names.includes('git_commit') || names.includes('git_restore'))) throw new Error('History granted mutation');
      const last = body.input.filter(item => item.type === 'function_call_output').at(-1);
      const output = last ? JSON.parse(last.output) : null;
      let name; let args; step++;
      if (mode === 'edit') { name = step === 1 ? 'read_file' : 'propose_changes'; args = step === 1 ? { path: 'src/main.ts' } : { summary: `页面已改为 ${greeting}`, files: [{ path: 'src/main.ts', content: `document.getElementById('root').textContent='${greeting}';` }] }; }
      if (mode === 'commit') {
        if (!names.includes('git_commit')) throw new Error('Current user commit missing');
        name = ['git_status', 'git_diff', 'git_commit', 'propose_changes'][step - 1];
        args = step === 1 ? {} : step === 2 ? { commitId: null, paths: [] } : step === 3 ? { message: 'AI milestone A' } : { summary: '提交操作已完成。', files: [] };
      }
      if (mode === 'restore') {
        if (!names.includes('git_restore')) throw new Error('Current user restore missing');
        name = ['git_log', 'git_diff', 'git_restore', 'propose_changes'][step - 1];
        if (step === 2) { target = output.commits.find(commit => commit.message === 'AI milestone A').id; }
        args = step === 1 ? { limit: 10 } : step === 2 ? { commitId: null, paths: ['src/main.ts'] } : step === 3 ? { commitId: target, paths: ['src/main.ts'] } : { summary: '历史恢复已完成。', files: [] };
      }
      if (mode === 'readonly') {
        name = ['git_status', 'git_log', 'git_diff', 'propose_changes'][step - 1];
        args = step === 1 ? {} : step === 2 ? { limit: 10 } : step === 3 ? { commitId: null, paths: ['src/main.ts'] } : { summary: '已查阅 Git，未提交也未恢复。', files: [] };
      }
      const tool = { id: `fc_${step}`, type: 'function_call', call_id: `call_${step}`, name, arguments: JSON.stringify(args) };
      const events = [{ type: 'response.created', response: { id: 'resp', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...tool, arguments: '' } },
        { type: 'response.output_item.done', output_index: 0, item: tool }, { type: 'response.completed', response: { id: 'resp', status: 'completed', output: [tool] } }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, { mode, greeting });
}
