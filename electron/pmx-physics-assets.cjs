'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hashFileSha256 } = require('./recommended-model.cjs');
const { validatePmxSource } = require('./pmx-converter.cjs');

function preservePmxPhysics(source, directory, expectedDigest) {
  validatePmxSource(source);
  const destination = path.join(directory, 'physics.pmx');
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (hashFileSha256(destination) !== expectedDigest.toLowerCase()) {
    fs.unlinkSync(destination);
    throw new Error('源 PMX 在导入期间发生变化，请重新导入。');
  }
  return destination;
}

/** Upgrade only when the original source is proven by the saved fingerprint. */
function resolvePmxPhysicsAsset(directory, manifest) {
  const profile = manifest.motionProfile;
  if (profile?.profileId !== 'generic-vrm' || !profile.capabilities?.includes('pmx-converted')) return {};
  const filename = path.join(directory, 'physics.pmx');
  const digest = /^[a-f\d]{64}$/i.test(manifest.sourceSha256 ?? '') ? manifest.sourceSha256.toLowerCase() : null;
  try {
    if (!fs.existsSync(filename) && digest) {
      const reportPath = path.join(directory, 'conversion-report.json');
      if (fs.existsSync(reportPath)) {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        if (report.result === 'PASS' && typeof report.input === 'string' && path.isAbsolute(report.input)
          && fs.existsSync(report.input) && hashFileSha256(report.input) === digest) {
          preservePmxPhysics(report.input, directory, digest);
        }
      }
    }
    if (!fs.existsSync(filename)) return { error: '重新导入原始 PMX，可启用模型原有的衣物与头发物理。' };
    validatePmxSource(filename);
    if (digest && hashFileSha256(filename) !== digest) return { error: '角色的 PMX 物理文件与导入记录不一致，请重新导入原始 PMX。' };
    return { filename };
  } catch (error) {
    return { error: `原始 PMX 物理文件无法读取：${error.message}` };
  }
}
module.exports = { preservePmxPhysics, resolvePmxPhysicsAsset };
