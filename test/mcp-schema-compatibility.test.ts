import assert from 'node:assert/strict';
import test from 'node:test';
import { parameterSchema, validateToolArguments } from '../src/tools/schema.js';
import { toolSnapshot } from '../src/tools/snapshot.js';
function tool(parameters: unknown) {
  return toolSnapshot({ name: 'standard_tool', version: '1', label: 'Standard', description: 'Generic',
    parameters: parameters as never, effect: 'write', approval: 'always', resources: [], timeoutMs: 1000 });
}
test('draft-07 metadata and omitted additionalProperties retain their original JSON semantics', () => {
  const schema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {
    params: { type: 'object', properties: { page: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['page'], additionalProperties: false } } };
  assert.deepEqual(parameterSchema(schema), schema);
  assert.deepEqual(validateToolArguments(tool(schema), { extra: 'allowed', params: { page: 1 } }), { extra: 'allowed', params: { page: 1 } });
  for (const params of [{}, { page: 0 }, { page: 2001 }, { page: 1.5 }, { page: 1, extra: true }]) {
    assert.throws(() => validateToolArguments(tool(schema), { params }));
  }
});
test('oneOf retains exact-one matching and default is not injected into arguments', () => {
  const schema = { type: 'object', properties: { choice: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
    label: { type: 'string', default: 'default text' } }, required: ['choice'], additionalProperties: false };
  const snapshot = tool(schema); assert.deepEqual(validateToolArguments(snapshot, { choice: 1.5 }), { choice: 1.5 });
  assert.throws(() => validateToolArguments(snapshot, { choice: 1 }));
  assert.throws(() => validateToolArguments(snapshot, { choice: 'invalid' }));
});
test('unsupported dialects and remote references remain rejected rather than silently stripped', () => {
  for (const extension of [{ $schema: 'https://untrusted.invalid/schema' }, { $ref: 'https://untrusted.invalid/type' }, { dependentRequired: {} }]) {
    assert.throws(() => parameterSchema({ type: 'object', properties: {}, ...extension }));
  }
});
