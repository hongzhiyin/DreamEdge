import { preview } from 'vite';
import { resolve } from 'node:path';

const server = await preview({
  configFile: false, root: resolve('mobile'),
  build: { outDir: resolve('dist/mobile') },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
});
server.printUrls();
