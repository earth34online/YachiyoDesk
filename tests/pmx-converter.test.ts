import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolvePmxConverter, validatePmxSource } = require('../electron/pmx-converter.cjs') as {
  resolvePmxConverter: (options: {
    blenderPath?: string;
    scriptPath?: string;
    blenderUserResources?: string;
    moduleDirectory?: string;
    resourcesPath?: string;
  }) => { blenderPath: string; scriptPath: string; blenderUserResources: string };
  validatePmxSource: (sourcePath: string) => fs.Stats;
};

describe('PMX conversion boundary', () => {
  it('accepts only a real PMX 2.x header and rejects renamed files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-pmx-'));
    try {
      const valid = path.join(directory, 'valid.pmx');
      fs.writeFileSync(valid, Buffer.concat([Buffer.from('PMX '), Buffer.alloc(64)]));
      expect(validatePmxSource(valid).size).toBe(68);

      const renamed = path.join(directory, 'renamed.pmx');
      fs.writeFileSync(renamed, Buffer.concat([Buffer.from('glTF'), Buffer.alloc(64)]));
      expect(() => validatePmxSource(renamed)).toThrow('文件头不是有效的 PMX');
      expect(() => validatePmxSource(path.join(directory, 'valid.vrm'))).toThrow('扩展名为 .pmx');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resolves explicitly installed Blender, script and isolated user resources', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-converter-'));
    try {
      const blenderPath = path.join(directory, 'blender.exe');
      const scriptPath = path.join(directory, 'pmx_to_vrm.py');
      const resources = path.join(directory, 'blender-user');
      fs.writeFileSync(blenderPath, 'test');
      fs.writeFileSync(scriptPath, 'test');
      const resolved = resolvePmxConverter({ blenderPath, scriptPath, blenderUserResources: resources });
      expect(resolved).toEqual({ blenderPath, scriptPath, blenderUserResources: resources });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
