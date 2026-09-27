'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { PMX_CONVERTED_MOTION_PROFILE } = require('./motion-profile.cjs');

// Fingerprints of the author's unmodified downloads. A title or filename is
// not sufficient: many unrelated PMX/VRM assets use the same character name.
// No model bytes are stored in this repository.
const YACHIYO_AUTHOR_VRM_SHA256 = '18e2e24d159d62f90984d130775d484996f107fe0447fa6e9de2324840675ec6';
const YACHIYO_AUTHOR_PMX_SHA256 = '5be795078cbb2e83630df26943660e1adf391f92db0f247ac23a68666f971b0a';

function hashFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(handle, chunk, 0, chunk.length, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function matchRecommendedYachiyo(format, digest) {
  const normalized = typeof digest === 'string' ? digest.toLowerCase() : '';
  if (format === 'vrm' && normalized === YACHIYO_AUTHOR_VRM_SHA256) return 'author-vrm';
  if (format === 'pmx' && normalized === YACHIYO_AUTHOR_PMX_SHA256) return 'author-pmx';
  return null;
}

function buildRecommendedYachiyoProfile(authorProfile, kind) {
  if (kind === 'author-vrm') {
    return { ...authorProfile, profileId: 'yachiyo-author-vrm-v1' };
  }
  if (kind === 'author-pmx') {
    // Keep MMD local-axis compensation even when sharing Yachiyo's walk and
    // garment tuning. The original VRM and converted PMX do not have the same
    // wrist/knee basis; copying the built-in profile verbatim reverses palms.
    return {
      ...authorProfile,
      profileId: 'yachiyo-author-pmx-v1',
      capabilities: ['long-garment', 'pmx-converted'],
      handPose: { ...authorProfile.handPose, ...PMX_CONVERTED_MOTION_PROFILE.handPose },
      legPose: { ...authorProfile.legPose, ...PMX_CONVERTED_MOTION_PROFILE.legPose },
    };
  }
  throw new Error(`Unsupported recommended model kind: ${kind}`);
}

function verifiedRecommendedImport(manifest, modelPath) {
  if (!manifest || !matchRecommendedYachiyo(manifest.sourceFormat, manifest.sourceSha256)) return false;
  if (typeof manifest.modelSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.modelSha256)) return false;
  if (manifest.sourceFormat === 'vrm'
    && manifest.modelSha256.toLowerCase() !== YACHIYO_AUTHOR_VRM_SHA256) return false;
  try {
    return hashFileSha256(modelPath) === manifest.modelSha256.toLowerCase();
  } catch {
    return false;
  }
}

module.exports = {
  YACHIYO_AUTHOR_VRM_SHA256,
  YACHIYO_AUTHOR_PMX_SHA256,
  hashFileSha256,
  matchRecommendedYachiyo,
  buildRecommendedYachiyoProfile,
  verifiedRecommendedImport,
};
