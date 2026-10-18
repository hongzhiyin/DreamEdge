import { isFileTool, isMutationName } from '../files/managed-tools.js';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ChatToolCall } from './types.js';
import type { FileDestination } from '../files/scope-types.js';

const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonObject : undefined;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
export function fileResultView(call: ChatToolCall) {
  if (!isFileTool(call.version)
    || (!['read', 'ls', 'find', 'grep'].includes(call.name) && !isMutationName(call.name))) return;
  const details = object(call.result?.details); const access = object(details?.fileAccess);
  const path = call.preview?.path ?? (typeof access?.path === 'string' ? access.path
    : call.resources[0] ?? (typeof call.args.path === 'string' ? call.args.path : '.'));
  const destination = object(access?.destination) ?? object(call.preview?.binding.destination);
  const notices: string[] = [];
  const truncation = object(details?.truncation);
  if (truncation?.truncated === true) notices.push('工具输出已截断，结果不完整。');
  if (truncation?.firstLineExceedsLimit === true) notices.push('单行超过输出限制，未返回完整内容。');
  for (const [key, label] of [['entryLimitReached', '目录项'], ['resultLimitReached', '文件结果'], ['matchLimitReached', '匹配项']]) {
    const limit = count(details?.[key!]);
    if (limit !== undefined) notices.push(`${label}达到 ${limit} 项上限，结果可能不完整。`);
  }
  if (details?.linesTruncated === true) notices.push('部分匹配行已截断。');
  const files = Array.isArray(access?.files) ? access.files.map(object).filter(Boolean) : [];
  const image = call.result?.content.some(block => block.type === 'image');
  const offset = count(call.args.offset) ?? 1; const limit = count(call.args.limit);
  const window = call.name === 'read' ? (image ? '图片读取' : `请求窗口：第 ${offset} 行起${limit === undefined ? '' : `，最多 ${limit} 行`}`) : undefined;
  if (call.name === 'read' && !image && files.length && !files.every(file => file?.complete === true)) {
    notices.push('这是部分读取，不能据此覆盖整个文件。');
  }
  const receipt = object(details?.fileMutation);
  const mutation = receipt?.commit === 'confirmed'
    ? receipt.verified === true ? '已写入并核对文件版本。' : '已发布变更，后续版本核对未完成；请重新读取核对。' : undefined;
  return { path, window, notices, mutation,
    destination: destination && ['model', 'baseUrl'].every(key => typeof destination[key] === 'string')
      ? `${destination.model} · ${(destination as unknown as FileDestination).baseUrl}` : undefined,
    entries: count(access?.entries), bytes: count(access?.bytes), skipped: count(access?.skipped) };
}
