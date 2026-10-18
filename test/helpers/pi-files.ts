import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { loadPiFileTools } from '../../src/index.js';
import type { PiFileToolName, ToolExecutionContext } from '../../src/index.js';

/** Test-only namespace; this is not the production directory authorization implementation. */
export async function piFiles(t: TestContext) {
  const directory = await mkdtemp(resolve(tmpdir(), 'dreamedge-pi-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pi = await import('@earendil-works/pi-coding-agent');
  const source = { read: pi.createReadTool(directory), ls: pi.createLsTool(directory),
    find: pi.createFindTool(directory, { operations: { exists: async () => true, glob: async () => ['input.txt'] } }),
    grep: pi.createGrepTool(directory), write: pi.createWriteTool(directory), edit: pi.createEditTool(directory) };
  const counts = { authorize: 0, prepare: 0, dispose: 0 };
  const definitions = await loadPiFileTools({
    async authorize(_name, args) {
      counts.authorize++;
      const path = resolve(directory, typeof args.path === 'string' ? args.path : '.'); const tail = relative(directory, path);
      if (tail === '..' || tail.startsWith('../') || isAbsolute(tail)) throw new Error('fixture denied');
    },
    async prepare(name) { counts.prepare++; return { tool: source[name], async dispose() { counts.dispose++; } }; },
  });
  await writeFile(resolve(directory, 'input.txt'), 'alpha\nbeta\ngamma\n');
  const execute = (name: PiFileToolName, args: unknown, signal = new AbortController().signal) =>
    definitions.find(tool => tool.name === name)!.execute(args, { sessionId: 'fixture', runId: 'run',
      turnId: 'turn', toolCallId: name, signal } satisfies ToolExecutionContext);
  return { definitions, counts, directory, source, execute };
}
