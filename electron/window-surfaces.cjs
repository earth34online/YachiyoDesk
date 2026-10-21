'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

class WindowSurfaces {
  constructor(screen, onError = () => {}, launch = spawn) {
    this.screen = screen; this.onError = onError; this.launch = launch;
    this.child = null; this.pending = null; this.buffer = ''; this.generation = 0;
  }
  read() {
    if (process.platform !== 'win32') return Promise.resolve([]);
    if (this.pending) return this.pending.promise;
    if (!this.child) {
      const generation = ++this.generation;
      // PowerShell is external to Electron and cannot read inside app.asar.
      const helper = /[\\/]app\.asar[\\/]/.test(__dirname)
        ? path.join(process.resourcesPath, 'window-surfaces.ps1') : path.join(__dirname, 'window-surfaces.ps1');
      const child = this.launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-File', helper, '-ExcludeProcessId', String(process.pid)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child; this.buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (generation !== this.generation) return;
        this.buffer += chunk;
        const end = this.buffer.indexOf('\n');
        if (end < 0) return;
        const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
        try {
          const records = JSON.parse(line);
          if (!Array.isArray(records)) throw new Error('Invalid window boundary response');
          const surfaces = records.flatMap(record => {
            if (typeof record.id !== 'string' || !/^[0-9]+$/.test(record.id)
              || !['x','y','width','height'].every(key => Number.isFinite(record[key]))
              || record.width <= 0 || record.height <= 0) return [];
            return [{ id: record.id, ...this.screen.screenToDipRect(null,
              { x: record.x, y: record.y, width: record.width, height: record.height }) }];
          });
          this.finish(surfaces);
        } catch (error) { this.fail(error); }
      });
      // Drain stderr without exposing desktop metadata to logs.
      child.stderr.on('data', () => {});
      child.on('error', error => { if (generation === this.generation) this.fail(error); });
      child.on('exit', () => { if (generation === this.generation) this.fail(new Error('Window boundary helper exited')); });
      child.stdin.on('error', error => { if (generation === this.generation) this.fail(error); });
    }
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    // Cold Add-Type compilation may take seconds; only one request is in
    // flight, and a hung helper cannot hold the app open indefinitely.
    this.pending = { promise, resolve, timer: setTimeout(() => this.fail(new Error('Window boundary helper timed out')), 10000) };
    this.child.stdin.write('read\n');
    return promise;
  }
  finish(value) {
    const pending = this.pending; this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(value); }
  }
  fail(error) { this.onError(error); this.stop(); }
  stop() {
    ++this.generation;
    const child = this.child; this.child = null; this.buffer = '';
    this.finish([]);
    if (child) { child.stdin.end(); child.kill(); }
  }
}
module.exports = { WindowSurfaces };
