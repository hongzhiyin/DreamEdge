#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../build/app.mjs';
import { createApp } from './create.mjs';

const [command, ...args] = process.argv.slice(2);
if (command === 'create') {
  const options = {};
  for (let i = 1; i < args.length; i += 2) options[args[i]?.replace(/^--/, '')] = args[i + 1];
  await createApp(args[0], options);
} else if (command === 'build' || command === 'package') {
  await buildApp();
  if (command === 'package') {
    const require = createRequire(`${process.cwd()}/package.json`);
    const entry = require.resolve('electron-builder/out/cli/cli.js');
    const result = spawnSync(process.execPath, [entry, '--config', 'dist/builder.json', '--publish', 'never', ...args], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
} else {
  console.log('dreamedge create <目录> --name ... --id ... --runtime ... --sdk ... --cli ...\ndreamedge build\ndreamedge package [electron-builder 参数]');
  if (command) process.exitCode = 1;
}
