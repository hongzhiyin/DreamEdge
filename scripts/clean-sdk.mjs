import { rm } from 'node:fs/promises';
await rm('packages/sdk/dist', { recursive: true, force: true });
