'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const projectDirectory = path.resolve(__dirname, '..');
const cli = path.join(projectDirectory, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const targets = process.argv.slice(2);
const args = targets.length > 0 ? targets : ['--win', 'portable', 'nsis'];
// Reuse the exact installed runtime when packaging for the host platform.
// This avoids downloading a second Electron archive for the same version.
const runtimeDirectory = path.join(projectDirectory, 'node_modules', 'electron', 'dist');
const metadata = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'package.json'), 'utf8'));
const installed = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'node_modules', 'electron', 'package.json'), 'utf8'));
const hostTarget = process.platform === 'win32' ? '--win' : process.platform === 'darwin' ? '--mac' : '--linux';
if (args.includes(hostTarget) && !args.some(arg => ['--win', '--mac', '--linux'].includes(arg) && arg !== hostTarget)
  && !args.some(arg => /^--(?:arch|arm64|ia32|universal)/.test(arg))
  && process.arch === 'x64' && installed.version === metadata.devDependencies.electron
  && fs.existsSync(path.join(runtimeDirectory, 'version'))
  && fs.readFileSync(path.join(runtimeDirectory, 'version'), 'utf8').trim() === installed.version
  && !args.some(arg => arg.includes('electronDist') || arg.includes('electronVersion'))) {
  args.push(`--config.electronDist=${runtimeDirectory}`);
}
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
