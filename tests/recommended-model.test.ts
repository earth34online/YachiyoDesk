import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const models = require('../electron/recommended-model.cjs') as {
  YACHIYO_AUTHOR_VRM_SHA256: string;
  YACHIYO_AUTHOR_PMX_SHA256: string;
  hashFileSha256: (file: string) => string;
  matchRecommendedYachiyo: (format: string, hash: string) => string | null;
  buildRecommendedYachiyoProfile: (base: Record<string, any>, kind: string) => Record<string, any>;
  verifiedRecommendedImport: (manifest: Record<string, unknown>, modelPath: string) => boolean;
};

describe('recommended Yachiyo recognition', () => {
  it('matches only exact author-file hashes and keeps unrelated assets generic', () => {
    expect(models.matchRecommendedYachiyo('vrm', models.YACHIYO_AUTHOR_VRM_SHA256)).toBe('author-vrm');
    expect(models.matchRecommendedYachiyo('pmx', models.YACHIYO_AUTHOR_PMX_SHA256)).toBe('author-pmx');
    expect(models.matchRecommendedYachiyo('pmx', models.YACHIYO_AUTHOR_VRM_SHA256)).toBeNull();
    expect(models.matchRecommendedYachiyo('vrm', '0'.repeat(64))).toBeNull();
  });

  it('keeps PMX hand/leg basis while applying dedicated garment tuning', () => {
    const base = {
      walk: { cadence: 4.15 },
      capabilities: ['long-garment'],
      handPose: { palmFacingSign: 1 },
      legPose: { kneeBendSign: -1 },
      springBone: { enabled: true },
    };
    const vrm = models.buildRecommendedYachiyoProfile(base, 'author-vrm');
    const pmx = models.buildRecommendedYachiyoProfile(base, 'author-pmx');
    expect(vrm.handPose.palmFacingSign).toBe(1);
    expect(pmx.handPose.palmFacingSign).toBe(-1);
    expect(pmx.legPose.kneeBendSign).toBe(1);
    expect(pmx.capabilities).toEqual(['long-garment', 'pmx-converted']);
    expect(pmx.walk.cadence).toBe(4.15);
  });

  it('rejects an altered installed VRM even if its manifest claims a recommended source', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-recognized-'));
    try {
      const file = path.join(directory, 'model.vrm');
      fs.writeFileSync(file, 'model bytes');
      const digest = models.hashFileSha256(file);
      const manifest = {
        sourceFormat: 'pmx',
        sourceSha256: models.YACHIYO_AUTHOR_PMX_SHA256,
        modelSha256: digest,
      };
      expect(models.verifiedRecommendedImport(manifest, file)).toBe(true);
      fs.writeFileSync(file, 'different bytes');
      expect(models.verifiedRecommendedImport(manifest, file)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
