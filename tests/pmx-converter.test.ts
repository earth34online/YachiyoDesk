import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { describePmxConversionFailure, resolvePmxConverter, validatePmxSource, inspectConverterDependencies } = require('../electron/pmx-converter.cjs') as {
  inspectConverterDependencies: (converter: { blenderUserResources: string }) => void;
  describePmxConversionFailure: (error: { message: string; report?: Record<string, unknown> }) => string;
  resolvePmxConverter: (options: {
    blenderPath?: string;
    scriptPath?: string;
    blenderUserResources?: string;
    moduleDirectory?: string;
    resourcesPath?: string;
    programFiles?: string;
    appData?: string;
  }) => { blenderPath: string; scriptPath: string; blenderUserResources: string };
  validatePmxSource: (sourcePath: string) => fs.Stats;
};

describe('PMX conversion boundary', () => {
  it.each(['PASS', 'FAIL'])('recovers a fresh native crash even when an older %s report exists', async (previousResult) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-report-retry-'));
    try {
      const sourcePath = path.join(directory, 'model.pmx'), outputPath = path.join(directory, 'model.vrm');
      const reportPath = path.join(directory, 'report.json');
      fs.writeFileSync(sourcePath, Buffer.concat([Buffer.from('PMX '), Buffer.alloc(64)]));
      fs.writeFileSync(reportPath, JSON.stringify({ result: previousResult, error: 'old result' }));
      for (const name of ['mmd_tools', 'vrm']) {
        const addon = path.join(directory, 'extensions', 'blender_org', name);
        fs.mkdirSync(addon, { recursive: true });
        for (const file of ['__init__.py', 'blender_manifest.toml']) fs.writeFileSync(path.join(addon, file), '');
      }
      const attempts: string[][] = [];
      const spawn = (_executable: string, args: string[]) => {
        attempts.push(args);
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
        queueMicrotask(() => {
          if (attempts.length === 1) child.emit('close', 139, null);
          else {
            fs.writeFileSync(args[args.indexOf('--') + 3], JSON.stringify({ result: 'PASS', fresh: true }));
            fs.writeFileSync(outputPath, 'fresh model');
            child.emit('close', 0, null);
          }
        });
        return child;
      };
      const module = { exports: {} as any };
      vm.runInNewContext(fs.readFileSync(path.resolve('electron/pmx-converter.cjs'), 'utf8'), {
        module, exports: module.exports, __dirname: path.resolve('electron'), process, Buffer, setTimeout, clearTimeout,
        require: (name: string) => name === 'node:child_process' ? { spawn } : require(name),
      });
      const result = await module.exports.convertPmxToVrm({ sourcePath, outputPath, reportPath,
        converter: { blenderPath: 'fake', scriptPath: 'fake', blenderUserResources: directory } });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).not.toContain('--compatibility-mode');
      expect(attempts[1]).toContain('--compatibility-mode');
      expect(attempts[0][attempts[0].indexOf('--') + 3]).not.toBe(attempts[1][attempts[1].indexOf('--') + 3]);
      expect(result.report).toEqual({ result: 'PASS', fresh: true });
      expect(JSON.parse(fs.readFileSync(reportPath, 'utf8'))).toEqual(result.report);
      expect(fs.readdirSync(directory).filter(name => name.includes('.attempt-'))).toEqual([]);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('fails before launching Blender when either extension is missing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-addons-'));
    try {
      expect(() => inspectConverterDependencies({ blenderUserResources: directory })).toThrow('mmd_tools、vrm');
      for (const name of ['mmd_tools', 'vrm']) {
        const addon = path.join(directory, 'extensions', 'blender_org', name);
        fs.mkdirSync(addon, { recursive: true });
        fs.writeFileSync(path.join(addon, '__init__.py'), '');
        fs.writeFileSync(path.join(addon, 'blender_manifest.toml'), `id = "${name}"`);
      }
      expect(() => inspectConverterDependencies({ blenderUserResources: directory })).not.toThrow();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('finds an ordinary Windows installation and uses the matching native resource directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-install-'));
    try {
      const programFiles = path.join(directory, 'Program Files'), appData = path.join(directory, 'AppData');
      const blenderPath = path.join(programFiles, 'Blender Foundation', 'Blender 4.5', 'blender.exe');
      fs.mkdirSync(path.dirname(blenderPath), { recursive: true }); fs.writeFileSync(blenderPath, 'test');
      const scriptPath = path.join(directory, 'convert.py'); fs.writeFileSync(scriptPath, '');
      const resolved = resolvePmxConverter({ programFiles, appData, moduleDirectory: path.join(directory, 'app', 'electron'), scriptPath });
      expect(resolved.blenderPath).toBe(blenderPath);
      expect(resolved.blenderUserResources).toBe(path.join(appData, 'Blender Foundation', 'Blender', '4.5'));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('reports missing textures and mapping failures rather than a generic export error', () => {
    expect(describePmxConversionFailure({
      message: 'PMX conversion failed',
      report: { stage: 'pmx-import', missingTextures: [{ expected: 'C:\\model\\TEX\\cloth.png' }] },
    })).toContain('cloth.png');
    expect(describePmxConversionFailure({
      message: 'PMX conversion failed',
      report: { stage: 'humanoid-mapping', error: 'Missing leftLowerLeg' },
    })).toContain('Missing leftLowerLeg');
    expect(describePmxConversionFailure({
      message: 'PMX conversion failed',
      report: { stage: 'vrm-export', error: 'VRM export failed: CANCELLED' },
    })).toContain('VRM 导出失败');
  });
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
