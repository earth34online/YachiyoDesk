import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
const { readTestCharacterMetadata } = createRequire(import.meta.url)('../electron/test-character.cjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function model(manifest?: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-fixture-')); dirs.push(dir);
  if (manifest) fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify(manifest));
  return path.join(dir, 'model.vrm');
}
describe('motion fixture metadata', () => {
  it('retains the adjacent imported PMX profile and its tuning', () => {
    const motionProfile = { capabilities: ['pmx-converted'], handPose: { armAxisSign: -1 } };
    expect(readTestCharacterMetadata(model({ sourceFormat: 'pmx', motionProfile }), {})).toMatchObject({ sourceFormat: 'pmx', motionProfile });
  });
  it('supports an explicit PMX format when only the converted file is available', () => {
    expect(readTestCharacterMetadata(model(), { YACHIYO_DESK_TEST_FORMAT: 'pmx' })).toMatchObject({ sourceFormat: 'pmx', motionProfile: { capabilities: ['pmx-converted'], handPose: { armAxisSign: -1 } } });
  });
  it('rejects a PMX manifest with a lost capability and conflicting format claims', () => {
    const file = model({ sourceFormat: 'pmx', motionProfile: { capabilities: [] } });
    expect(() => readTestCharacterMetadata(file, {})).toThrow('pmx-converted');
    expect(() => readTestCharacterMetadata(file, { YACHIYO_DESK_TEST_FORMAT: 'vrm' })).toThrow('不一致');
  });
  it('keeps an ordinary standalone VRM in the native path', () => {
    expect(readTestCharacterMetadata(model(), {})).toMatchObject({ sourceFormat: 'vrm', motionProfile: undefined });
  });
});
