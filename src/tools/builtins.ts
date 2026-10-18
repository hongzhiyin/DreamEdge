import { Type } from 'typebox';
import { ToolRegistry } from './registry.js';

export function builtInTools(now: () => Date = () => new Date()): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({ name: 'get_current_time', version: '1', label: '获取时间',
    description: '返回当前时间的 ISO 8601 UTC 字符串和 Unix 毫秒数。',
    parameters: Type.Object({}, { additionalProperties: false }),
    effect: 'read', approval: 'never', resources: ['clock'], timeoutMs: 1000,
    async execute(_args, context) {
      context.signal.throwIfAborted();
      const date = now(); const iso = date.toISOString();
      return { content: [{ type: 'text', text: iso }], details: { iso, unixMs: date.getTime() } };
    } });
  registry.register({ name: 'add_numbers', version: '1', label: '加法',
    description: '将两个有限数字相加，返回实际计算结果。',
    parameters: Type.Object({ a: Type.Number(), b: Type.Number() }, { additionalProperties: false }),
    effect: 'read', approval: 'never', resources: ['calculator'], timeoutMs: 1000,
    async execute(args, context) {
      context.signal.throwIfAborted(); const sum = args.a + args.b;
      if (!Number.isFinite(sum)) throw new Error('Result is not finite');
      return { content: [{ type: 'text', text: String(sum) }], details: { sum } };
    } });
  return registry;
}
