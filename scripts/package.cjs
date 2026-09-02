'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectDirectory = path.resolve(__dirname, '..');
const cli = path.join(projectDirectory, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const targets = process.argv.slice(2);
const args = targets.length > 0 ? targets : ['--win', 'portable', 'nsis'];
const result = spawnSync(process.execPath, [cli, ...args], {
  cwd: projectDirectory,
  env: {
    ...process.env,
    ELECTRON_BUILDER_CACHE: path.join(projectDirectory, '.electron-builder-cache'),
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
