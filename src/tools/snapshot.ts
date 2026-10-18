import { mcpToolOrigin, mcpOriginAlias } from './mcp-origin.js';
import type { ModelConnectionConfig, ThinkingLevel } from '../model/types.js';
import { ToolContractError } from './errors.js';
import { argumentsDigest, freezeDeep } from './json.js';
import { parameterSchema } from './schema.js';
import type { ToolMetadata, ToolSnapshot } from './types.js';

export function toolSnapshot(source: ToolMetadata): ToolSnapshot {
  const invalid = (): never => { throw new ToolContractError('INVALID_TOOL_DEFINITION', '工具定义无效。'); };
  if (!source || typeof source.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(source.name)) invalid();
  for (const value of [source.version, source.label, source.description]) {
    if (typeof value !== 'string' || !value.trim()) invalid();
  }
  if (!['read', 'write'].includes(source.effect) || !['never', 'always'].includes(source.approval)
    || (source.effect === 'write' && source.approval !== 'always')) invalid();
  if (!Number.isSafeInteger(source.timeoutMs) || source.timeoutMs <= 0 || source.timeoutMs > 2_147_483_647) invalid();
  if (!Array.isArray(source.resources) || source.resources.some(value => typeof value !== 'string' || !value.trim())) invalid();
  if (source.origin) {
    const origin = mcpToolOrigin(source.origin);
    if ((origin.kind === 'mcp-resource' && origin.toolName !== 'resources/read')
      || source.effect !== (origin.kind === 'mcp-resource' || origin.readGrantDigest ? 'read' : 'write')
      || source.approval !== (origin.readGrantDigest ? 'never' : 'always')
      || origin.schemaDigest !== argumentsDigest(source.parameters)
      || source.version !== `mcp-${argumentsDigest(origin)}`
      || source.name !== mcpOriginAlias(origin)) invalid();
  }
  return freezeDeep({ ...(source.origin ? { origin: mcpToolOrigin(source.origin) } : {}), name: source.name, version: source.version, label: source.label,
    description: source.description, parameters: parameterSchema(source.parameters),
    effect: source.effect, approval: source.approval, resources: [...source.resources], timeoutMs: source.timeoutMs });
}

export function toolSetSnapshot(
  definitions: readonly ToolMetadata[], enabledNames: readonly string[],
  connection: ModelConnectionConfig, thinkingLevel: ThinkingLevel,
): readonly ToolSnapshot[] {
  const catalog = new Map<string, ToolSnapshot>();
  for (const definition of definitions) {
    const snapshot = toolSnapshot(definition);
    if (catalog.has(snapshot.name)) throw new ToolContractError('DUPLICATE_TOOL', '工具名称重复。');
    catalog.set(snapshot.name, snapshot);
  }
  if (new Set(enabledNames).size !== enabledNames.length) throw new ToolContractError('DUPLICATE_TOOL', '启用工具名称重复。');
  const selected = enabledNames.map(name => {
    const tool = catalog.get(name);
    if (!tool) throw new ToolContractError('UNKNOWN_TOOL', '指定的工具未注册。');
    return tool;
  });
  if (selected.length && (!connection.toolCalling?.supported
    || !connection.toolCalling.supportedThinkingLevels.includes(thinkingLevel))) {
    throw new ToolContractError('UNSUPPORTED_TOOLS', '模型连接未声明支持当前思考强度下的工具调用。');
  }
  return Object.freeze(selected);
}
