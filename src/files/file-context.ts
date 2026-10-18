import { isFileTool } from './managed-tools.js';
import type { Message, JsonObject } from '@earendil-works/pi-ai';
import type { RunRecord } from '../conversation/types.js';
import type { ModelConnectionConfig } from '../model/types.js';
import { fileDestination } from './scope-types.js';
import { sameDestination } from './scope-validation.js';
import { ModelAdapterError } from '../model/errors.js';
import { ConversationError } from '../conversation/state.js';
import { readToolNames } from './read-limits.js';

export const fileContextNotice = '历史文件内容仅授权原模型服务；请恢复原连接或新建空对话。';
const scoped = (run: RunRecord) => run.toolCalls?.some(call => call.status === 'succeeded'
  && isFileTool(call.toolVersion));
export function assertFileHistory(runs: readonly RunRecord[], config: ModelConnectionConfig): void {
  const target = fileDestination(config);
  if (runs.some(run => scoped(run) && !sameDestination(fileDestination(run.modelConfigSnapshot), target))) {
    throw new ConversationError('FILE_CONTEXT_DESTINATION', fileContextNotice);
  }
}
/** Checks before every provider request, including retained assistant text derived from files. */
export function guardFileContext(runs: readonly RunRecord[], config: ModelConnectionConfig,
  current: ModelConnectionConfig, messages: readonly Message[]): void {
  try { assertFileHistory(runs, config); }
  catch { throw new ModelAdapterError('INVALID_CONTEXT', fileContextNotice); }
  for (const message of messages) {
    if (message.role !== 'toolResult' || !message.details || typeof message.details !== 'object') continue;
    const access = (message.details as JsonObject).fileAccess as JsonObject | undefined;
    if (!access || access.format !== 'dreamedge-file-result/v1') continue;
    if (!sameDestination(access.destination as unknown as ReturnType<typeof fileDestination>, fileDestination(config))
      || !sameDestination(fileDestination(config), fileDestination(current))) {
      throw new ModelAdapterError('INVALID_CONTEXT', fileContextNotice);
    }
  }
  if (runs.some(scoped) && !sameDestination(fileDestination(config), fileDestination(current))) {
    throw new ModelAdapterError('INVALID_CONTEXT', fileContextNotice);
  }
}
