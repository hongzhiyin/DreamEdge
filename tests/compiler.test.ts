import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../desktop/build/compiler';
import { BuildFailure } from '../desktop/build/types';

test('compiler bundles local TypeScript, relative imports, JSON and CSS without executing source', async () => {
  const result = await compile({ files: {
    'index.html': '<div id="root"></div><script src="./main.ts" type="module"></script>',
    'main.ts': 'import { greeting } from "./components/message"; import data from "./data.json"; import "./style.css"; document.body.textContent = greeting + data.suffix;',
    'components/message.ts': 'export const greeting: string = "Hello";', 'data.json': '{"suffix":" DreamEdge"}',
    'style.css': 'body { color: blue; }',
  } });
  assert.match(result.files['index.html'], /__dreamedge_bundle\/module0.js/);
  assert.match(result.files['index.html'], /__dreamedge_bundle\/module0.css/);
  assert.match(result.files['__dreamedge_bundle/module0.js'], /DreamEdge/);
  assert.match(result.files['__dreamedge_bundle/module0.css'], /blue/);
  assert.equal(result.files['main.ts'], undefined);
});
test('compiler refuses filesystem, Node, npm and remote imports even when they exist outside the snapshot', async () => {
  for (const path of ['node:fs', 'react', '/etc/passwd', '../../outside.js', 'https://example.com/secret.js']) {
    await assert.rejects(compile({ files: { 'index.html': '<script type="module" src="./main.ts"></script>',
      'main.ts': `import ${JSON.stringify(path)};` } }), BuildFailure);
  }
});
test('syntax errors produce bounded source diagnostics and no usable artifacts', async () => {
  await assert.rejects(compile({ files: { 'index.html': '<script type="module" src="./main.ts"></script>',
    'main.ts': 'const broken: = ;' } }), (error: unknown) => {
    assert.ok(error instanceof BuildFailure); assert.equal(error.logs[0].level, 'error');
    assert.equal(error.logs[0].path, 'main.ts'); assert.ok(error.logs[0].line); return true;
  });
});
test('HTML parsing preserves text and rejects unsupported executable or escaping entries', async () => {
  const staticPage = await compile({ files: { 'index.html': '<h1>HelloWorld &amp; DreamEdge</h1>' } });
  assert.match(staticPage.files['index.html'], /HelloWorld &amp; DreamEdge/);
  for (const html of ['<script>alert(1)</script>', '<base href="file:///">', '<iframe src="https://example.com"></iframe>',
    '<script type="module" src="../outside.ts"></script>', '<script type="module" src="./data.json"></script>']) {
    await assert.rejects(compile({ files: { 'index.html': html } }), BuildFailure);
  }
});
