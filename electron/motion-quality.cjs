'use strict';

function validateAnatomy(motion, anatomy, idle) {
  if (!anatomy?.calibrated || !Number.isFinite(anatomy.legLength)) throw new Error('通用 PMX 动作测试没有启用骨架几何校准。');
  const tolerance = Math.max(.002, anatomy.legLength * .006);
  for (const side of ['left', 'right']) {
    if (motion === 'crouch') {
      if (!(anatomy[`${side}KneeForward`] > anatomy.legLength * .05)
        || !(anatomy[`${side}FootSupportError`] < tolerance)
        || !(anatomy[`${side}ToeSupportError`] < tolerance)) {
        throw new Error(`蹲姿没有满足朝前弯膝和脚底支撑：${side} ${JSON.stringify(anatomy)}`);
      }
    } else if (motion === 'tiptoe') {
      if (!(anatomy[`${side}ToeSupportError`] < tolerance)
        || !(anatomy[`${side}ToeRise`] < idle[`${side}ToeRise`] - anatomy.legLength * .02)) {
        throw new Error(`踮脚没有保持脚尖支点或脚踝方向错误：${side} ${JSON.stringify(anatomy)}`);
      }
    }
  }
  if (motion === 'think' && !(anatomy.rightElbowFlexion <= 145 * Math.PI / 180)) {
    throw new Error(`思考动作肘部屈曲超过限制：${JSON.stringify(anatomy)}`);
  }
}

function validateFingerFlexion(samples) {
  if (!Array.isArray(samples) || samples.length !== 3) throw new Error('缺少通用 PMX 手指屈曲诊断。');
  const chains = Object.keys(samples[0].fingerFlexion || {});
  // Optional finger chains may be absent; report coverage, never invent them.
  for (const chain of chains) {
    const angles = samples.map(sample => sample.fingerFlexion?.[chain]);
    if (angles.some(angle => !Number.isFinite(angle)) || angles[1] - angles[0] < .4 || angles[2] - angles[1] < .15) {
      throw new Error(`手指仍未发生真实屈曲：${chain} ${JSON.stringify(angles)}`);
    }
  }
  return { chains, missingOptionalChains: 8 - chains.length };
}

function garmentSurfaceIssues(label, state) {
  if (!state || !('garmentMeshes' in state)) return [{ label, reason: 'garment-contact-unavailable', state }];
  const issues = [];
  if (!state.enabled || state.coolingMeshes > 0) issues.push({ label, reason: 'garment-contact-incomplete-coverage', state });
  if (!state.surfaceCheckComplete) issues.push({ label, reason: 'surface-verification-incomplete', state });
  if (!state.shapeCheckComplete || !state.shapePreservationPassed) issues.push({ label, reason: 'garment-shape-verification-failed',
    maximumStretchExcess: state.maximumStretchExcess, maximumAttachmentOffset: state.maximumAttachmentOffset,
    collapsedFaces: state.collapsedFaces, complete: state.shapeCheckComplete });
  // The user accepts extremely small contact. Counts alone do not measure its
  // size: accept only a complete check with finite, conservative size bounds.
  const tinyContact = Number.isFinite(state.maximumResidualDepthBound) && state.maximumResidualDepthBound <= .0005
    && Number.isFinite(state.maximumResidualSpan) && state.maximumResidualSpan <= .005;
  if (state.unresolvedIntersections > 0 && !tinyContact) issues.push({ label, reason: 'unresolved-surface-intersections', pairs: state.unresolvedIntersections,
    pinnedPairs: state.pinnedIntersections, reducedMeshes: state.reducedMeshes,
    maximumResidualDepthBound: state.maximumResidualDepthBound, maximumResidualSpan: state.maximumResidualSpan });
  return issues;
}
module.exports = { validateAnatomy, validateFingerFlexion, garmentSurfaceIssues };
