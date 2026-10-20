import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

describe('local model streaming', () => {
  it('forwards the unconsumed stream and cancellation without buffering the model in Node', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-asset-stream-'));
    try {
      fs.mkdirSync(path.join(directory, 'characters'));
      fs.writeFileSync(path.join(directory, 'characters', '模型 #1.vrm'), 'fixture');
      const source = new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Length': '3' } });
      const fetch = vi.fn(async () => source), handle = vi.fn();
      const mainPath = path.resolve('electron/main.cjs'), localRequire = createRequire(mainPath);
      const electron = { net: { fetch }, protocol: { handle, registerSchemesAsPrivileged: vi.fn() },
        app: { requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on: vi.fn(), getPath: () => directory } };
      const context = vm.createContext({ require: (name: string) => name === 'electron' ? electron : localRequire(name),
        __dirname: path.dirname(mainPath), Buffer, URL, Headers, Response, setTimeout, clearTimeout,
        process: { argv: [], env: {}, platform: 'win32', stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn() } });
      vm.runInContext(fs.readFileSync(mainPath, 'utf8') + '\nglobalThis.register = registerAssetProtocol;', context);
      await context.register();
      const handler = handle.mock.calls[0][1], signal = new AbortController().signal;
      const response = await handler({ url: 'appasset://user-characters/' + encodeURIComponent('模型 #1.vrm'), signal });
      expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^file:.*%23/), { signal });
      expect(source.bodyUsed).toBe(false);
      expect(response.body).toBe(source.body);
      expect(response.headers.get('Content-Length')).toBe('3');
      expect(response.headers.get('Content-Type')).toBe('model/gltf-binary');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
      const missing = await handler({ url: 'appasset://user-characters/missing.vrm', signal });
      expect(missing.status).toBe(404); expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
