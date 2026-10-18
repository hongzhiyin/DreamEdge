import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import {
  ToolContractError, argumentsDigest, toolSetSnapshot, toolSnapshot, validateToolArguments,
} from '../src/index.js';
import type { ToolDefinition, ToolMetadata } from '../src/index.js';
import { connection } from './helpers/server.js';

const parameters = Type.Object({ a: Type.Number(), b: Type.Number() }, { additionalProperties: false });
const definition: ToolDefinition<typeof parameters> = {
  name: 'add_numbers', version: '1', label: '加法', description: '返回两个数的和。', parameters,
  effect: 'read', approval: 'never', resources: [], timeoutMs: 1000,
  async execute(args) { return { content: [{ type: 'text', text: String(args.a + args.b) }] }; },
};
function rejected(code: ToolContractError['code']) {
  return (error: unknown) => error instanceof ToolContractError && error.code === code;
}

test('tool arguments reject coercion, missing fields, extras and non-JSON values without executing', () => {
  const tool = toolSnapshot(definition);
  const input = { a: 2, b: 3 };
  const checked = validateToolArguments(tool, input);
  assert.deepEqual(checked, input); assert.notEqual(checked, input);
  for (const args of [{ a: '2', b: 3 }, { a: 2 }, { a: 2, b: 3, key: 'extra' },
    { a: Infinity, b: 3 }, { a: undefined, b: 3 }, null, [], new Date()]) {
    assert.throws(() => validateToolArguments(tool, args), rejected('INVALID_TOOL_ARGUMENTS'));
  }
});

test('portable nested schemas preserve constraints and TypeBox literals', () => {
  const tool = toolSnapshot({ ...definition, parameters: Type.Object({
    mode: Type.Union([Type.Literal('sum'), Type.Literal('count')]),
    tags: Type.Array(Type.String({ minLength: 2 }), { minItems: 1 }),
    limits: Type.Object({ max: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  }, { additionalProperties: false }) });
  assert.deepEqual(validateToolArguments(tool, { mode: 'sum', tags: ['ok'], limits: { max: 1 } }),
    { mode: 'sum', tags: ['ok'], limits: { max: 1 } });
  for (const args of [{ mode: 'bad', tags: ['ok'], limits: { max: 1 } },
    { mode: 'sum', tags: ['x'], limits: { max: 1 } }, { mode: 'sum', tags: ['ok'], limits: { max: 0 } },
    { mode: 'sum', tags: ['ok'], limits: { max: 1, extra: true } }]) {
    assert.throws(() => validateToolArguments(tool, args), rejected('INVALID_TOOL_ARGUMENTS'));
  }
});

test('tool snapshots cannot be changed by source edits and contain no callbacks or host-only fields', () => {
  const schema = Type.Object({ text: Type.String() }, { additionalProperties: false });
  const resources = ['fixture:record'];
  const source = { ...definition, parameters: schema, resources, credentialRef: 'host-only' };
  const snapshot = toolSnapshot(source);
  Object.assign(schema.properties.text, { minLength: 99 }); resources.push('fixture:other');
  assert.deepEqual(snapshot.resources, ['fixture:record']);
  assert.equal((snapshot.parameters.properties as Record<string, { minLength?: number }>).text!.minLength, undefined);
  assert.throws(() => { (snapshot.parameters as Record<string, unknown>).extra = true; }, TypeError);
  assert.throws(() => { (snapshot.resources as string[]).push('changed'); }, TypeError);
  assert.ok(!JSON.stringify(snapshot).includes('host-only'));
  assert.ok(!('execute' in snapshot));
});

test('definitions reject malformed metadata, unsupported schema and unconfirmed writes', () => {
  for (const patch of [{ name: undefined }, { name: 'bad name' }, { timeoutMs: 0 },
    { effect: 'write', approval: 'never' }, { resources: [''] },
    { parameters: { type: 'array', items: { type: 'string' } } },
    { parameters: { type: 'object', properties: {}, additionalProperties: false, required: 'field' } },
    { parameters: { type: 'object', properties: { field: { type: 'invalid' } }, additionalProperties: false } },
    { parameters: { type: 'object', properties: { field: { $ref: 'https://example.com/schema' } }, additionalProperties: false } }]) {
    assert.throws(() => toolSnapshot({ ...definition, ...patch } as ToolMetadata), rejected('INVALID_TOOL_DEFINITION'));
  }
});

test('enabled tool snapshots require explicit capability for the requested thinking level', () => {
  const base = connection('http://127.0.0.1:1');
  assert.deepEqual(toolSetSnapshot([definition], [], base, 'high'), []);
  assert.throws(() => toolSetSnapshot([definition], ['add_numbers'], base, 'high'), rejected('UNSUPPORTED_TOOLS'));
  const enabled = { ...base, toolCalling: { supported: true as const, supportedThinkingLevels: ['off' as const] } };
  assert.throws(() => toolSetSnapshot([definition], ['add_numbers'], enabled, 'high'), rejected('UNSUPPORTED_TOOLS'));
  const tools = toolSetSnapshot([definition], ['add_numbers'], enabled, 'off');
  assert.equal(tools.length, 1); assert.ok(Object.isFrozen(tools));
  assert.throws(() => toolSetSnapshot([definition], ['missing'], enabled, 'off'), rejected('UNKNOWN_TOOL'));
  assert.throws(() => toolSetSnapshot([definition, definition], [], enabled, 'off'), rejected('DUPLICATE_TOOL'));
  assert.throws(() => toolSetSnapshot([definition], ['add_numbers', 'add_numbers'], enabled, 'off'), rejected('DUPLICATE_TOOL'));
});

test('argument digests ignore object key order but retain values, arrays and numeric types', () => {
  assert.equal(argumentsDigest({ b: [2, 3], a: { y: 1, x: 2 } }), argumentsDigest({ a: { x: 2, y: 1 }, b: [2, 3] }));
  assert.notEqual(argumentsDigest({ a: 1 }), argumentsDigest({ a: '1' }));
  assert.notEqual(argumentsDigest([1, 2]), argumentsDigest([2, 1]));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const input of [cycle, { field: undefined }, [undefined], Array(1), NaN, new Date(), { get field() { throw new Error(); } }]) {
    assert.throws(() => argumentsDigest(input), rejected('INVALID_JSON'));
  }
});
