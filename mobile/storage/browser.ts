import type { RecordBackend } from './backend';
import type { Json, StoredRecord } from '../../shared/contracts';

interface Row { toolId: string; collection: string; id: string; value: Json }

// The browser preview uses IndexedDB; installed iPhone apps use native SQLite.
export function createBrowserBackend(name = 'ideadock-mobile-preview'): RecordBackend {
  let connection: Promise<IDBDatabase> | undefined;
  function open(): Promise<IDBDatabase> {
    return connection ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('records', { keyPath: ['toolId', 'collection', 'id'] });
        store.createIndex('collection', ['toolId', 'collection']);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { connection = undefined; reject(new Error('无法打开浏览器本地存储。')); };
      request.onblocked = () => { connection = undefined; reject(new Error('存储升级被其他页面阻止，请关闭其他预览窗口。')); };
    });
  }
  return {
    async execute(toolId, request) {
      const db = await open();
      return new Promise<StoredRecord[] | void>((resolve, reject) => {
        const transaction = db.transaction('records', request.operation === 'list' ? 'readonly' : 'readwrite');
        const store = transaction.objectStore('records');
        let result: StoredRecord[] | undefined;
        if (request.operation === 'list') {
          const read = store.index('collection').getAll(IDBKeyRange.only([toolId, request.collection]));
          read.onsuccess = () => { result = (read.result as Row[]).map(row => ({ id: row.id, value: row.value })); };
        } else if (request.operation === 'put') {
          store.put({ toolId, collection: request.collection, id: request.id, value: request.value });
        } else {
          store.delete([toolId, request.collection, request.id]);
        }
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(new Error('本地存储操作失败，请重试。'));
        transaction.onabort = () => reject(new Error('存储操作已取消，请重新读取记录。'));
      });
    },
  };
}
