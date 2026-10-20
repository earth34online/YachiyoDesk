import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const { planSync, applySync } = createRequire(import.meta.url)('../scripts/sync-local.cjs');
const directories: string[] = [];
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-sync-')); directories.push(parent);
  const source = path.join(parent, 'YachiyoDesk-public'), target = path.join(parent, 'YachiyoDesk');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.mkdirSync(path.join(target, 'characters', 'yachiyo'), { recursive: true });
  const publicPackage = { name: 'yachiyo-desk', version: '1.0.7', license: 'MIT', scripts: { test: 'vitest run tests' },
    dependencies: { 'three-mesh-bvh': '0.9.15' }, build: { extraResources: [{ from: 'characters', to: 'characters', filter: ['**/*', '!**/*.vrm'] }] } };
  const localPackage = { name: 'yachiyo-desk', version: '1.0.4', license: 'UNLICENSED', author: 'Local private build',
    build: { copyright: 'Private local build' } };
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(publicPackage));
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(localPackage));
  fs.writeFileSync(path.join(source, 'src', 'feature.ts'), 'export const feature = 7;\n');
  fs.mkdirSync(path.join(source, 'docs'));
  fs.writeFileSync(path.join(source, 'docs', 'LOCAL_USAGE.md'), '# Current desktop usage\n');
  fs.writeFileSync(path.join(source, 'docs', 'ARCHITECTURE.md'), '[Maintenance](MAINTENANCE.md)\n[External](https://example.com)\n');
  fs.writeFileSync(path.join(target, 'characters', 'yachiyo', 'model.vrm'), 'private model');
  return { source, target };
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
describe('shared desktop and public source synchronization', () => {
  it('detects missing or different core files and becomes clean after applying', () => {
    const { source, target } = fixture();
    expect(planSync(source, target).differences.map((entry: { file: string }) => entry.file)).toContain(path.join('src', 'feature.ts'));
    applySync(planSync(source, target));
    expect(planSync(source, target).differences).toHaveLength(0);
    fs.writeFileSync(path.join(target, 'src', 'feature.ts'), 'regressed');
    expect(planSync(source, target).differences).toHaveLength(1);
  });
  it('synchronizes versions and dependencies while retaining private assets and metadata', () => {
    const { source, target } = fixture(); applySync(planSync(source, target));
    const metadata = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    expect(metadata).toMatchObject({ version: '1.0.7', license: 'UNLICENSED', author: 'Local private build',
      dependencies: { 'three-mesh-bvh': '0.9.15' }, build: { copyright: 'Private local build' } });
    expect(metadata.build.extraResources[0].filter).toEqual(['**/*']);
    expect(fs.readFileSync(path.join(target, 'characters', 'yachiyo', 'model.vrm'), 'utf8')).toBe('private model');
    expect(fs.existsSync(path.join(source, 'characters'))).toBe(false);
    expect(fs.readFileSync(path.join(target, 'docs', 'LOCAL_USAGE.md'), 'utf8')).toBe('# Current desktop usage\n');
    expect(fs.readFileSync(path.join(target, 'README_使用说明.md'), 'utf8')).toBe('# Current desktop usage\n');
    expect(fs.readFileSync(path.join(target, '项目原理与实现详解.md'), 'utf8')).toBe('[Maintenance](docs/MAINTENANCE.md)\n[External](https://example.com)\n');
    fs.writeFileSync(path.join(target, 'README_使用说明.md'), 'old instructions');
    expect(planSync(source, target).differences.map((entry: { file: string }) => entry.file)).toContain('README_使用说明.md');
  });
  it('rejects an arbitrary target or the source itself', () => {
    const { source, target } = fixture();
    expect(() => planSync(source, source)).toThrow('sibling');
    const other = path.join(path.dirname(target), 'Other'); fs.mkdirSync(other);
    expect(() => planSync(source, other)).toThrow('sibling');
  });
});
