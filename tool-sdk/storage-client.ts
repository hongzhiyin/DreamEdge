import type { Json, StoredRecord } from '../shared/contracts';

export interface StorageClient {
  list(collection: string): Promise<StoredRecord[]>;
  put(collection: string, id: string, value: Json): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
}
