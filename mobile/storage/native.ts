import { registerPlugin } from '@capacitor/core';
import type { StorageRequest } from '../../shared/contracts';
import type { RecordBackend } from './backend';

interface NativeStorage {
  execute(options: {
    toolId: string; operation: string; collection: string; id?: string; json?: string;
  }): Promise<{ records?: { id: string; json: string }[] }>;
}

const plugin = registerPlugin<NativeStorage>('IdeaDockStorage');

export const nativeBackend: RecordBackend = {
  async execute(toolId, request: StorageRequest) {
    const result = await plugin.execute({
      toolId, operation: request.operation, collection: request.collection,
      ...('id' in request ? { id: request.id } : {}),
      ...(request.operation === 'put' ? { json: JSON.stringify(request.value) } : {}),
    });
    if (request.operation === 'list') {
      if (!Array.isArray(result.records)) throw new Error('本地存储返回了无法识别的数据。');
      return result.records.map(row => ({ id: row.id, value: JSON.parse(row.json) }));
    }
  },
};
