import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createCredentialResolver, ModelAdapterError, parseModelConnection, PiRuntime } from '../src/index.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'config/deepseek.example.json' },
    credentials: { type: 'string', default: 'config/credentials.local.json' },
    prompt: { type: 'string', default: '请只用一句话回复：模型连接正常。' },
    'cancel-after-ms': { type: 'string' },
  } });
  let input: unknown;
  try { input = JSON.parse(await readFile(values.config, 'utf8')); }
  catch { throw new ModelAdapterError('INVALID_CONFIG', '无法读取模型连接配置。'); }
  const runtime = new PiRuntime(parseModelConnection(input), createCredentialResolver({
    credentialsFile: values.credentials,
  }));
  const delay = values['cancel-after-ms'] === undefined ? undefined : Number(values['cancel-after-ms']);
  if (delay !== undefined && (!Number.isSafeInteger(delay) || delay < 0 || delay > 2_147_483_647)) {
    throw new ModelAdapterError('INVALID_CONFIG', '取消延时必须为有效毫秒数。');
  }
  const handle = runtime.start({
    sessionId: randomUUID(), runId: randomUUID(),
    messages: [{ role: 'user', content: values.prompt, timestamp: Date.now() }],
  }, event => {
    if (event.type === 'delta' && event.channel === 'text') process.stdout.write(event.delta);
    if (event.type === 'started') {
      for (const notice of event.notices) process.stderr.write(`${notice}\n`);
    }
  });
  const cancel = () => handle.cancel();
  process.once('SIGINT', cancel);
  const timer = delay === undefined ? undefined : setTimeout(cancel, delay);
  try {
    const result = await handle.done;
    process.stdout.write('\n');
    process.stderr.write(`${JSON.stringify({
      status: result.status, stopReason: result.stopReason, thinkingLevel: result.thinkingLevel,
      inputTokens: result.message?.usage.input, outputTokens: result.message?.usage.output,
      error: result.error,
    })}\n`);
    process.exitCode = result.status === 'failed' ? 1 : result.status === 'cancelled' ? 130 : 0;
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener('SIGINT', cancel);
  }
}

void main().catch(error => {
  const message = error instanceof ModelAdapterError ? `${error.code}: ${error.message}` : '模型连接检查无法执行。';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
