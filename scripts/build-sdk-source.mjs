import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['packages/sdk/src/index.ts'], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, minify: true });
await writeFile('desktop/build/sdk-browser.ts', `// Generated from the public SDK by scripts/build-sdk-source.mjs.\nexport const sdkBrowserSource = ${JSON.stringify(result.outputFiles[0].text)};\n`);
