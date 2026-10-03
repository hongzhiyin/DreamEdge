import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, proposal } from './development-fixture';
import { WorkspaceApi } from '../desktop/workspace/api';
import type { WorkspaceStatus } from '../shared/contracts';

test('interrupted source swaps recover from their short-lived journal without creating a separate version history', async () => {
  for (const phase of ['prepared', 'source-backed-up', 'source-installed', 'metadata-installed', 'committed']) {
    const f = await fixture(async () => proposal);
    try {
      const original = await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8');
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/change-crash-fixture.ts')], { stdio: ['pipe', 'ignore', 'pipe'] });
      child.stdin.end(JSON.stringify({ profile: f.profile, framework: f.framework, projectId: f.project.definition.id, phase }));
      await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', (_code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error('Crash fixture failed'))); });
      const restored = new WorkspaceApi(f.profile, f.framework);
      const status = await restored.execute({ operation: 'current' }) as WorkspaceStatus;
      assert.ok(status.project, status.recoveryError ?? '');
      const source = await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8');
      if (phase === 'committed') assert.match(source, /Crash edit/); else assert.equal(source, original);
      await assert.rejects(readFile(join(f.project.rootDirectory, '.dreamedge/transaction/journal.json')), { code: 'ENOENT' });
    } finally { await f.cleanup(); }
  }
});
