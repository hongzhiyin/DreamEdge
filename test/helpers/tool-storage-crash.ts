import { SqliteSessionStore } from '../../src/index.js';
import { pendingConversation } from './tool-storage.js';

const store = new SqliteSessionStore(process.argv[2]!);
store.save(pendingConversation('write'), null);
process.stdout.write('TOOL_INTENT_COMMITTED\n');
setInterval(() => {}, 1000);
