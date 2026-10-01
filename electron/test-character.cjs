'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PMX_CONVERTED_MOTION_PROFILE } = require('./motion-profile.cjs');

/** Keep the production import contract when placing a fixture in an isolated test library. */
function readTestCharacterMetadata(modelPath, environment = process.env) {
  const explicit = environment.YACHIYO_DESK_TEST_MANIFEST;
  const adjacent = path.join(path.dirname(modelPath), 'character.json');
  const manifestPath = explicit || (fs.existsSync(adjacent) ? adjacent : null);
  const manifest = manifestPath ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('测试角色 manifest 必须为 JSON 对象。');
  const format = environment.YACHIYO_DESK_TEST_FORMAT || manifest.sourceFormat || 'vrm';
  if (!['vrm', 'pmx'].includes(format)) throw new Error('YACHIYO_DESK_TEST_FORMAT 必须是 vrm 或 pmx。');
  if (environment.YACHIYO_DESK_TEST_FORMAT && manifest.sourceFormat && format !== manifest.sourceFormat) {
    throw new Error('测试格式与角色 manifest 的 sourceFormat 不一致。');
  }
  const profile = manifest.motionProfile || (format === 'pmx' ? PMX_CONVERTED_MOTION_PROFILE : undefined);
  if (format === 'pmx' && (!Array.isArray(profile?.capabilities) || !profile.capabilities.includes('pmx-converted'))) {
    throw new Error('PMX 测试角色必须保留 pmx-converted capability。');
  }
  return { sourceFormat: format, motionProfile: profile, sourceSha256: manifest.sourceSha256,
    behavior: manifest.behavior, fixtureManifest: manifestPath };
}
module.exports = { readTestCharacterMetadata };
